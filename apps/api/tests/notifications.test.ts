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
const telegramToken = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

interface DeliveryState {
  target_id: string;
  provider: string;
  target_name: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  claimed_at: number | null;
  last_error: string | null;
  sent_at: number | null;
  notification_type: string;
}

interface TargetFixture {
  id: string;
  provider: "discord" | "telegram";
  config: Record<string, string>;
}

async function createTarget(
  provider: TargetFixture["provider"] = "discord",
  config: Record<string, string> = { webhook_url: webhook },
  labelPrefix = "notify-target",
): Promise<TargetFixture> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO notification_targets (id, name, provider, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, `${labelPrefix}-${id.slice(0, 8)}`, provider, JSON.stringify(config), now, now).run();
  return { id, provider, config };
}

async function seedAlert(
  message = "Backup did not finish",
  targets: TargetFixture[] | null = null,
): Promise<{ hostId: string; jobId: string; alertId: string; targets: TargetFixture[] }> {
  const hostId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const alertId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(hostId, `notify-host-${hostId.slice(0, 8)}`, "Notify Host", now, now).run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at)
     VALUES (?, ?, ?, 'Nightly Backup', 'backup', 3600, ?, ?)`,
  ).bind(jobId, hostId, `notify-${jobId.slice(0, 8)}`, now, now).run();
  const selectedTargets = targets ?? [await createTarget()];
  for (const target of selectedTargets) {
    await env.DB.prepare(
      "INSERT INTO job_notification_targets (job_id, target_id, created_at) VALUES (?, ?, ?)",
    ).bind(jobId, target.id, now).run();
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO alerts (
         id, dedupe_key, rule_key, severity, status, host_id, job_id, message, opened_at, created_at
       ) VALUES (?, ?, 'run_timeout', 'critical', 'open', ?, ?, ?, ?, ?)`,
    ).bind(alertId, `run_timeout:${alertId}`, hostId, jobId, message, now, now),
    queueOpenNotifications(env.DB, jobId, now),
  ]);
  return { hostId, jobId, alertId, targets: selectedTargets };
}

async function readDelivery(alertId: string, type = "open", targetId?: string): Promise<DeliveryState | null> {
  return env.DB.prepare(
    `SELECT target_id, provider, target_name, status, attempts, next_attempt_at,
            claimed_at, last_error, sent_at, notification_type
     FROM notification_deliveries
     WHERE alert_id = ? AND notification_type = ? ${targetId === undefined ? "" : "AND target_id = ?"}
     ORDER BY target_id LIMIT 1`,
  ).bind(...(targetId === undefined ? [alertId, type] : [alertId, type, targetId])).first<DeliveryState>();
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM alerts WHERE host_id IN (SELECT id FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%')").run();
  await env.DB.prepare("DELETE FROM runs WHERE job_id IN (SELECT id FROM jobs WHERE host_id IN (SELECT id FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%'))").run();
  await env.DB.prepare("DELETE FROM schedule_occurrences WHERE schedule_rule_id IN (SELECT s.id FROM job_schedule_rules AS s INNER JOIN jobs AS j ON j.id = s.job_id INNER JOIN hosts AS h ON h.id = j.host_id WHERE h.name LIKE 'notify-host-%' OR h.name LIKE 'recovery-host-%')").run();
  await env.DB.prepare("DELETE FROM jobs WHERE host_id IN (SELECT id FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%')").run();
  await env.DB.prepare("DELETE FROM hosts WHERE name LIKE 'notify-host-%' OR name LIKE 'recovery-host-%'").run();
  await env.DB.prepare("DELETE FROM notification_targets WHERE name LIKE 'notify-target-%' OR name LIKE 'recovery-target-%'").run();
});

describe("notification target outbox", () => {
  it("sends a confirmed Discord webhook and records delivery separately from the alert", async () => {
    const { alertId, targets } = await seedAlert();
    let sentUrl = "";
    let sentBody: unknown;
    await runNotificationTick(env.DB, now, {
      fetch: async (input, init) => {
        sentUrl = String(input);
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      },
    });
    expect(new URL(sentUrl).searchParams.get("wait")).toBe("true");
    expect(sentBody).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(JSON.stringify(sentBody)).toContain("Notify Host");
    expect(await readDelivery(alertId, "open", targets[0].id)).toMatchObject({
      provider: "discord", status: "sent", attempts: 1, sent_at: now, last_error: null,
    });
  });

  it("honors Discord Retry-After and retries stored state on a later invocation", async () => {
    const { alertId, targets } = await seedAlert();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ retry_after: 99 }), { status: 429, headers: { "Retry-After": "2" } })
        : new Response(null, { status: 204 });
    };
    await runNotificationTick(env.DB, now, { fetch });
    expect(await readDelivery(alertId, "open", targets[0].id)).toMatchObject({
      status: "pending", attempts: 1, next_attempt_at: now + 2_000,
    });
    await runNotificationTick(env.DB, now + 2_000, { fetch });
    expect(calls).toBe(2);
    expect(await readDelivery(alertId, "open", targets[0].id)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("uses bounded exponential backoff for server failures", async () => {
    const { alertId, targets } = await seedAlert();
    await runNotificationTick(env.DB, now, {
      fetch: async () => new Response("unavailable", { status: 503 }),
      random: () => 0.5,
    });
    expect(await readDelivery(alertId, "open", targets[0].id)).toMatchObject({
      status: "pending", attempts: 1, next_attempt_at: now + minute, last_error: "http_503",
    });
    expect(calculateRetryDelayMs(20, 1)).toBe(6 * 60 * 60_000);
  });

  it("creates no delivery when a Job has no notification targets", async () => {
    const { alertId } = await seedAlert("quiet alert", []);
    expect(await readDelivery(alertId)).toBeNull();
    let calls = 0;
    await runNotificationTick(env.DB, now, {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
    });
    expect(calls).toBe(0);
  });

  it("leaves queued deliveries paused while their target is disabled, then resumes them", async () => {
    const { hostId, jobId, alertId, targets } = await seedAlert();
    const target = targets[0];
    await env.DB.prepare("UPDATE notification_targets SET enabled = 0 WHERE id = ?").bind(target.id).run();
    const disabledAlertId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO alerts (
           id, dedupe_key, rule_key, severity, status, host_id, job_id, message, opened_at, created_at
         ) VALUES (?, ?, 'missed_schedule', 'critical', 'open', ?, ?, 'Disabled target alert', ?, ?)`,
      ).bind(disabledAlertId, `missed_schedule:${disabledAlertId}`, hostId, jobId, now, now),
      queueOpenNotifications(env.DB, jobId, now),
    ]);
    expect(await readDelivery(disabledAlertId)).toBeNull();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };
    await runNotificationTick(env.DB, now, { fetch });
    expect(calls).toBe(0);
    expect(await readDelivery(alertId, "open", target.id)).toMatchObject({ status: "pending", attempts: 0 });
    await env.DB.prepare("UPDATE notification_targets SET enabled = 1 WHERE id = ?").bind(target.id).run();
    await runNotificationTick(env.DB, now, { fetch });
    expect(calls).toBe(1);
    expect(await readDelivery(alertId, "open", target.id)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("routes one Job to multiple Discord targets and deduplicates each recipient", async () => {
    const first = await createTarget("discord", { webhook_url: "https://discord.com/api/webhooks/111111111111111111/webhook-a" });
    const second = await createTarget("discord", { webhook_url: "https://discord.com/api/webhooks/222222222222222222/webhook-b" });
    const { alertId, jobId } = await seedAlert("two destinations", [first, second]);
    await env.DB.batch([queueOpenNotifications(env.DB, jobId, now), queueOpenNotifications(env.DB, jobId, now)]);
    const sentUrls: string[] = [];
    await runNotificationTick(env.DB, now, {
      fetch: async (input) => {
        sentUrls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });
    expect(sentUrls).toHaveLength(2);
    expect(sentUrls).toContain("https://discord.com/api/webhooks/111111111111111111/webhook-a?wait=true");
    expect(sentUrls).toContain("https://discord.com/api/webhooks/222222222222222222/webhook-b?wait=true");
    expect(await readDelivery(alertId, "open", first.id)).toMatchObject({ status: "sent" });
    expect(await readDelivery(alertId, "open", second.id)).toMatchObject({ status: "sent" });
  });

  it("sends Telegram text and applies Bot API retry_after without storing the bot token", async () => {
    const target = await createTarget("telegram", { bot_token: telegramToken, chat_id: "-10012345" });
    const { alertId } = await seedAlert("Telegram alert", [target]);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let calls = 0;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      calls += 1;
      return calls === 1
        ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 17 } }, { status: 429 })
        : Response.json({ ok: true, result: { message_id: 42 } });
    };
    await runNotificationTick(env.DB, now, { fetch });
    expect(requests[0].url).toBe(`https://api.telegram.org/bot${telegramToken}/sendMessage`);
    expect(requests[0].body).toMatchObject({ chat_id: "-10012345" });
    expect(String(requests[0].body.text)).toContain("Telegram alert");
    expect(await readDelivery(alertId, "open", target.id)).toMatchObject({
      status: "pending", attempts: 1, next_attempt_at: now + 17_000, last_error: "telegram_rate_limited",
    });
    await runNotificationTick(env.DB, now + 17_000, { fetch });
    expect(calls).toBe(2);
    expect(await readDelivery(alertId, "open", target.id)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("does not persist Telegram request URLs or tokens when a provider fetch throws", async () => {
    const target = await createTarget("telegram", { bot_token: telegramToken, chat_id: "@backup_alerts" });
    const { alertId } = await seedAlert("Network issue", [target]);
    await runNotificationTick(env.DB, now, {
      fetch: async () => { throw new Error(`fetch failed for ${telegramToken}`); },
      random: () => 0.5,
    });
    const delivery = await readDelivery(alertId, "open", target.id);
    expect(delivery).toMatchObject({ status: "pending", last_error: "network_or_timeout_error" });
    expect(delivery?.last_error).not.toContain(telegramToken);
  });

  it("sends recovery to the original active target and deduplicates the recovery", async () => {
    const hostId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const ruleId = crypto.randomUUID();
    const target = await createTarget("discord", { webhook_url: webhook }, "recovery-target");
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(hostId, `recovery-host-${hostId.slice(0, 8)}`, "Recovery Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO jobs (id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at)
       VALUES (?, ?, ?, 'Recovery Job', 'backup', 3600, ?, ?)`,
    ).bind(jobId, hostId, `recovery-${jobId.slice(0, 8)}`, now, now).run();
    await env.DB.prepare(
      "INSERT INTO job_notification_targets (job_id, target_id, created_at) VALUES (?, ?, ?)",
    ).bind(jobId, target.id, now).run();
    await env.DB.prepare(
      `INSERT INTO job_schedule_rules (
         id, job_id, schedule_type, expression, timezone, start_grace_seconds, created_at, updated_at
       ) VALUES (?, ?, 'cron', '* * * * *', 'UTC', 0, ?, ?)`,
    ).bind(ruleId, jobId, now, now).run();

    await runScheduleTick(env.DB, now);
    await runScheduleTick(env.DB, now + 2 * minute + 1_000);
    const missed = await env.DB.prepare(
      `SELECT id, occurrence_scheduled_for, dedupe_key FROM alerts
       WHERE job_id = ? AND rule_key = 'missed_schedule' AND status = 'open'
       ORDER BY occurrence_scheduled_for DESC LIMIT 1`,
    ).bind(jobId).first<{ id: string; occurrence_scheduled_for: number; dedupe_key: string }>();
    expect(missed).not.toBeNull();
    expect(await readDelivery(missed!.id, "open", target.id)).toMatchObject({ status: "pending" });

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
    expect(await readDelivery(missed!.id, "recovery", target.id)).toMatchObject({ status: "pending", attempts: 0 });
    await env.DB.batch([
      queueRecoveryNotification(env.DB, missed!.dedupe_key, resolvedAt),
      queueRecoveryNotification(env.DB, missed!.dedupe_key, resolvedAt),
    ]);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM notification_deliveries WHERE alert_id = ? AND notification_type = 'recovery'",
    ).bind(missed!.id).first()).toEqual({ count: 1 });

    await env.DB.prepare("DELETE FROM job_notification_targets WHERE job_id = ? AND target_id = ?")
      .bind(jobId, target.id).run();
    await env.DB.prepare("UPDATE notification_targets SET enabled = 0 WHERE id = ?").bind(target.id).run();
    const other = await createTarget("discord", { webhook_url: "https://discord.com/api/webhooks/987654321012345678/new-target" });
    await env.DB.prepare("INSERT INTO job_notification_targets (job_id, target_id, created_at) VALUES (?, ?, ?)")
      .bind(jobId, other.id, now).run();
    await env.DB.prepare("UPDATE notification_targets SET enabled = 1 WHERE id = ?").bind(target.id).run();
    await runNotificationTick(env.DB, resolvedAt, {
      fetch: async (input) => {
        expect(String(input)).toContain("123456789012345678/test-webhook-token");
        return new Response(null, { status: 204 });
      },
    });
    expect(await readDelivery(missed!.id, "recovery", target.id)).toMatchObject({ status: "sent" });
    expect(await readDelivery(missed!.id, "recovery", other.id)).toBeNull();
  });
});
