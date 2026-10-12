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
  status: string;
  attempts: number;
  next_attempt_at: number;
  claimed_at: number | null;
  last_error: string | null;
  sent_at: number | null;
  notification_type: string;
}

async function seedAlert(
  message = "Backup did not finish",
  discordEnabled = true,
): Promise<{ hostId: string; jobId: string; alertId: string }> {
  const hostId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const alertId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(hostId, `notify-host-${hostId.slice(0, 8)}`, "Notify Host", now, now).run();
  await env.DB.prepare(
    `INSERT INTO jobs (
       id, host_id, slug, name, operation, max_runtime_seconds, discord_enabled, created_at, updated_at
     ) VALUES (?, ?, ?, 'Nightly Backup', 'backup', 3600, ?, ?, ?)`,
  ).bind(jobId, hostId, `notify-${jobId.slice(0, 8)}`, discordEnabled ? 1 : 0, now, now).run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO alerts (
         id, dedupe_key, rule_key, severity, status, host_id, job_id, message, opened_at, created_at
       ) VALUES (?, ?, 'run_timeout', 'critical', 'open', ?, ?, ?, ?, ?)`,
    ).bind(alertId, `run_timeout:${alertId}`, hostId, jobId, message, now, now),
    queueOpenNotifications(env.DB, jobId, now),
  ]);
  return { hostId, jobId, alertId };
}

async function readDelivery(alertId: string, type = "open"): Promise<DeliveryState | null> {
  return env.DB.prepare(
    `SELECT status, attempts, next_attempt_at, claimed_at, last_error, sent_at, notification_type
     FROM notification_deliveries WHERE alert_id = ? AND channel_key = 'discord' AND notification_type = ?`,
  ).bind(alertId, type).first<DeliveryState>();
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM alerts WHERE host_id IN (SELECT id FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%')").run();
  await env.DB.prepare("DELETE FROM runs WHERE job_id IN (SELECT id FROM jobs WHERE host_id IN (SELECT id FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%'))").run();
  await env.DB.prepare("DELETE FROM schedule_occurrences WHERE schedule_rule_id IN (SELECT s.id FROM job_schedule_rules AS s INNER JOIN jobs AS j ON j.id = s.job_id INNER JOIN hosts AS h ON h.id = j.host_id WHERE h.name LIKE 'notify-host-%' OR h.name LIKE 'recovery-host-%')").run();
  await env.DB.prepare("DELETE FROM jobs WHERE host_id IN (SELECT id FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%')").run();
  await env.DB.prepare("DELETE FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%'").run();
});

describe("per-Job Discord notification outbox", () => {
  it("sends a confirmed webhook and records delivery separately from the alert", async () => {
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
    expect(await readDelivery(alertId)).toMatchObject({ status: "sent", attempts: 1, sent_at: now, last_error: null });
  });

  it("honors Retry-After and retries stored state on a later invocation", async () => {
    const { alertId } = await seedAlert();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ retry_after: 99 }), { status: 429, headers: { "Retry-After": "2" } })
        : new Response(null, { status: 204 });
    };
    await runNotificationTick(env.DB, webhook, now, { fetch });
    expect(await readDelivery(alertId)).toMatchObject({ status: "pending", attempts: 1, next_attempt_at: now + 2_000 });
    await runNotificationTick(env.DB, webhook, now + 2_000, { fetch });
    expect(calls).toBe(2);
    expect(await readDelivery(alertId)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("uses bounded exponential backoff for server and network failures", async () => {
    const { alertId } = await seedAlert();
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => new Response("unavailable", { status: 503 }),
      random: () => 0.5,
    });
    expect(await readDelivery(alertId)).toMatchObject({ status: "pending", attempts: 1, next_attempt_at: now + minute, last_error: "http_503" });
    expect(calculateRetryDelayMs(20, 1)).toBe(6 * 60 * 60_000);
  });

  it("does not enqueue alerts for Jobs with Discord disabled", async () => {
    const { alertId } = await seedAlert("quiet alert", false);
    expect(await readDelivery(alertId)).toBeNull();
    let calls = 0;
    await runNotificationTick(env.DB, webhook, now, {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
    });
    expect(calls).toBe(0);
  });

  it("keeps notifications pending until a valid webhook is configured", async () => {
    const { alertId } = await seedAlert();
    await runNotificationTick(env.DB, undefined, now, { fetch: async () => new Response(null, { status: 204 }) });
    expect(await readDelivery(alertId)).toMatchObject({ status: "pending", attempts: 0 });
    await runNotificationTick(env.DB, "https://attacker.example/not-a-webhook", now, {
      fetch: async () => new Response(null, { status: 204 }),
    });
    expect(await readDelivery(alertId)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("creates one recovery delivery when a missed schedule is matched by a late run", async () => {
    const hostId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const ruleId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(hostId, `recovery-host-${hostId.slice(0, 8)}`, "Recovery Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO jobs (
         id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at
       ) VALUES (?, ?, ?, 'Recovery Job', 'backup', 3600, ?, ?)`,
    ).bind(jobId, hostId, `recovery-${jobId.slice(0, 8)}`, now, now).run();
    await env.DB.prepare(
      `INSERT INTO job_schedule_rules (
         id, job_id, schedule_type, expression, timezone, start_grace_seconds, created_at, updated_at
       ) VALUES (?, ?, 'cron', '* * * * *', 'UTC', 0, ?, ?)`,
    ).bind(ruleId, jobId, now, now).run();

    await runScheduleTick(env.DB, now);
    await runScheduleTick(env.DB, now + 2 * minute + 1_000);
    const missed = await env.DB.prepare(
      `SELECT id, occurrence_scheduled_for FROM alerts
       WHERE job_id = ? AND rule_key = 'missed_schedule' AND status = 'open'
       ORDER BY occurrence_scheduled_for DESC LIMIT 1`,
    ).bind(jobId).first<{ id: string; occurrence_scheduled_for: number }>();
    expect(missed).not.toBeNull();

    const runId = crypto.randomUUID();
    const startedAt = missed!.occurrence_scheduled_for + 30_000;
    await env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, operation, status, started_at, start_ping_received,
         finished_at, duration_ms, created_at, updated_at
       ) VALUES (?, ?, 'backup', 'success', ?, 1, ?, 1000, ?, ?)`,
    ).bind(runId, jobId, startedAt, startedAt + 1000, now, now).run();

    const resolvedAt = now + 3 * minute;
    await runScheduleTick(env.DB, resolvedAt);
    const resolved = await env.DB.prepare("SELECT status FROM alerts WHERE id = ?")
      .bind(missed!.id).first<{ status: string }>();
    expect(resolved?.status).toBe("resolved");
    expect(await readDelivery(missed!.id, "recovery")).toMatchObject({ status: "pending", attempts: 0 });
    await env.DB.batch([
      queueRecoveryNotification(env.DB, `missed_schedule:${jobId}:${missed!.occurrence_scheduled_for}`, resolvedAt),
      queueRecoveryNotification(env.DB, `missed_schedule:${jobId}:${missed!.occurrence_scheduled_for}`, resolvedAt),
    ]);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM notification_deliveries WHERE alert_id = ? AND notification_type = 'recovery'",
    ).bind(missed!.id).first()).toEqual({ count: 1 });
  });
});
