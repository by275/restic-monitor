import { Cron } from "croner";
import { Hono, type Context } from "hono";
import { normalizeDiscordWebhookUrl } from "./notifications";
import { createPingToken, normalizeSlug, sha256Hex, UUID_PATTERN } from "./security";

const api = new Hono<{ Bindings: Env }>();
const MAX_BODY_BYTES = 65_536;
const OPERATIONS = new Set([
  "backup", "forget", "prune", "forget_prune", "copy", "stats", "check", "restore",
]);
const BACKEND_TYPES = new Set(["local", "sftp", "rest", "s3", "b2", "azure", "gs", "other"]);

interface ScheduleInput {
  schedule_type: "cron";
  expression: string;
  timezone: string;
  start_grace_seconds: number;
}

interface RepositoryInput {
  repository_id: string;
  role: "repository" | "source" | "target";
}

interface JobInput {
  host_id: string;
  slug?: string;
  name: string;
  description?: string;
  operation: string;
  max_runtime_seconds: number;
  discord_enabled?: boolean;
  discord_webhook_url?: string;
  clear_discord_webhook?: boolean;
  enabled?: boolean;
  tags?: string[];
  repositories: RepositoryInput[];
  schedules: ScheduleInput[];
}

api.use("*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  context.header("X-Content-Type-Options", "nosniff");
  const adminHost = context.env.ADMIN_HOST?.trim().toLowerCase();
  const requestHost = new URL(context.req.url).hostname.toLowerCase();
  if (!adminHost || requestHost !== adminHost) return context.json({ error: "not_found" }, 404);
  await next();
});

api.get("/hosts", async (context) => {
  try {
    const result = await context.env.DB.prepare(
      `SELECT h.id, h.name, h.display_name, h.enabled, h.created_at, h.updated_at,
              COUNT(j.id) AS jobs_count
       FROM hosts AS h LEFT JOIN jobs AS j ON j.host_id = h.id
       GROUP BY h.id ORDER BY h.display_name COLLATE NOCASE, h.id`,
    ).all();
    return context.json({ data: result.results });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.post("/hosts", async (context) => {
  const parsed = await readJson(context.req.raw);
  if (!parsed.ok) return context.json({ error: parsed.error }, parsed.status);
  const value = asRecord(parsed.value);
  if (!value || !validLabel(value.name, 128) || !validLabel(value.display_name, 128)) {
    return context.json({ error: "invalid_host" }, 422);
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await context.env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).bind(id, value.name.trim(), value.display_name.trim(), now, now).run();
    return context.json({ id, name: value.name.trim(), display_name: value.display_name.trim(), enabled: true }, 201);
  } catch {
    return context.json({ error: "host_name_conflict_or_database_error" }, 409);
  }
});

api.put("/hosts/:hostId", async (context) => {
  const hostId = context.req.param("hostId");
  if (!UUID_PATTERN.test(hostId)) return context.json({ error: "invalid_host_id" }, 400);
  const parsed = await readJson(context.req.raw);
  if (!parsed.ok) return context.json({ error: parsed.error }, parsed.status);
  const value = asRecord(parsed.value);
  if (!value || !validLabel(value.display_name, 128) || typeof value.enabled !== "boolean") {
    return context.json({ error: "invalid_host_update" }, 422);
  }
  try {
    const result = await context.env.DB.prepare(
      "UPDATE hosts SET display_name = ?, enabled = ?, updated_at = ? WHERE id = ?",
    ).bind(value.display_name.trim(), value.enabled ? 1 : 0, Date.now(), hostId).run();
    if (result.meta.changes !== 1) return context.json({ error: "host_not_found" }, 404);
    return context.json({ id: hostId, display_name: value.display_name.trim(), enabled: value.enabled });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.delete("/hosts/:hostId", async (context) => {
  const hostId = context.req.param("hostId");
  if (!UUID_PATTERN.test(hostId)) return context.json({ error: "invalid_host_id" }, 400);
  try {
    const host = await context.env.DB.prepare("SELECT id FROM hosts WHERE id = ?")
      .bind(hostId).first<{ id: string }>();
    if (host === null) return context.json({ error: "host_not_found" }, 404);
    const usage = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE host_id = ?")
      .bind(hostId).first<{ count: number }>();
    if ((usage?.count ?? 0) > 0) {
      return context.json({ error: "host_in_use", jobs_count: usage?.count ?? 0 }, 409);
    }
    await context.env.DB.prepare("DELETE FROM hosts WHERE id = ?").bind(hostId).run();
    return context.body(null, 204);
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.get("/repositories", async (context) => {
  try {
    const result = await context.env.DB.prepare(
      `SELECT r.id, r.repository_key, r.name, r.backend_type, r.enabled, r.created_at, r.updated_at,
              (SELECT COUNT(DISTINCT jr.job_id) FROM job_repositories AS jr WHERE jr.repository_id = r.id) AS jobs_count,
              (SELECT COUNT(*) FROM run_repositories AS rr WHERE rr.repository_id = r.id) AS runs_count,
              (SELECT COUNT(*) FROM repository_stats AS rs WHERE rs.repository_id = r.id) AS stats_count
       FROM repositories AS r
       ORDER BY r.name COLLATE NOCASE, r.id`,
    ).all();
    return context.json({ data: result.results });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.post("/repositories", async (context) => {
  const parsed = await readJson(context.req.raw);
  if (!parsed.ok) return context.json({ error: parsed.error }, parsed.status);
  const value = asRecord(parsed.value);
  if (
    !value || !validKey(value.repository_key, 128) || !validLabel(value.name, 128) ||
    typeof value.backend_type !== "string" || !BACKEND_TYPES.has(value.backend_type)
  ) return context.json({ error: "invalid_repository" }, 422);

  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await context.env.DB.prepare(
      `INSERT INTO repositories (
         id, repository_key, name, backend_type, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(id, value.repository_key, value.name.trim(), value.backend_type, now, now).run();
    return context.json({
      id,
      repository_key: value.repository_key,
      name: value.name.trim(),
      backend_type: value.backend_type,
      enabled: true,
    }, 201);
  } catch {
    return context.json({ error: "repository_key_conflict_or_database_error" }, 409);
  }
});

api.put("/repositories/:repositoryId", async (context) => {
  const repositoryId = context.req.param("repositoryId");
  if (!UUID_PATTERN.test(repositoryId)) return context.json({ error: "invalid_repository_id" }, 400);
  const parsed = await readJson(context.req.raw);
  if (!parsed.ok) return context.json({ error: parsed.error }, parsed.status);
  const value = asRecord(parsed.value);
  if (
    !value || !validLabel(value.name, 128) || typeof value.backend_type !== "string" ||
    !BACKEND_TYPES.has(value.backend_type) || typeof value.enabled !== "boolean"
  ) return context.json({ error: "invalid_repository_update" }, 422);
  try {
    const result = await context.env.DB.prepare(
      "UPDATE repositories SET name = ?, backend_type = ?, enabled = ?, updated_at = ? WHERE id = ?",
    ).bind(value.name.trim(), value.backend_type, value.enabled ? 1 : 0, Date.now(), repositoryId).run();
    if (result.meta.changes !== 1) return context.json({ error: "repository_not_found" }, 404);
    return context.json({
      id: repositoryId,
      name: value.name.trim(),
      backend_type: value.backend_type,
      enabled: value.enabled,
    });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.delete("/repositories/:repositoryId", async (context) => {
  const repositoryId = context.req.param("repositoryId");
  if (!UUID_PATTERN.test(repositoryId)) return context.json({ error: "invalid_repository_id" }, 400);
  try {
    const repository = await context.env.DB.prepare("SELECT id FROM repositories WHERE id = ?")
      .bind(repositoryId).first<{ id: string }>();
    if (repository === null) return context.json({ error: "repository_not_found" }, 404);
    const usage = await context.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM job_repositories WHERE repository_id = ?) AS jobs_count,
         (SELECT COUNT(*) FROM run_repositories WHERE repository_id = ?) AS runs_count,
         (SELECT COUNT(*) FROM repository_stats WHERE repository_id = ?) AS stats_count`,
    ).bind(repositoryId, repositoryId, repositoryId).first<{
      jobs_count: number;
      runs_count: number;
      stats_count: number;
    }>();
    const jobsCount = usage?.jobs_count ?? 0;
    const runsCount = usage?.runs_count ?? 0;
    const statsCount = usage?.stats_count ?? 0;
    if (jobsCount + runsCount + statsCount > 0) {
      return context.json({
        error: "repository_in_use",
        jobs_count: jobsCount,
        runs_count: runsCount,
        stats_count: statsCount,
      }, 409);
    }
    await context.env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind(repositoryId).run();
    return context.body(null, 204);
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.get("/jobs", async (context) => {
  try {
    const result = await context.env.DB.prepare(
      `SELECT j.id, j.host_id, h.display_name AS host_name, j.slug, j.name, j.description,
              j.operation, j.max_runtime_seconds, j.discord_enabled,
              (j.discord_webhook_url IS NOT NULL) AS discord_webhook_configured, j.enabled,
              j.created_at, j.updated_at,
              COALESCE((SELECT json_group_array(tag) FROM job_tags AS t WHERE t.job_id = j.id), '[]') AS tags_json,
              COALESCE((SELECT json_group_array(json_object(
                'id', s.id, 'schedule_type', s.schedule_type, 'expression', s.expression,
                'timezone', s.timezone, 'start_grace_seconds', s.start_grace_seconds,
                'enabled', s.enabled, 'sort_order', s.sort_order
              )) FROM job_schedule_rules AS s WHERE s.job_id = j.id ORDER BY s.sort_order), '[]') AS schedules_json,
              COALESCE((SELECT json_group_array(json_object(
                'repository_id', r.id, 'repository_key', r.repository_key,
                'name', r.name, 'role', jr.role
              )) FROM job_repositories AS jr INNER JOIN repositories AS r ON r.id = jr.repository_id
                WHERE jr.job_id = j.id ORDER BY jr.role), '[]') AS repositories_json,
              (SELECT token_prefix FROM job_ping_tokens AS pt
               WHERE pt.job_id = j.id AND pt.revoked_at IS NULL LIMIT 1) AS token_prefix
       FROM jobs AS j INNER JOIN hosts AS h ON h.id = j.host_id
       ORDER BY h.display_name COLLATE NOCASE, j.name COLLATE NOCASE, j.id`,
    ).all<Record<string, unknown>>();
    return context.json({ data: result.results.map(shapeJob) });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.post("/jobs", async (context) => {
  const parsed = await readJson(context.req.raw);
  if (!parsed.ok) return context.json({ error: parsed.error }, parsed.status);
  const validation = validateJob(parsed.value);
  if (!validation.ok) return context.json({ error: validation.error }, 422);
  const input = validation.value;
  if (input.clear_discord_webhook) {
    return context.json({ error: "clear_discord_webhook_requires_existing_job" }, 422);
  }
  const referencesValid = await validateReferences(context.env.DB, input);
  if (!referencesValid) return context.json({ error: "invalid_host_or_repository_reference" }, 422);

  const id = crypto.randomUUID();
  const slug = resolveSlug(input.slug, input.name, id);
  const now = Date.now();
  const token = createPingToken();
  let pingUrl: string;
  try {
    pingUrl = buildPingUrl(context.req.url, context.env as Env & { PING_BASE_URL?: string; ADMIN_HOST?: string }, token);
  } catch {
    return context.json({ error: "ping_base_url_not_configured" }, 503);
  }
  try {
    const statements = jobStatements(context.env.DB, id, input, slug, now);
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO job_ping_tokens (id, job_id, token_prefix, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), id, token.slice(0, 9), await sha256Hex(token), now),
    );
    await context.env.DB.batch(statements);
    return context.json({ id, slug, ping_url: pingUrl, token_shown_once: true }, 201);
  } catch {
    return context.json({ error: "job_slug_conflict_or_database_error" }, 409);
  }
});

api.put("/jobs/:jobId", async (context) => {
  const jobId = context.req.param("jobId");
  if (!UUID_PATTERN.test(jobId)) return context.json({ error: "invalid_job_id" }, 400);
  const parsed = await readJson(context.req.raw);
  if (!parsed.ok) return context.json({ error: parsed.error }, parsed.status);
  const validation = validateJob(parsed.value);
  if (!validation.ok) return context.json({ error: validation.error }, 422);
  const input = validation.value;
  const current = await context.env.DB.prepare("SELECT id, host_id FROM jobs WHERE id = ?")
    .bind(jobId).first<{ id: string; host_id: string }>();
  if (current === null) return context.json({ error: "job_not_found" }, 404);
  if (input.host_id !== current.host_id) return context.json({ error: "job_host_is_immutable" }, 409);
  if (!await validateReferences(context.env.DB, input, jobId)) {
    return context.json({ error: "invalid_host_or_repository_reference" }, 422);
  }

  const slug = resolveSlug(input.slug, input.name, jobId);
  const now = Date.now();
  try {
    const statements = [
      context.env.DB.prepare(
        `UPDATE jobs SET slug = ?, name = ?, description = ?, operation = ?,
           max_runtime_seconds = ?, discord_enabled = ?,
           discord_webhook_url = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE discord_webhook_url END,
           enabled = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        slug, input.name.trim(), input.description ?? "", input.operation,
        input.max_runtime_seconds, input.discord_enabled === false ? 0 : 1,
        input.discord_webhook_url !== undefined ? 1 : 0, input.discord_webhook_url ?? null,
        input.clear_discord_webhook === true ? 1 : 0,
        input.enabled === false ? 0 : 1, now, jobId,
      ),
      context.env.DB.prepare("DELETE FROM job_tags WHERE job_id = ?").bind(jobId),
      context.env.DB.prepare("DELETE FROM job_repositories WHERE job_id = ?").bind(jobId),
      context.env.DB.prepare("DELETE FROM job_schedule_rules WHERE job_id = ?").bind(jobId),
    ];
    statements.push(...jobRelationStatements(context.env.DB, jobId, input, now));
    await context.env.DB.batch(statements);
    return context.json({ id: jobId, slug, updated_at: now });
  } catch {
    return context.json({ error: "job_slug_conflict_or_database_error" }, 409);
  }
});

api.post("/jobs/:jobId/rotate-ping-token", async (context) => {
  const jobId = context.req.param("jobId");
  if (!UUID_PATTERN.test(jobId)) return context.json({ error: "invalid_job_id" }, 400);
  const job = await context.env.DB.prepare("SELECT id FROM jobs WHERE id = ?")
    .bind(jobId).first<{ id: string }>();
  if (job === null) return context.json({ error: "job_not_found" }, 404);
  const token = createPingToken();
  const now = Date.now();
  let pingUrl: string;
  try {
    pingUrl = buildPingUrl(context.req.url, context.env as Env & { PING_BASE_URL?: string; ADMIN_HOST?: string }, token);
  } catch {
    return context.json({ error: "ping_base_url_not_configured" }, 503);
  }
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE job_ping_tokens SET revoked_at = ? WHERE job_id = ? AND revoked_at IS NULL",
      ).bind(now, jobId),
      context.env.DB.prepare(
        `INSERT INTO job_ping_tokens (id, job_id, token_prefix, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), jobId, token.slice(0, 9), await sha256Hex(token), now),
    ]);
    return context.json({
      ping_url: pingUrl,
      token_shown_once: true,
    });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

async function readJson(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: string; status: 400 | 413 }
> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, error: "unsupported_media_type", status: 400 };
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return { ok: false, error: "payload_too_large", status: 413 };
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return { ok: false, error: "payload_too_large", status: 413 };
    }
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function validateJob(value: unknown): { ok: true; value: JobInput } | { ok: false; error: string } {
  const item = asRecord(value);
  if (!item) return { ok: false, error: "invalid_job" };
  if (!isId(item.host_id) || !validLabel(item.name, 128)) return { ok: false, error: "invalid_job_identity" };
  if (item.slug !== undefined && item.slug !== "" && (typeof item.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug))) {
    return { ok: false, error: "invalid_job_slug" };
  }
  if (typeof item.operation !== "string" || !OPERATIONS.has(item.operation)) {
    return { ok: false, error: "invalid_operation" };
  }
  if (!Number.isInteger(item.max_runtime_seconds) || Number(item.max_runtime_seconds) < 1 || Number(item.max_runtime_seconds) > 31_536_000) {
    return { ok: false, error: "invalid_max_runtime_seconds" };
  }
  if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 2000)) {
    return { ok: false, error: "invalid_description" };
  }
  if (item.discord_enabled !== undefined && typeof item.discord_enabled !== "boolean") {
    return { ok: false, error: "invalid_discord_enabled" };
  }
  if (item.clear_discord_webhook !== undefined && typeof item.clear_discord_webhook !== "boolean") {
    return { ok: false, error: "invalid_clear_discord_webhook" };
  }
  let discordWebhookUrl: string | undefined;
  if (item.discord_webhook_url !== undefined) {
    if (typeof item.discord_webhook_url !== "string" || item.discord_webhook_url.length > 2048) {
      return { ok: false, error: "invalid_discord_webhook_url" };
    }
    const value = item.discord_webhook_url.trim();
    if (value) {
      const normalized = normalizeDiscordWebhookUrl(value);
      if (normalized === null) return { ok: false, error: "invalid_discord_webhook_url" };
      discordWebhookUrl = normalized;
    }
  }
  if (discordWebhookUrl !== undefined && item.clear_discord_webhook === true) {
    return { ok: false, error: "discord_webhook_update_conflict" };
  }
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") return { ok: false, error: "invalid_enabled" };
  if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 32 || !item.tags.every((tag) => typeof tag === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(tag)))) {
    return { ok: false, error: "invalid_tags" };
  }
  if (!Array.isArray(item.repositories) || item.repositories.length < 1 || item.repositories.length > 2) {
    return { ok: false, error: "invalid_repositories" };
  }
  const repositories: RepositoryInput[] = [];
  for (const raw of item.repositories) {
    const repository = asRecord(raw);
    if (!repository || !isId(repository.repository_id) || !["repository", "source", "target"].includes(String(repository.role))) {
      return { ok: false, error: "invalid_repositories" };
    }
    repositories.push({ repository_id: String(repository.repository_id), role: repository.role as RepositoryInput["role"] });
  }
  const roleCounts = repositories.reduce<Record<string, number>>((counts, repository) => {
    counts[repository.role] = (counts[repository.role] ?? 0) + 1;
    return counts;
  }, {});
  if (item.operation === "copy") {
    if (repositories.length !== 2 || roleCounts.source !== 1 || roleCounts.target !== 1) {
      return { ok: false, error: "copy_requires_source_and_target" };
    }
  } else if (repositories.length !== 1 || roleCounts.repository !== 1) {
    return { ok: false, error: "operation_requires_one_repository" };
  }

  if (!Array.isArray(item.schedules) || item.schedules.length < 1 || item.schedules.length > 16) {
    return { ok: false, error: "invalid_schedules" };
  }
  const schedules: ScheduleInput[] = [];
  for (const raw of item.schedules) {
    const schedule = asRecord(raw);
    if (
      !schedule || schedule.schedule_type !== "cron" || typeof schedule.expression !== "string" ||
      typeof schedule.timezone !== "string" || !Number.isInteger(schedule.start_grace_seconds) ||
      Number(schedule.start_grace_seconds) < 0 || Number(schedule.start_grace_seconds) > 31_536_000 ||
      !isValidCron(schedule.expression, schedule.timezone)
    ) return { ok: false, error: "invalid_cron_schedule" };
    schedules.push({
      schedule_type: "cron",
      expression: schedule.expression.trim(),
      timezone: schedule.timezone,
      start_grace_seconds: Number(schedule.start_grace_seconds),
    });
  }
  return {
    ok: true,
    value: {
      host_id: String(item.host_id),
      slug: typeof item.slug === "string" ? item.slug : undefined,
      name: item.name.trim(),
      description: typeof item.description === "string" ? item.description : "",
      operation: item.operation,
      max_runtime_seconds: Number(item.max_runtime_seconds),
      discord_enabled: item.discord_enabled !== false,
      discord_webhook_url: discordWebhookUrl,
      clear_discord_webhook: item.clear_discord_webhook === true,
      enabled: item.enabled !== false,
      tags: [...new Set(((item.tags as string[] | undefined) ?? []).map((tag) => tag.toLowerCase()))],
      repositories,
      schedules,
    },
  };
}

function isValidCron(expression: string, timezone: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9A-Za-z*/,-]+$/.test(field))) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
    const cron = new Cron(expression, { timezone, paused: true, domAndDow: false });
    const valid = cron.nextRun(new Date()) !== null;
    cron.stop();
    return valid;
  } catch {
    return false;
  }
}

async function validateReferences(db: D1Database, input: JobInput, existingJobId?: string): Promise<boolean> {
  const host = existingJobId === undefined
    ? await db.prepare("SELECT id FROM hosts WHERE id = ? AND enabled = 1")
      .bind(input.host_id).first<{ id: string }>()
    : await db.prepare(
      `SELECT h.id FROM hosts AS h WHERE h.id = ? AND (
         h.enabled = 1 OR EXISTS (SELECT 1 FROM jobs AS j WHERE j.id = ? AND j.host_id = h.id)
       )`,
    ).bind(input.host_id, existingJobId).first<{ id: string }>();
  if (host === null) return false;
  for (const repository of input.repositories) {
    const row = existingJobId === undefined
      ? await db.prepare("SELECT id FROM repositories WHERE id = ? AND enabled = 1")
        .bind(repository.repository_id).first<{ id: string }>()
      : await db.prepare(
        `SELECT r.id FROM repositories AS r WHERE r.id = ? AND (
           r.enabled = 1 OR EXISTS (
             SELECT 1 FROM job_repositories AS jr WHERE jr.job_id = ? AND jr.repository_id = r.id
           )
         )`,
      ).bind(repository.repository_id, existingJobId).first<{ id: string }>();
    if (row === null) return false;
  }
  return true;
}

function jobStatements(db: D1Database, id: string, input: JobInput, slug: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO jobs (
         id, host_id, slug, name, description, operation, max_runtime_seconds,
         discord_enabled, discord_webhook_url, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.host_id, slug, input.name.trim(), input.description ?? "", input.operation,
      input.max_runtime_seconds, input.discord_enabled === false ? 0 : 1,
      input.discord_webhook_url ?? null,
      input.enabled === false ? 0 : 1, now, now,
    ),
    ...jobRelationStatements(db, id, input, now),
  ];
}

function jobRelationStatements(db: D1Database, jobId: string, input: JobInput, now: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const tag of input.tags ?? []) {
    statements.push(db.prepare("INSERT INTO job_tags (job_id, tag) VALUES (?, ?)").bind(jobId, tag));
  }
  for (const repository of input.repositories) {
    statements.push(
      db.prepare("INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, ?)")
        .bind(jobId, repository.repository_id, repository.role),
    );
  }
  input.schedules.forEach((schedule, index) => {
    statements.push(
      db.prepare(
        `INSERT INTO job_schedule_rules (
           id, job_id, schedule_type, expression, timezone, start_grace_seconds,
           enabled, sort_order, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), jobId, schedule.schedule_type, schedule.expression,
        schedule.timezone, schedule.start_grace_seconds, index, now, now,
      ),
    );
  });
  return statements;
}

function shapeJob(row: Record<string, unknown>) {
  return {
    ...row,
    enabled: row.enabled === 1,
    discord_enabled: row.discord_enabled === 1,
    discord_webhook_configured: row.discord_webhook_configured === 1,
    tags: safeJsonArray(row.tags_json),
    schedules: safeJsonArray(row.schedules_json),
    repositories: safeJsonArray(row.repositories_json),
    tags_json: undefined,
    schedules_json: undefined,
    repositories_json: undefined,
  };
}

function safeJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildPingUrl(
  requestUrl: string,
  env: Env & { PING_BASE_URL?: string; ADMIN_HOST?: string },
  token: string,
): string {
  const request = new URL(requestUrl);
  const configured = env.PING_BASE_URL?.trim();
  if (!configured && request.hostname !== "localhost" && request.hostname !== "127.0.0.1") {
    throw new Error("PING_BASE_URL must name the public ping hostname");
  }
  const base = new URL(configured || request.origin);
  const adminHost = env.ADMIN_HOST?.trim().toLowerCase();
  if (
    (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") ||
    (adminHost && base.hostname.toLowerCase() === adminHost && adminHost !== "localhost") ||
    base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== ""
  ) {
    throw new Error("PING_BASE_URL must be a public URL separate from the Access-protected admin hostname");
  }
  const url = new URL(`/api/v1/ping/${token}`, base.origin);
  return url.toString();
}

function resolveSlug(input: string | undefined, name: string, id: string): string {
  const candidate = input?.trim() || normalizeSlug(name);
  return candidate || `job-${id.slice(0, 8)}`;
}

function validLabel(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum;
}

function validKey(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9._-]+$/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export default api;
