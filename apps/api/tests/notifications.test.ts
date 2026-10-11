import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculateRetryDelayMs,
  queueOpenNotifications,
  queueRecoveryNotification,
  runNotificationTick,
} from "../src/notifications";
import { runScheduleTick } from "../src/scheduler";

const minute = 60_000;
const now = Date.UTC(2025, 0, 1, 0, 0, 0);
const webhook = "https://discord.com/api/webhooks/123456789012345678/test-webhook-token";

interface DeliveryState {
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  claimed_at: number | null;
  last_error: string | null;
  sent_at: number | null;
  notification_type: string;
}

async function seedAlert(message = "Backup did not finish"): Promise<{ alertId: string; jobId: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const hostId = `notify-host-${suffix}`;
  const jobId = `notify-job-${suffix}`;
  const alertId = `notify-alert-${suffix}`;
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(hostId, hostId, "Notify Host", now)
    .run();
  await env.DB.prepare(
    `INSERT INTO jobs (
       id, host_id, job_key, name, schedule, timezone, grace_seconds,
       timeout_seconds, created_at
     ) VALUES (?, ?, ?, ?, '* * * * *', 'UTC', 0, 3600, ?)`,
  )
    .bind(jobId, hostId, jobId, "Nightly Backup", now)
    .run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO alerts (
         id, dedupe_key, rule_key, severity, status, host_id, job_id, message,
         opened_at, created_at
       ) VALUES (?, ?, 'run_timeout', 'critical', 'open', ?, ?, ?, ?, ?)`,
    ).bind(alertId, `run_timeout:${alertId}`, hostId, jobId, message, now, now),
    queueOpenNotifications(env.DB, jobId, now),
  ]);
  return { alertId, jobId };
}

async function readDelivery(alertId: string, type = "open"): Promise<DeliveryState | null> {
  return env.DB.prepare(
    `SELECT id, status, attempts, next_attempt_at, claimed_at, last_error,
            sent_at, notification_type
     FROM notification_deliveries
     WHERE alert_id = ? AND channel_key = 'discord' AND notification_type = ?`,
  )
    .bind(alertId, type)
    .first<DeliveryState>();
}

afterEach(async () => {
  const generatedHosts = `
    SELECT id FROM hosts
    WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%'
  `;
  await env.DB.prepare(`DELETE FROM alerts WHERE host_id IN (${generatedHosts})`).run();
  await env.DB.prepare(`DELETE FROM runs WHERE job_id IN (
    SELECT id FROM jobs WHERE host_id IN (${generatedHosts})
  )`).run();
  await env.DB.prepare(`DELETE FROM jobs WHERE host_id IN (${generatedHosts})`).run();
  await env.DB.prepare(`DELETE FROM hosts WHERE id IN (${generatedHosts})`).run();
});

describe("persistent Discord notification outbox", () => {
  it("sends a confirmed webhook message and records delivery separately from the alert", async () => {
    const { alertId } = await seedAlert();
    let sentUrl = "";
    let sentBody: unknown;

    await runNotificationTick(env.DB, webhook, now, {
      fetch: async (input, init) => {
        sentUrl = String(input);
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      },
    });

    expect(new URL(sentUrl).searchParams.get("wait")).toBe("true");
    expect(sentBody).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(JSON.stringify(sentBody)).toContain("Notify Host");
    expect(await readDelivery(alertId)).toMatchObject({
      status: "sent",
      attempts: 1,
      claimed_at: null,
      sent_at: now,
      last_error: null,
    });
  });

  it("honors Discord Retry-After and retries from the stored state in a later invocation", async () => {
    const { alertId } = await seedAlert();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ retry_after: 99 }), {
            status: 429,
            headers: { "Retry-After": "2" },
          })
        : new Response(null, { status: 204 });
    };

    await runNotificationTick(env.DB, webhook, now, { fetch });
    expect(await readDelivery(alertId)).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: now + 2_000,
      last_error: "http_429",
    });

    // A new drain call acts like a later Cron invocation after Worker restart.
    await runNotificationTick(env.DB, webhook, now + 2_000, { fetch });
    expect(calls).toBe(2);
    expect(await readDelivery(alertId)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("uses the retry_after JSON field when Discord omits the Retry-After header", async () => {
    const { alertId } = await seedAlert();
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => new Response(JSON.stringify({ retry_after: 3.5 }), { status: 429 }),
    });
    expect(await readDelivery(alertId)).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: now + 3_500,
    });
  });

  it("retries 5xx and network timeout failures with bounded exponential backoff", async () => {
    const first = await seedAlert();
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => new Response("unavailable", { status: 503 }),
      random: () => 0.5,
    });
    expect(await readDelivery(first.alertId)).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: now + 60_000,
      last_error: "http_503",
    });

    const second = await seedAlert();
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => {
        throw new DOMException("request timed out", "TimeoutError");
      },
      random: () => 0.5,
    });
    expect(await readDelivery(second.alertId)).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: now + 60_000,
      last_error: "network_or_timeout_error",
    });
    expect(calculateRetryDelayMs(20, 1)).toBe(6 * 60 * 60_000);
  });

  it("continues draining other deliveries after one provider failure", async () => {
    const first = await seedAlert();
    const second = await seedAlert();
    let calls = 0;
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(null, { status: 204 });
      },
      random: () => 0.5,
    });

    const states = await env.DB.prepare(
      `SELECT status FROM notification_deliveries
       WHERE alert_id IN (?, ?) ORDER BY status`,
    )
      .bind(first.alertId, second.alertId)
      .all<{ status: string }>();
    expect(calls).toBe(2);
    expect(states.results.map(({ status }) => status).sort()).toEqual(["pending", "sent"]);
  });

  it("stops retrying after the configured attempt limit", async () => {
    const { alertId } = await seedAlert();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) {
        await env.DB.prepare(
          "UPDATE notification_deliveries SET next_attempt_at = ? WHERE alert_id = ? AND status = 'pending'",
        )
          .bind(now, alertId)
          .run();
      }
      await runNotificationTick(env.DB, webhook, now, { fetch, random: () => 0.5 });
    }
    await runNotificationTick(env.DB, webhook, now + 365 * 24 * 60 * minute, { fetch });

    expect(calls).toBe(8);
    expect(await readDelivery(alertId)).toMatchObject({ status: "dead", attempts: 8 });
  });

  it("does not claim a delivery twice during overlapping Cron invocations", async () => {
    const { alertId } = await seedAlert();
    let callCount = 0;
    let observedSignal: unknown = null;
    let finishFetch!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const delayedFetch = new Promise<Response>((resolve) => {
      finishFetch = resolve;
    });
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      observedSignal = init?.signal;
      markFetchStarted();
      return delayedFetch;
    };

    const firstTick = runNotificationTick(env.DB, webhook, now, { fetch });
    await fetchStarted;
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => {
        callCount += 1;
        return new Response(null, { status: 204 });
      },
    });
    finishFetch(new Response(null, { status: 204 }));
    await firstTick;

    expect(callCount).toBe(1);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal).toMatchObject({ aborted: false });
    expect(await readDelivery(alertId)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("reclaims an expired sending lease after a Worker restart", async () => {
    const { alertId } = await seedAlert();
    await env.DB.prepare(
      `UPDATE notification_deliveries
       SET status = 'sending', attempts = 1, claimed_at = ?, updated_at = ?
       WHERE alert_id = ? AND notification_type = 'open'`,
    )
      .bind(now - 2 * minute, now - 2 * minute, alertId)
      .run();

    let calls = 0;
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
    });

    expect(calls).toBe(1);
    expect(await readDelivery(alertId)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("retains pending messages when the webhook secret is not configured", async () => {
    const { alertId } = await seedAlert();
    let calls = 0;
    await runNotificationTick(env.DB, undefined, now, {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
    });

    expect(calls).toBe(0);
    expect(await readDelivery(alertId)).toMatchObject({ status: "pending", attempts: 0 });

    await runNotificationTick(
      env.DB,
      "https://attacker.example/api/webhooks/123456789012345678/secret",
      now,
      {
        fetch: async () => {
          calls += 1;
          return new Response(null, { status: 204 });
        },
      },
    );
    expect(calls).toBe(0);
    expect(await readDelivery(alertId)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("marks permanent 4xx responses dead and prevents retries", async () => {
    const { alertId } = await seedAlert("permanent-test-alert");
    let targetCalls = 0;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { content: string };
      if (body.content.includes("permanent-test-alert")) targetCalls += 1;
      return new Response("bad request", { status: 400 });
    };

    await runNotificationTick(env.DB, webhook, now, { fetch });
    await runNotificationTick(env.DB, webhook, now + 30 * minute, { fetch });
    expect(targetCalls).toBe(1);
    expect(await readDelivery(alertId)).toMatchObject({
      status: "dead",
      attempts: 1,
      claimed_at: null,
      last_error: "http_400",
    });
  });

  it("creates one recovery notification when a missed schedule alert resolves", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const hostId = `recovery-host-${suffix}`;
    const jobId = `recovery-job-${suffix}`;
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(hostId, hostId, "Recovery Host", now)
      .run();
    await env.DB.prepare(
      `INSERT INTO jobs (
         id, host_id, job_key, name, schedule, timezone, grace_seconds,
         timeout_seconds, created_at
       ) VALUES (?, ?, ?, ?, '* * * * *', 'UTC', 0, 3600, ?)`,
    )
      .bind(jobId, hostId, jobId, "Recovery Job", now)
      .run();

    await runScheduleTick(env.DB, now);
    await runScheduleTick(env.DB, now + 2 * minute);
    const missed = await env.DB.prepare(
      `SELECT id, occurrence_scheduled_for FROM alerts
       WHERE job_id = ? AND rule_key = 'missed_schedule' AND status = 'open'
       ORDER BY occurrence_scheduled_for ASC LIMIT 1`,
    )
      .bind(jobId)
      .first<{ id: string; occurrence_scheduled_for: number }>();
    expect(missed).not.toBeNull();
    await env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, operation, status, client_name, client_version,
         started_at, finished_at, duration_ms, created_at, updated_at
       ) VALUES (?, ?, 'backup', 'success', 'test', '1', ?, ?, 1000, ?, ?)`,
    )
      .bind(
        `late-${suffix}`,
        jobId,
        (missed?.occurrence_scheduled_for ?? now) + 30_000,
        (missed?.occurrence_scheduled_for ?? now) + 31_000,
        now,
        now,
      )
      .run();

    const recoveredAt = now + 4 * minute;
    await runScheduleTick(env.DB, recoveredAt);
    const recoveryCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM notification_deliveries
       WHERE alert_id = ? AND notification_type = 'recovery'`,
    )
      .bind(missed?.id)
      .first<{ count: number }>();
    expect(recoveryCount?.count).toBe(1);

    await env.DB.batch([
      queueRecoveryNotification(
        env.DB,
        `missed_schedule:${jobId}:${missed?.occurrence_scheduled_for}`,
        recoveredAt,
      ),
      queueRecoveryNotification(
        env.DB,
        `missed_schedule:${jobId}:${missed?.occurrence_scheduled_for}`,
        recoveredAt,
      ),
    ]);
    const afterDuplicateResolution = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM notification_deliveries
       WHERE alert_id = ? AND notification_type = 'recovery'`,
    )
      .bind(missed?.id)
      .first<{ count: number }>();
    expect(afterDuplicateResolution?.count).toBe(1);

    await env.DB.prepare(
      `UPDATE notification_deliveries SET status = 'sent', sent_at = ?, updated_at = ?
       WHERE channel_key = 'discord' AND notification_type = 'open'
         AND alert_id IN (SELECT id FROM alerts WHERE job_id = ?)`,
    )
      .bind(recoveredAt, recoveredAt, jobId)
      .run();

    let sentRecovery = false;
    await runNotificationTick(env.DB, webhook, recoveredAt, {
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { content: string };
        if (body.content.includes("Backup alert recovered")) sentRecovery = true;
        return new Response(null, { status: 204 });
      },
    });
    expect(sentRecovery).toBe(true);
  });
});
