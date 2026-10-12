const MAX_DELIVERIES_PER_TICK = 10;
const MAX_ATTEMPTS = 8;
const CLAIM_LEASE_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const BASE_RETRY_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

interface DeliveryRow {
  id: string;
  alert_id: string;
  target_id: string;
  provider: "discord" | "telegram";
  target_name: string;
  config_json: string;
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

interface NotificationTargetConfig {
  webhook_url?: string;
  bot_token?: string;
  chat_id?: string;
}

interface NotificationOptions {
  fetch?: typeof fetch;
  random?: () => number;
}

/** Add one idempotent open-alert delivery for every enabled target assigned to the Job. */
export function queueOpenNotifications(
  db: D1Database,
  jobId: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notification_deliveries (
       id, alert_id, target_id, provider, target_name, notification_type, status, attempts,
       next_attempt_at, created_at, updated_at
     )
     SELECT lower(hex(randomblob(16))), a.id, t.id, t.provider, t.name, 'open', 'pending', 0, ?, ?, ?
     FROM alerts AS a
     INNER JOIN job_notification_targets AS jt ON jt.job_id = a.job_id
     INNER JOIN notification_targets AS t ON t.id = jt.target_id AND t.enabled = 1
     WHERE a.job_id = ? AND a.status = 'open'
     ON CONFLICT(alert_id, target_id, notification_type) DO NOTHING`,
  ).bind(now, now, now, jobId);
}

/** Queue recovery to the same active targets that were selected for the open alert. */
export function queueRecoveryNotification(
  db: D1Database,
  dedupeKey: string,
  resolvedAt: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notification_deliveries (
       id, alert_id, target_id, provider, target_name, notification_type, status, attempts,
       next_attempt_at, created_at, updated_at
     )
     SELECT lower(hex(randomblob(16))), a.id, opened.target_id, opened.provider, opened.target_name,
            'recovery', 'pending', 0, ?, ?, ?
     FROM alerts AS a
     INNER JOIN notification_deliveries AS opened
       ON opened.alert_id = a.id AND opened.notification_type = 'open'
     INNER JOIN notification_targets AS t
       ON t.id = opened.target_id AND t.enabled = 1 AND t.provider = opened.provider
     WHERE a.dedupe_key = ? AND a.status = 'resolved' AND a.resolved_at = ?
     ON CONFLICT(alert_id, target_id, notification_type) DO NOTHING`,
  ).bind(resolvedAt, resolvedAt, resolvedAt, dedupeKey, resolvedAt);
}

/** Queue recovery notices for alerts resolved by one successful Job run. */
export function queueResolvedJobNotifications(
  db: D1Database,
  jobId: string,
  resolvedAt: number,
  ruleKey: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notification_deliveries (
       id, alert_id, target_id, provider, target_name, notification_type, status, attempts,
       next_attempt_at, created_at, updated_at
     )
     SELECT lower(hex(randomblob(16))), a.id, opened.target_id, opened.provider, opened.target_name,
            'recovery', 'pending', 0, ?, ?, ?
     FROM alerts AS a
     INNER JOIN notification_deliveries AS opened
       ON opened.alert_id = a.id AND opened.notification_type = 'open'
     INNER JOIN notification_targets AS t
       ON t.id = opened.target_id AND t.enabled = 1 AND t.provider = opened.provider
     WHERE a.job_id = ? AND a.rule_key = ? AND a.status = 'resolved' AND a.resolved_at = ?
     ON CONFLICT(alert_id, target_id, notification_type) DO NOTHING`,
  ).bind(resolvedAt, resolvedAt, resolvedAt, jobId, ruleKey, resolvedAt);
}

/**
 * Drain a bounded number of due deliveries. D1 claims are conditional so two
 * overlapping Cron invocations cannot send the same active delivery together.
 */
export async function runNotificationTick(
  db: D1Database,
  now: number,
  options: NotificationOptions = {},
): Promise<void> {
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
    `SELECT d.id, d.alert_id, d.target_id, d.provider, d.target_name, t.config_json,
            d.notification_type, d.attempts, d.next_attempt_at,
            a.rule_key, a.severity, a.message, a.opened_at, a.resolved_at,
            h.display_name AS host_name, j.name AS job_name
     FROM notification_deliveries AS d
     INNER JOIN alerts AS a ON a.id = d.alert_id
     INNER JOIN notification_targets AS t
       ON t.id = d.target_id AND t.enabled = 1 AND t.provider = d.provider
     LEFT JOIN hosts AS h ON h.id = a.host_id
     LEFT JOIN jobs AS j ON j.id = a.job_id
     WHERE d.attempts < ? AND (
       (d.status = 'pending' AND d.next_attempt_at <= ?)
       OR (d.status = 'sending' AND d.claimed_at <= ?)
     )
     ORDER BY d.next_attempt_at ASC, d.id ASC LIMIT ?`,
  )
    .bind(MAX_ATTEMPTS, timestamp, reclaimBefore, MAX_DELIVERIES_PER_TICK)
    .all<DeliveryRow>();

  for (const delivery of due.results) {
    const claim = await db.prepare(
      `UPDATE notification_deliveries AS d
       SET status = 'sending', attempts = attempts + 1, claimed_at = ?, updated_at = ?
       WHERE id = ? AND attempts = ? AND EXISTS (
         SELECT 1 FROM notification_targets AS t
         WHERE t.id = d.target_id AND t.enabled = 1 AND t.provider = d.provider
       ) AND (
         (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'sending' AND claimed_at <= ?)
       )`,
    )
      .bind(timestamp, timestamp, delivery.id, delivery.attempts, timestamp, reclaimBefore)
      .run();
    if (claim.meta.changes !== 1) continue;

    const attempt = delivery.attempts + 1;
    const config = parseTargetConfig(delivery.config_json);
    const result = config === null
      ? { kind: "permanent" as const, error: "invalid_notification_target_config" }
      : delivery.provider === "discord"
        ? await sendDiscord(config, delivery, options.fetch ?? fetch, timestamp)
        : await sendTelegram(config, delivery, options.fetch ?? fetch, timestamp);
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

export function normalizeDiscordWebhookUrl(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim();
  if (!normalizedValue) return null;
  try {
    const url = new URL(normalizedValue);
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

type SendResult =
  | { kind: "sent" }
  | { kind: "retry"; error: string; retryAfterMs?: number }
  | { kind: "permanent"; error: string };

async function sendDiscord(
  config: NotificationTargetConfig,
  delivery: DeliveryRow,
  fetchImpl: typeof fetch,
  now: number,
): Promise<SendResult> {
  const url = normalizeDiscordWebhookUrl(config.webhook_url);
  if (url === null) return { kind: "permanent", error: "invalid_discord_webhook_url" };
  const content = renderMessage(delivery, true).slice(0, 1900);
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
      return { kind: "retry", error: "http_429", retryAfterMs: await parseRetryAfterMs(response, now) };
    }
    if (response.status === 408 || response.status >= 500) return { kind: "retry", error: `http_${response.status}` };
    return { kind: "permanent", error: `http_${response.status}` };
  } catch {
    // Fetch errors may include the secret webhook URL. Never persist exception text.
    return { kind: "retry", error: "network_or_timeout_error" };
  }
}

async function sendTelegram(
  config: NotificationTargetConfig,
  delivery: DeliveryRow,
  fetchImpl: typeof fetch,
  now: number,
): Promise<SendResult> {
  if (!config.bot_token || !config.chat_id) {
    return { kind: "permanent", error: "invalid_telegram_config" };
  }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chat_id, text: renderMessage(delivery, false).slice(0, 4096) }),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A malformed success body is retried because the API result is uncertain.
    }
    if (response.ok && isRecord(body) && body.ok === true) return { kind: "sent" };
    const errorCode = isRecord(body) && typeof body.error_code === "number" ? body.error_code : response.status;
    if (response.status === 429 || errorCode === 429) {
      return {
        kind: "retry",
        error: "telegram_rate_limited",
        retryAfterMs: await parseRetryAfterMs(response, now, body),
      };
    }
    if (response.status === 408 || response.status >= 500 || errorCode >= 500) {
      return { kind: "retry", error: `telegram_http_${response.status || errorCode}` };
    }
    if (response.ok && body === null) return { kind: "retry", error: "invalid_telegram_response" };
    return { kind: "permanent", error: `telegram_error_${errorCode}` };
  } catch {
    // The request URL contains the bot token. Never persist exception text.
    return { kind: "retry", error: "network_or_timeout_error" };
  }
}

function renderMessage(delivery: DeliveryRow, discord: boolean): string {
  const title = delivery.notification_type === "recovery" ? "Backup alert recovered" : "Backup alert";
  const heading = `${title} · ${delivery.severity.toUpperCase()}`;
  const lines = [
    discord ? `**${heading}**` : heading,
    `${delivery.rule_key}: ${delivery.message}`,
    `Host: ${cleanLabel(delivery.host_name ?? "unknown")}`,
    `Job: ${cleanLabel(delivery.job_name ?? "unknown")}`,
    delivery.notification_type === "recovery" && delivery.resolved_at !== null
      ? `Resolved: ${new Date(delivery.resolved_at).toISOString()}`
      : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

async function parseRetryAfterMs(response: Response, now: number, body?: unknown): Promise<number | undefined> {
  const maxDelay = Math.max(0, Number.MAX_SAFE_INTEGER - now);
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelay, Math.ceil(seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(maxDelay, Math.max(0, date - now));
  }

  let responseBody = body;
  if (responseBody === undefined) {
    try {
      responseBody = await response.json();
    } catch {
      return undefined;
    }
  }
  if (isRecord(responseBody)) {
    const parameters = isRecord(responseBody.parameters) ? responseBody.parameters : null;
    const retryAfter = parameters?.retry_after ?? responseBody.retry_after;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(maxDelay, Math.ceil(retryAfter * 1000));
    }
  }
  return undefined;
}

function parseTargetConfig(raw: string): NotificationTargetConfig | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed as NotificationTargetConfig : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/@/g, "＠").slice(0, 256);
}
