const DISCORD_CHANNEL = "discord";
const MAX_DELIVERIES_PER_TICK = 10;
const MAX_ATTEMPTS = 8;
const CLAIM_LEASE_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const BASE_RETRY_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

interface DeliveryRow {
  id: string;
  alert_id: string;
  notification_type: "open" | "recovery";
  attempts: number;
  next_attempt_at: number;
  rule_key: string;
  severity: "info" | "warning" | "critical";
  message: string;
  opened_at: number;
  resolved_at: number | null;
  host_name: string | null;
  job_name: string | null;
}

interface NotificationOptions {
  fetch?: typeof fetch;
  random?: () => number;
}

/** Add one idempotent open-alert delivery for each active alert on a job. */
export function queueOpenNotifications(
  db: D1Database,
  jobId: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notification_deliveries (
       id, alert_id, channel_key, notification_type, status, attempts,
       next_attempt_at, created_at, updated_at
     )
     SELECT lower(hex(randomblob(16))), a.id, ?, 'open', 'pending', 0, ?, ?, ?
     FROM alerts AS a
     INNER JOIN jobs AS j ON j.id = a.job_id
     WHERE a.job_id = ? AND a.status = 'open' AND j.discord_enabled = 1
     ON CONFLICT(alert_id, channel_key, notification_type) DO NOTHING`,
  ).bind(DISCORD_CHANNEL, now, now, now, jobId);
}

/** Add the single recovery delivery after an alert has been resolved. */
export function queueRecoveryNotification(
  db: D1Database,
  dedupeKey: string,
  resolvedAt: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notification_deliveries (
       id, alert_id, channel_key, notification_type, status, attempts,
       next_attempt_at, created_at, updated_at
     )
     SELECT lower(hex(randomblob(16))), a.id, ?, 'recovery', 'pending', 0, ?, ?, ?
     FROM alerts AS a
     INNER JOIN jobs AS j ON j.id = a.job_id
     WHERE a.dedupe_key = ? AND a.status = 'resolved' AND a.resolved_at = ?
       AND j.discord_enabled = 1
     ON CONFLICT(alert_id, channel_key, notification_type) DO NOTHING`,
  ).bind(DISCORD_CHANNEL, resolvedAt, resolvedAt, resolvedAt, dedupeKey, resolvedAt);
}

/** Queue recovery notices for every alert resolved by one successful Job run. */
export function queueResolvedJobNotifications(
  db: D1Database,
  jobId: string,
  resolvedAt: number,
  ruleKey: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notification_deliveries (
       id, alert_id, channel_key, notification_type, status, attempts,
       next_attempt_at, created_at, updated_at
     )
     SELECT lower(hex(randomblob(16))), a.id, ?, 'recovery', 'pending', 0, ?, ?, ?
     FROM alerts AS a
     INNER JOIN jobs AS j ON j.id = a.job_id
     WHERE a.job_id = ? AND a.rule_key = ? AND a.status = 'resolved'
       AND a.resolved_at = ? AND j.discord_enabled = 1
     ON CONFLICT(alert_id, channel_key, notification_type) DO NOTHING`,
  ).bind(DISCORD_CHANNEL, resolvedAt, resolvedAt, resolvedAt, jobId, ruleKey, resolvedAt);
}

/**
 * Drain a bounded number of due deliveries. D1 claims are conditional so two
 * overlapping Cron invocations cannot send the same active delivery together.
 */
export async function runNotificationTick(
  db: D1Database,
  webhookSecret: string | undefined,
  now: number,
  options: NotificationOptions = {},
): Promise<void> {
  const webhookUrl = normalizeWebhookUrl(webhookSecret);
  if (webhookUrl === null) {
    if (webhookSecret?.trim()) {
      console.error("Discord webhook secret is not a valid discord.com webhook URL");
    } else {
      console.warn("Discord webhook secret is not configured; pending alerts retained");
    }
    return;
  }

  const timestamp = Math.max(0, Math.trunc(now));
  const reclaimBefore = timestamp - CLAIM_LEASE_MS;
  await db.prepare(
    `UPDATE notification_deliveries
     SET status = 'dead', claimed_at = NULL,
         last_error = COALESCE(last_error, 'delivery_lease_expired'), updated_at = ?
     WHERE status = 'sending' AND attempts >= ? AND claimed_at <= ?`,
  )
    .bind(timestamp, MAX_ATTEMPTS, reclaimBefore)
    .run();

  const due = await db.prepare(
    `SELECT d.id, d.alert_id, d.notification_type, d.attempts, d.next_attempt_at,
            a.rule_key, a.severity, a.message, a.opened_at, a.resolved_at,
            h.display_name AS host_name, j.name AS job_name
     FROM notification_deliveries AS d
     INNER JOIN alerts AS a ON a.id = d.alert_id
     LEFT JOIN hosts AS h ON h.id = a.host_id
     LEFT JOIN jobs AS j ON j.id = a.job_id
     WHERE d.channel_key = ? AND d.attempts < ? AND (
       (d.status = 'pending' AND d.next_attempt_at <= ?)
       OR (d.status = 'sending' AND d.claimed_at <= ?)
     )
     ORDER BY d.next_attempt_at ASC, d.id ASC LIMIT ?`,
  )
    .bind(DISCORD_CHANNEL, MAX_ATTEMPTS, timestamp, reclaimBefore, MAX_DELIVERIES_PER_TICK)
    .all<DeliveryRow>();

  for (const delivery of due.results) {
    const claim = await db.prepare(
      `UPDATE notification_deliveries
       SET status = 'sending', attempts = attempts + 1, claimed_at = ?, updated_at = ?
       WHERE id = ? AND attempts = ? AND (
         (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'sending' AND claimed_at <= ?)
       )`,
    )
      .bind(timestamp, timestamp, delivery.id, delivery.attempts, timestamp, reclaimBefore)
      .run();
    if (claim.meta.changes !== 1) continue;

    const attempt = delivery.attempts + 1;
    const result = await sendDiscord(webhookUrl, delivery, options.fetch ?? fetch, timestamp);
    if (result.kind === "sent") {
      await db.prepare(
        `UPDATE notification_deliveries
         SET status = 'sent', sent_at = ?, claimed_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'sending' AND claimed_at = ?`,
      )
        .bind(timestamp, timestamp, delivery.id, timestamp)
        .run();
      continue;
    }

    const permanent = result.kind === "permanent";
    const dead = permanent || attempt >= MAX_ATTEMPTS;
    const nextAttemptAt = dead
      ? timestamp
      : timestamp + (
          result.retryAfterMs ?? calculateRetryDelayMs(attempt, options.random?.() ?? Math.random())
        );
    await db.prepare(
      `UPDATE notification_deliveries
       SET status = ?, next_attempt_at = ?, claimed_at = NULL,
           last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'sending' AND claimed_at = ?`,
    )
      .bind(dead ? "dead" : "pending", nextAttemptAt, result.error, timestamp, delivery.id, timestamp)
      .run();
  }
}

export function calculateRetryDelayMs(attempt: number, randomValue = 0.5): number {
  const exponent = Math.max(0, Math.min(30, Math.trunc(attempt) - 1));
  const base = Math.min(BASE_RETRY_MS * 2 ** exponent, MAX_BACKOFF_MS);
  const jitter = 0.75 + Math.max(0, Math.min(1, randomValue)) * 0.5;
  return Math.min(MAX_BACKOFF_MS, Math.round(base * jitter));
}

function normalizeWebhookUrl(secret: string | undefined): string | null {
  const value = secret?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "discord.com" ||
      url.port !== "" ||
      url.username ||
      url.password ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w.-]+$/.test(url.pathname)
    ) {
      return null;
    }
    url.searchParams.set("wait", "true");
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

type DiscordResult =
  | { kind: "sent" }
  | { kind: "retry"; error: string; retryAfterMs?: number }
  | { kind: "permanent"; error: string };

async function sendDiscord(
  url: string,
  delivery: DeliveryRow,
  fetchImpl: typeof fetch,
  now: number,
): Promise<DiscordResult> {
  const title = delivery.notification_type === "recovery"
    ? "Backup alert recovered"
    : "Backup alert";
  const lines = [
    `**${title} · ${delivery.severity.toUpperCase()}**`,
    `${delivery.rule_key}: ${delivery.message}`,
    `Host: ${cleanLabel(delivery.host_name ?? "unknown")}`,
    `Job: ${cleanLabel(delivery.job_name ?? "unknown")}`,
    delivery.notification_type === "recovery" && delivery.resolved_at !== null
      ? `Resolved: ${new Date(delivery.resolved_at).toISOString()}`
      : null,
  ].filter((line): line is string => line !== null);
  const content = lines.join("\n").slice(0, 1900);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) return { kind: "sent" };
    if (response.status === 429) {
      return {
        kind: "retry",
        error: "http_429",
        retryAfterMs: await parseRetryAfterMs(response, now),
      };
    }
    if (response.status === 408 || response.status >= 500) {
      return { kind: "retry", error: `http_${response.status}` };
    }
    return { kind: "permanent", error: `http_${response.status}` };
  } catch {
    // Do not persist exception text: fetch errors may contain the secret webhook URL.
    return { kind: "retry", error: "network_or_timeout_error" };
  }
}

async function parseRetryAfterMs(response: Response, now: number): Promise<number | undefined> {
  const maxDelay = Math.max(0, Number.MAX_SAFE_INTEGER - now);
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxDelay, Math.ceil(seconds * 1000));
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(maxDelay, Math.max(0, date - now));
  }

  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "retry_after" in body) {
      const retryAfter = (body as { retry_after?: unknown }).retry_after;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
        return Math.min(maxDelay, Math.ceil(retryAfter * 1000));
      }
    }
  } catch {
    // Retry with exponential backoff when Discord's response has no valid hint.
  }
  return undefined;
}

function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/@/g, "＠").slice(0, 256);
}
