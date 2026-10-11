import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const RUN_STATUSES = new Set([
  "running",
  "success",
  "partial_success",
  "failed",
  "timed_out",
  "cancelled",
]);
const OPERATIONS = new Set([
  "backup",
  "forget",
  "prune",
  "forget_prune",
  "copy",
  "stats",
  "check",
  "restore",
]);
const BACKEND_TYPES = new Set(["local", "sftp", "rest", "s3", "b2", "azure", "gs", "other"]);
const MEASUREMENT_TYPES = new Set([
  "restic_restore_size",
  "restic_raw_data",
  "restic_total_size",
  "backend_physical_bytes",
]);

interface RunFilters {
  host_id: string | null;
  job_key: string | null;
  repository_key: string | null;
  status: string | null;
  operation: string | null;
}

interface RunRow {
  id: string;
  workflow_id: string | null;
  operation: string;
  status: string;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  error_summary: string | null;
  client_name: string;
  client_version: string;
  restic_version: string | null;
  job_id: string;
  job_key: string;
  job_name: string;
  host_id: string;
  host_name: string;
  host_display_name: string;
  repositories_json: string;
  metrics_run_id: string | null;
  bytes_processed: number | null;
  bytes_added: number | null;
  bytes_added_packed: number | null;
  files_new: number | null;
  files_changed: number | null;
  files_unmodified: number | null;
  snapshot_id: string | null;
}

interface HostRow {
  id: string;
  name: string;
  display_name: string;
  enabled: number;
  created_at: number;
  jobs_count: number;
  last_run_status: string | null;
  last_run_started_at: number | null;
}

interface RepositoryRow {
  id: string;
  repository_key: string;
  name: string;
  backend_type: string;
  enabled: number;
  created_at: number;
  jobs_count: number;
  last_run_status: string | null;
  last_run_started_at: number | null;
  last_measured_at: number | null;
}

interface RepositoryStatRow {
  id: string;
  source_run_id: string | null;
  job_id: string | null;
  measurement_type: string;
  value_bytes: number;
  measured_at: number;
  details_json: string;
  is_anomalous: number;
}

const runSelect = `
  SELECT r.id, r.workflow_id, r.operation, r.status, r.exit_code,
         r.started_at, r.finished_at, r.duration_ms, r.error_summary,
         r.client_name, r.client_version, r.restic_version,
         j.id AS job_id, j.job_key, j.name AS job_name,
         h.id AS host_id, h.name AS host_name, h.display_name AS host_display_name,
         COALESCE((
           SELECT json_group_array(json_object(
             'repository_key', rp.repository_key,
             'name', rp.name,
             'role', rr.role
           ))
           FROM run_repositories AS rr
           INNER JOIN repositories AS rp ON rp.id = rr.repository_id
           WHERE rr.run_id = r.id
         ), '[]') AS repositories_json,
         rm.run_id AS metrics_run_id,
         rm.bytes_processed, rm.bytes_added, rm.bytes_added_packed,
         rm.files_new, rm.files_changed, rm.files_unmodified, rm.snapshot_id
  FROM runs AS r
  INNER JOIN jobs AS j ON j.id = r.job_id
  INNER JOIN hosts AS h ON h.id = j.host_id
  LEFT JOIN run_metrics AS rm ON rm.run_id = r.id`;

app.use("*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  context.header("X-Content-Type-Options", "nosniff");
  const configuredHost = context.env.ADMIN_HOST?.trim().toLowerCase();
  const requestHost = new URL(context.req.url).hostname.toLowerCase();
  if (configuredHost === undefined || configuredHost.length === 0 || requestHost !== configuredHost) {
    return context.json({ error: "not_found" }, 404);
  }
  await next();
});

app.get("/overview", async (context) => {
  const params = new URL(context.req.url).searchParams;
  const daysRaw = params.get("window_days") ?? "7";
  if (!/^\d{1,3}$/.test(daysRaw)) return context.json({ error: "invalid_window_days" }, 400);
  const windowDays = Number(daysRaw);
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) {
    return context.json({ error: "invalid_window_days" }, 400);
  }
  const filtersResult = parseRunFilters(params, false);
  if (filtersResult.error !== null) return context.json({ error: filtersResult.error }, 400);
  const { filters } = filtersResult;
  const clauses = ["r.started_at >= ?"];
  const values: Array<string | number> = [Date.now() - windowDays * 86_400_000];
  appendRunFilters(filters, clauses, values);
  const where = `WHERE ${clauses.join(" AND ")}`;

  try {
    const [totals, inventory, recent] = await Promise.all([
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total_runs,
                COALESCE(SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END), 0) AS running,
                COALESCE(SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END), 0) AS success,
                COALESCE(SUM(CASE WHEN r.status = 'partial_success' THEN 1 ELSE 0 END), 0) AS partial_success,
                COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CASE WHEN r.status = 'timed_out' THEN 1 ELSE 0 END), 0) AS timed_out,
                COALESCE(SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
         FROM runs AS r
         INNER JOIN jobs AS j ON j.id = r.job_id
         INNER JOIN hosts AS h ON h.id = j.host_id
         ${where}`,
      )
        .bind(...values)
        .first<Record<string, number>>(),
      context.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM hosts WHERE enabled = 1) AS active_hosts,
                (SELECT COUNT(*) FROM jobs WHERE enabled = 1) AS active_jobs,
                (SELECT COUNT(*) FROM repositories WHERE enabled = 1) AS active_repositories`,
      ).first<Record<string, number>>(),
      queryRecentRuns(context.env.DB, filters, 8),
    ]);
    return context.json({
      generated_at: new Date().toISOString(),
      window_days: windowDays,
      filters,
      counts: {
        ...(totals ?? {}),
        ...(inventory ?? {}),
      },
      recent_runs: recent,
    });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

app.get("/runs", async (context) => {
  const params = new URL(context.req.url).searchParams;
  const page = parsePage(params);
  if (page.error !== null) return context.json({ error: page.error }, 400);
  const filterResult = parseRunFilters(params, true);
  if (filterResult.error !== null) return context.json({ error: filterResult.error }, 400);
  const filters = filterResult.filters;
  const filterSignature = JSON.stringify(filters);
  const cursorResult = decodeCursor(params.get("cursor"), "runs", filterSignature);
  if (cursorResult.error) return context.json({ error: "invalid_cursor" }, 400);
  const cursorKey = cursorResult.key;

  const clauses: string[] = [];
  const values: Array<string | number> = [];
  appendRunFilters(filters, clauses, values);
  if (cursorKey !== null) {
    if (!isRecord(cursorKey) || !isSafeTimestamp(cursorKey.started_at) || !isValidId(cursorKey.id)) {
      return context.json({ error: "invalid_cursor" }, 400);
    }
    clauses.push("(r.started_at < ? OR (r.started_at = ? AND r.id < ?))");
    values.push(cursorKey.started_at, cursorKey.started_at, cursorKey.id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const result = await context.env.DB.prepare(
      `${runSelect} ${where} ORDER BY r.started_at DESC, r.id DESC LIMIT ?`,
    )
      .bind(...values, page.limit + 1)
      .all<RunRow>();
    return context.json(makePage(
      result.results,
      page.limit,
      (row) => ({ started_at: row.started_at, id: row.id }),
      (row) => mapRun(row, false),
      "runs",
      filterSignature,
    ));
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

app.get("/runs/:runId", async (context) => {
  const runId = context.req.param("runId");
  if (!isValidId(runId)) return context.json({ error: "invalid_run_id" }, 400);
  try {
    const row = await context.env.DB.prepare(`${runSelect} WHERE r.id = ?`)
      .bind(runId)
      .first<RunRow>();
    if (row === null) return context.json({ error: "not_found" }, 404);
    return context.json({ data: mapRun(row, true) });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

app.get("/hosts", async (context) => {
  const params = new URL(context.req.url).searchParams;
  const page = parsePage(params);
  if (page.error !== null) return context.json({ error: page.error }, 400);
  const enabled = parseEnabledFilter(params);
  if (enabled.error) return context.json({ error: "invalid_enabled_filter" }, 400);
  const search = parseSearchFilter(params);
  if (search.error) return context.json({ error: "invalid_search" }, 400);
  const filterSignature = JSON.stringify({ enabled: enabled.value ?? null, q: search.value });
  const cursorResult = decodeCursor(params.get("cursor"), "hosts", filterSignature);
  if (cursorResult.error) return context.json({ error: "invalid_cursor" }, 400);
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (enabled.value !== undefined) {
    clauses.push("h.enabled = ?");
    values.push(enabled.value ? 1 : 0);
  }
  if (search.value !== null) {
    clauses.push("(h.name LIKE ? ESCAPE '!' OR h.display_name LIKE ? ESCAPE '!')");
    const pattern = `${escapeLike(search.value)}%`;
    values.push(pattern, pattern);
  }
  if (cursorResult.key !== null) {
    const key = cursorResult.key;
    if (!isRecord(key) || !isSafeTimestamp(key.created_at) || !isValidId(key.id)) {
      return context.json({ error: "invalid_cursor" }, 400);
    }
    clauses.push("(h.created_at > ? OR (h.created_at = ? AND h.id > ?))");
    values.push(key.created_at, key.created_at, key.id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const result = await context.env.DB.prepare(
      `SELECT h.id, h.name, h.display_name, h.enabled, h.created_at,
              (SELECT COUNT(*) FROM jobs AS j WHERE j.host_id = h.id) AS jobs_count,
              (SELECT r.status FROM jobs AS j INNER JOIN runs AS r ON r.job_id = j.id
               WHERE j.host_id = h.id ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS last_run_status,
              (SELECT r.started_at FROM jobs AS j INNER JOIN runs AS r ON r.job_id = j.id
               WHERE j.host_id = h.id ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS last_run_started_at
       FROM hosts AS h ${where}
       ORDER BY h.created_at ASC, h.id ASC LIMIT ?`,
    )
      .bind(...values, page.limit + 1)
      .all<HostRow>();
    return context.json(makePage(
      result.results,
      page.limit,
      (row) => ({ created_at: row.created_at, id: row.id }),
      (row) => ({ ...row, enabled: row.enabled === 1 }),
      "hosts",
      filterSignature,
    ));
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

app.get("/repositories", async (context) => {
  const params = new URL(context.req.url).searchParams;
  const page = parsePage(params);
  if (page.error !== null) return context.json({ error: page.error }, 400);
  const enabled = parseEnabledFilter(params);
  if (enabled.error) return context.json({ error: "invalid_enabled_filter" }, 400);
  const backendType = params.get("backend_type");
  if (backendType !== null && !BACKEND_TYPES.has(backendType)) {
    return context.json({ error: "invalid_backend_type" }, 400);
  }
  const search = parseSearchFilter(params);
  if (search.error) return context.json({ error: "invalid_search" }, 400);
  const filterSignature = JSON.stringify({ enabled: enabled.value ?? null, backend_type: backendType, q: search.value });
  const cursorResult = decodeCursor(params.get("cursor"), "repositories", filterSignature);
  if (cursorResult.error) return context.json({ error: "invalid_cursor" }, 400);
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (enabled.value !== undefined) {
    clauses.push("r.enabled = ?");
    values.push(enabled.value ? 1 : 0);
  }
  if (backendType !== null) {
    clauses.push("r.backend_type = ?");
    values.push(backendType);
  }
  if (search.value !== null) {
    clauses.push("(r.repository_key LIKE ? ESCAPE '!' OR r.name LIKE ? ESCAPE '!')");
    const pattern = `${escapeLike(search.value)}%`;
    values.push(pattern, pattern);
  }
  if (cursorResult.key !== null) {
    const key = cursorResult.key;
    if (!isRecord(key) || typeof key.repository_key !== "string" || !isValidId(key.id)) {
      return context.json({ error: "invalid_cursor" }, 400);
    }
    clauses.push("(r.repository_key > ? OR (r.repository_key = ? AND r.id > ?))");
    values.push(key.repository_key, key.repository_key, key.id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const result = await context.env.DB.prepare(
      `SELECT r.id, r.repository_key, r.name, r.backend_type, r.enabled, r.created_at,
              (SELECT COUNT(*) FROM job_repositories AS jr WHERE jr.repository_id = r.id) AS jobs_count,
              (SELECT run.status FROM run_repositories AS rr INNER JOIN runs AS run ON run.id = rr.run_id
               WHERE rr.repository_id = r.id ORDER BY run.started_at DESC, run.id DESC LIMIT 1) AS last_run_status,
              (SELECT run.started_at FROM run_repositories AS rr INNER JOIN runs AS run ON run.id = rr.run_id
               WHERE rr.repository_id = r.id ORDER BY run.started_at DESC, run.id DESC LIMIT 1) AS last_run_started_at,
              (SELECT MAX(rs.measured_at) FROM repository_stats AS rs WHERE rs.repository_id = r.id) AS last_measured_at
       FROM repositories AS r ${where}
       ORDER BY r.repository_key ASC, r.id ASC LIMIT ?`,
    )
      .bind(...values, page.limit + 1)
      .all<RepositoryRow>();
    return context.json(makePage(
      result.results,
      page.limit,
      (row) => ({ repository_key: row.repository_key, id: row.id }),
      (row) => ({ ...row, enabled: row.enabled === 1 }),
      "repositories",
      filterSignature,
    ));
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

app.get("/repositories/:repositoryKey/stats", async (context) => {
  const repositoryKey = context.req.param("repositoryKey");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(repositoryKey)) {
    return context.json({ error: "invalid_repository_key" }, 400);
  }
  const params = new URL(context.req.url).searchParams;
  const page = parsePage(params);
  if (page.error !== null) return context.json({ error: page.error }, 400);
  const measurementType = params.get("measurement_type");
  if (measurementType !== null && !MEASUREMENT_TYPES.has(measurementType)) {
    return context.json({ error: "invalid_measurement_type" }, 400);
  }
  const filterSignature = JSON.stringify({ repository_key: repositoryKey, measurement_type: measurementType });
  const cursorResult = decodeCursor(params.get("cursor"), "repository_stats", filterSignature);
  if (cursorResult.error) return context.json({ error: "invalid_cursor" }, 400);
  try {
    const repository = await context.env.DB.prepare(
      "SELECT id, repository_key, name, backend_type, enabled FROM repositories WHERE repository_key = ?",
    )
      .bind(repositoryKey)
      .first<{ id: string; repository_key: string; name: string; backend_type: string; enabled: number }>();
    if (repository === null) return context.json({ error: "not_found" }, 404);

    const clauses = ["repository_id = ?"];
    const values: Array<string | number> = [repository.id];
    if (measurementType !== null) {
      clauses.push("measurement_type = ?");
      values.push(measurementType);
    }
    if (cursorResult.key !== null) {
      const key = cursorResult.key;
      if (!isRecord(key) || !isSafeTimestamp(key.measured_at) || !isValidId(key.id)) {
        return context.json({ error: "invalid_cursor" }, 400);
      }
      clauses.push("(measured_at < ? OR (measured_at = ? AND id < ?))");
      values.push(key.measured_at, key.measured_at, key.id);
    }
    const result = await context.env.DB.prepare(
      `SELECT id, source_run_id, job_id, measurement_type, value_bytes, measured_at, details_json, is_anomalous
       FROM repository_stats WHERE ${clauses.join(" AND ")}
       ORDER BY measured_at DESC, id DESC LIMIT ?`,
    )
      .bind(...values, page.limit + 1)
      .all<RepositoryStatRow>();
    return context.json({
      repository: { ...repository, enabled: repository.enabled === 1 },
      ...makePage(
        result.results,
        page.limit,
        (row) => ({ measured_at: row.measured_at, id: row.id }),
        (row) => ({
          id: row.id,
          source_run_id: row.source_run_id,
          job_id: row.job_id,
          measurement_type: row.measurement_type,
          value_bytes: row.value_bytes,
          measured_at: row.measured_at,
          is_anomalous: row.is_anomalous === 1,
          details: parseJsonObject(row.details_json),
        }),
        "repository_stats",
        filterSignature,
      ),
    });
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

export default app;

async function queryRecentRuns(db: D1Database, filters: RunFilters, limit: number) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  appendRunFilters({ ...filters, status: null }, clauses, values);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db.prepare(`${runSelect} ${where} ORDER BY r.started_at DESC, r.id DESC LIMIT ?`)
    .bind(...values, limit)
    .all<RunRow>();
  return result.results.map((row) => mapRun(row, false));
}

function parseRunFilters(
  params: URLSearchParams,
  includeStatus: boolean,
): { filters: RunFilters; error: string | null } {
  const hostId = params.get("host_id");
  const jobKey = params.get("job_key");
  const repositoryKey = params.get("repository_key");
  const status = params.get("status");
  const operation = params.get("operation");
  if (hostId !== null && (hostId.length < 1 || hostId.length > 128)) {
    return { filters: emptyRunFilters(), error: "invalid_host_id" };
  }
  if (jobKey !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(jobKey)) {
    return { filters: emptyRunFilters(), error: "invalid_job_key" };
  }
  if (repositoryKey !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(repositoryKey)) {
    return { filters: emptyRunFilters(), error: "invalid_repository_key" };
  }
  if (status !== null && (!includeStatus || !RUN_STATUSES.has(status))) {
    return { filters: emptyRunFilters(), error: "invalid_status" };
  }
  if (operation !== null && !OPERATIONS.has(operation)) {
    return { filters: emptyRunFilters(), error: "invalid_operation" };
  }
  return {
    filters: {
      host_id: hostId,
      job_key: jobKey,
      repository_key: repositoryKey,
      status,
      operation,
    },
    error: null,
  };
}

function emptyRunFilters(): RunFilters {
  return { host_id: null, job_key: null, repository_key: null, status: null, operation: null };
}

function appendRunFilters(filters: RunFilters, clauses: string[], values: Array<string | number>) {
  if (filters.host_id !== null) {
    clauses.push("h.id = ?");
    values.push(filters.host_id);
  }
  if (filters.job_key !== null) {
    clauses.push("j.job_key = ?");
    values.push(filters.job_key);
  }
  if (filters.repository_key !== null) {
    clauses.push(`EXISTS (
      SELECT 1 FROM run_repositories AS filter_rr
      INNER JOIN repositories AS filter_repo ON filter_repo.id = filter_rr.repository_id
      WHERE filter_rr.run_id = r.id AND filter_repo.repository_key = ?
    )`);
    values.push(filters.repository_key);
  }
  if (filters.status !== null) {
    clauses.push("r.status = ?");
    values.push(filters.status);
  }
  if (filters.operation !== null) {
    clauses.push("r.operation = ?");
    values.push(filters.operation);
  }
}

function parsePage(params: URLSearchParams): { limit: number; error: string | null } {
  const raw = params.get("limit");
  if (raw === null) return { limit: DEFAULT_PAGE_SIZE, error: null };
  if (!/^\d{1,3}$/.test(raw)) return { limit: DEFAULT_PAGE_SIZE, error: "invalid_limit" };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return { limit: DEFAULT_PAGE_SIZE, error: "invalid_limit" };
  }
  return { limit, error: null };
}

function parseEnabledFilter(params: URLSearchParams): { value: boolean | undefined; error: boolean } {
  const raw = params.get("enabled");
  if (raw === null) return { value: undefined, error: false };
  if (raw === "true") return { value: true, error: false };
  if (raw === "false") return { value: false, error: false };
  return { value: undefined, error: true };
}

function parseSearchFilter(params: URLSearchParams): { value: string | null; error: boolean } {
  const raw = params.get("q");
  if (raw === null || raw.length === 0) return { value: null, error: false };
  if (raw.length > 64) return { value: null, error: true };
  return { value: raw, error: false };
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}

function decodeCursor(
  value: string | null,
  kind: string,
  filterSignature: string,
): { key: unknown | null; error: boolean } {
  if (value === null) return { key: null, error: false };
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return { key: null, error: true };
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isRecord(decoded) ||
      decoded.v !== 1 ||
      decoded.kind !== kind ||
      decoded.filter !== filterSignature ||
      !Object.hasOwn(decoded, "key")
    ) {
      return { key: null, error: true };
    }
    return { key: decoded.key, error: false };
  } catch {
    return { key: null, error: true };
  }
}

function encodeCursor(kind: string, filterSignature: string, key: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, kind, filter: filterSignature, key }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function makePage<T, U, K>(
  rows: T[],
  limit: number,
  cursorKey: (row: T) => K,
  map: (row: T) => U,
  kind: string,
  filterSignature: string,
) {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(map),
    pagination: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore && last !== undefined
        ? encodeCursor(kind, filterSignature, cursorKey(last))
        : null,
    },
  };
}

function mapRun(row: RunRow, includeFullMetrics: boolean) {
  const repositories = parseJsonArray(row.repositories_json);
  const mapped: Record<string, unknown> = {
    id: row.id,
    workflow_id: row.workflow_id,
    operation: row.operation,
    status: row.status,
    exit_code: row.exit_code,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    error_summary: row.error_summary,
    client: {
      name: row.client_name,
      version: row.client_version,
      restic_version: row.restic_version,
    },
    job: { id: row.job_id, key: row.job_key, name: row.job_name },
    host: { id: row.host_id, name: row.host_name, display_name: row.host_display_name },
    repositories,
  };
  if (row.metrics_run_id !== null) {
    mapped.metrics = includeFullMetrics
      ? {
          bytes_processed: row.bytes_processed,
          bytes_added: row.bytes_added,
          bytes_added_packed: row.bytes_added_packed,
          files_new: row.files_new,
          files_changed: row.files_changed,
          files_unmodified: row.files_unmodified,
          snapshot_id: row.snapshot_id,
        }
      : { bytes_added: row.bytes_added, snapshot_id: row.snapshot_id };
  } else {
    mapped.metrics = null;
  }
  return mapped;
}

function parseJsonArray(value: string): Array<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isRecord) as Array<Record<string, string>> : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
