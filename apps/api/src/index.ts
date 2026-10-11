import { Validator, type Schema } from "@cfworker/json-schema";
import { Hono, type Context } from "hono";
import eventSchema from "../../../packages/protocol/schemas/event-v1.schema.json";
import readApi from "./read";
import { runScheduleTick } from "./scheduler";

const app = new Hono<{ Bindings: Env }>();
const eventValidator = new Validator(eventSchema as unknown as Schema, "2020-12");
const MAX_BODY_BYTES = 65_536;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TIMESTAMP_TOLERANCE_MS = 1000;
const TOKEN_PATTERN = /^rm1_[A-Za-z0-9_-]{43}$/;
const BACKUP_METRIC_KEYS = new Set([
  "bytes_processed",
  "bytes_added",
  "bytes_added_packed",
  "files_new",
  "files_changed",
  "files_unmodified",
  "snapshot_id",
]);

type Operation =
  | "backup"
  | "forget"
  | "prune"
  | "forget_prune"
  | "copy"
  | "stats"
  | "check"
  | "restore";

interface EventMetrics {
  bytes_processed?: number | null;
  bytes_added?: number | null;
  bytes_added_packed?: number | null;
  files_new?: number | null;
  files_changed?: number | null;
  files_unmodified?: number | null;
  snapshot_id?: string | null;
}

interface RunResult {
  exit_code: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error_summary?: string;
  metrics?: EventMetrics;
}

interface EventBase {
  schema_version: 1;
  event_id: string;
  run_id: string;
  workflow_id?: string;
  occurred_at: string;
  job_key: string;
  repository_key: string;
  source_repository_key?: string;
  operation: Operation;
  client: {
    name: string;
    version: string;
    restic_version?: string;
  };
}

type RunEvent =
  | (EventBase & { event_type: "run.started"; result?: never })
  | (EventBase & { event_type: "run.completed"; result: RunResult });

type CompletedEvent = Extract<RunEvent, { event_type: "run.completed" }>;
type AppContext = Context<{ Bindings: Env }>;

interface TokenRecord {
  id: string;
  host_id: string;
  scopes_json: string;
}

interface ExistingEvent {
  payload_hash: string;
  received_at: number;
}

interface ExistingRun {
  job_id: string;
  workflow_id: string | null;
  operation: string;
  client_name: string;
  client_version: string;
  restic_version: string | null;
  completion_fingerprint: string | null;
}

interface RepositoryBinding {
  role: "repository" | "source" | "target";
  repository_id: string;
}

interface AuthorizedEventContext {
  job_id: string;
  repositories: RepositoryBinding[];
}

app.get("/healthz", (context) =>
  context.json({
    ok: true,
    service: "restic-monitor",
  }),
);

app.route("/api/v1/read", readApi);

app.post("/api/v1/ingest/events", async (context) => {
  const now = Date.now();
  const authorization = await authenticate(context.req.header("Authorization"), context.env.DB, now);
  if (authorization.kind === "invalid") {
    return context.json({ error: "unauthorized" }, 401);
  }
  if (authorization.kind === "forbidden") {
    return context.json({ error: "forbidden" }, 403);
  }
  if (authorization.kind === "unavailable") {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }

  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return context.json({ error: "unsupported_media_type" }, 415);
  }

  const declaredLength = context.req.header("Content-Length");
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_BODY_BYTES) {
      return context.json({ error: "payload_too_large" }, 413);
    }
  }

  let bodyBytes: Uint8Array;
  try {
    bodyBytes = await readLimitedBody(context.req.raw, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return context.json({ error: "payload_too_large" }, 413);
    }
    return context.json({ error: "invalid_body" }, 400);
  }

  let rawBody: string;
  let parsedBody: unknown;
  try {
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    parsedBody = JSON.parse(rawBody);
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }

  if (!eventValidator.validate(parsedBody).valid) {
    return context.json({ error: "invalid_event" }, 422);
  }

  const event = parsedBody as RunEvent;
  const semanticError = validateEventSemantics(event, now);
  if (semanticError !== null) {
    return context.json({ error: semanticError }, 422);
  }

  let payloadHash: string;
  try {
    payloadHash = await sha256Hex(bodyBytes);
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }

  try {
    const prior = await context.env.DB.prepare(
      "SELECT payload_hash, received_at FROM ingest_events WHERE token_id = ? AND event_id = ?",
    )
      .bind(authorization.token.id, event.event_id)
      .first<ExistingEvent>();

    if (prior !== null) {
      if (prior.payload_hash !== payloadHash) {
        return context.json({ error: "event_id_conflict" }, 409);
      }
      return acceptedResponse(context, event.event_id, prior.received_at, true);
    }
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }

  let authorizedContext: AuthorizedEventContext;
  try {
    const result = await authorizeEvent(event, authorization.token.host_id, context.env.DB);
    if (result === null) {
      return context.json({ error: "event_scope_forbidden" }, 403);
    }
    authorizedContext = result;
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }

  const receivedAt = Date.now();
  const startAt = event.event_type === "run.completed"
    ? parseUtcDateTime(event.result.started_at)
    : parseUtcDateTime(event.occurred_at);
  const finishAt = event.event_type === "run.completed"
    ? parseUtcDateTime(event.result.finished_at)
    : null;
  const errorSummary = event.event_type === "run.completed"
    ? sanitizeErrorSummary(event.result.error_summary)
    : null;

  let completionFingerprint: string | null = null;
  if (event.event_type === "run.completed") {
    try {
      completionFingerprint = await createCompletionFingerprint(
        event,
        authorizedContext,
        errorSummary,
      );
    } catch {
      return context.json({ error: "temporarily_unavailable" }, 503);
    }
  }

  const terminalStatus = event.event_type === "run.completed"
    ? mapExitCode(event.operation, event.result.exit_code)
    : null;
  const resultMetrics = event.event_type === "run.completed" ? event.result.metrics : undefined;
  const statements = [
    context.env.DB.prepare(
      `INSERT INTO ingest_events (token_id, event_id, run_id, event_type, payload_hash, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      authorization.token.id,
      event.event_id,
      event.run_id,
      event.event_type,
      payloadHash,
      receivedAt,
    ),
    context.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .bind(receivedAt, authorization.token.id),
    context.env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, workflow_id, operation, status, exit_code, client_name,
         client_version, restic_version, started_at, finished_at, duration_ms,
         error_summary, completion_fingerprint, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         job_id = excluded.job_id,
         workflow_id = excluded.workflow_id,
         operation = excluded.operation,
         client_name = excluded.client_name,
         client_version = excluded.client_version,
         restic_version = excluded.restic_version,
         status = CASE
           WHEN runs.completion_fingerprint IS NULL AND excluded.completion_fingerprint IS NOT NULL
             THEN excluded.status ELSE runs.status END,
         exit_code = CASE
           WHEN runs.completion_fingerprint IS NULL AND excluded.completion_fingerprint IS NOT NULL
             THEN excluded.exit_code ELSE runs.exit_code END,
         started_at = CASE
           WHEN runs.completion_fingerprint IS NULL AND excluded.completion_fingerprint IS NOT NULL
             THEN excluded.started_at ELSE runs.started_at END,
         finished_at = CASE
           WHEN runs.completion_fingerprint IS NULL AND excluded.completion_fingerprint IS NOT NULL
             THEN excluded.finished_at ELSE runs.finished_at END,
         duration_ms = CASE
           WHEN runs.completion_fingerprint IS NULL AND excluded.completion_fingerprint IS NOT NULL
             THEN excluded.duration_ms ELSE runs.duration_ms END,
         error_summary = CASE
           WHEN runs.completion_fingerprint IS NULL AND excluded.completion_fingerprint IS NOT NULL
             THEN excluded.error_summary ELSE runs.error_summary END,
         completion_fingerprint = CASE
           WHEN runs.completion_fingerprint IS NOT NULL AND excluded.completion_fingerprint IS NOT NULL
             THEN excluded.completion_fingerprint
           ELSE COALESCE(runs.completion_fingerprint, excluded.completion_fingerprint) END,
         updated_at = excluded.updated_at`,
    ).bind(
      event.run_id,
      authorizedContext.job_id,
      event.workflow_id ?? null,
      event.operation,
      terminalStatus ?? "running",
      event.event_type === "run.completed" ? event.result.exit_code : null,
      event.client.name,
      event.client.version,
      event.client.restic_version ?? null,
      startAt,
      finishAt,
      event.event_type === "run.completed" ? event.result.duration_ms : null,
      errorSummary,
      completionFingerprint,
      receivedAt,
      receivedAt,
    ),
    ...authorizedContext.repositories.map(({ role, repository_id }) =>
      context.env.DB.prepare(
        "INSERT INTO run_repositories (run_id, repository_id, role) VALUES (?, ?, ?) ON CONFLICT(run_id, repository_id, role) DO NOTHING",
      ).bind(event.run_id, repository_id, role),
    ),
  ];

  if (event.event_type === "run.completed") {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO run_metrics (
           run_id, bytes_processed, bytes_added, bytes_added_packed, files_new,
           files_changed, files_unmodified, snapshot_id, metrics_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
         ON CONFLICT(run_id) DO UPDATE SET
           bytes_processed = excluded.bytes_processed,
           bytes_added = excluded.bytes_added,
           bytes_added_packed = excluded.bytes_added_packed,
           files_new = excluded.files_new,
           files_changed = excluded.files_changed,
           files_unmodified = excluded.files_unmodified,
           snapshot_id = excluded.snapshot_id,
           metrics_json = excluded.metrics_json,
           updated_at = excluded.updated_at`,
      ).bind(
        event.run_id,
        resultMetrics?.bytes_processed ?? null,
        resultMetrics?.bytes_added ?? null,
        resultMetrics?.bytes_added_packed ?? null,
        resultMetrics?.files_new ?? null,
        resultMetrics?.files_changed ?? null,
        resultMetrics?.files_unmodified ?? null,
        resultMetrics?.snapshot_id ?? null,
        receivedAt,
      ),
      context.env.DB.prepare(
        `UPDATE alerts SET status = 'resolved', resolved_at = ?
         WHERE rule_key = 'run_timeout' AND status = 'open' AND run_id = ?`,
      ).bind(receivedAt, event.run_id),
    );
  }

  try {
    await context.env.DB.batch(statements);
    return acceptedResponse(context, event.event_id, receivedAt, false);
  } catch {
    try {
      const prior = await context.env.DB.prepare(
        "SELECT payload_hash, received_at FROM ingest_events WHERE token_id = ? AND event_id = ?",
      )
        .bind(authorization.token.id, event.event_id)
        .first<ExistingEvent>();
      if (prior !== null) {
        if (prior.payload_hash === payloadHash) {
          return acceptedResponse(context, event.event_id, prior.received_at, true);
        }
        return context.json({ error: "event_id_conflict" }, 409);
      }

      if (await isRunConflict(event, authorizedContext, completionFingerprint, context.env.DB)) {
        return context.json({ error: "run_conflict" }, 409);
      }
    } catch {
      return context.json({ error: "temporarily_unavailable" }, 503);
    }
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

app.notFound((context) => context.json({ error: "not_found" }, 404));

export default {
  fetch: (request: Request, env: Env, context: ExecutionContext) => app.fetch(request, env, context),
  scheduled: async (_controller: ScheduledController, env: Env, _context: ExecutionContext) => {
    await runScheduleTick(env.DB, Date.now());
  },
};

async function authenticate(
  authorizationHeader: string | undefined,
  db: D1Database,
  now: number,
): Promise<
  | { kind: "invalid" }
  | { kind: "forbidden" }
  | { kind: "unavailable" }
  | { kind: "authorized"; token: TokenRecord }
> {
  const match = authorizationHeader?.match(/^Bearer (.+)$/i);
  const tokenValue = match?.[1];
  if (tokenValue === undefined || !TOKEN_PATTERN.test(tokenValue)) {
    return { kind: "invalid" };
  }

  try {
    const tokenHash = await sha256Hex(new TextEncoder().encode(tokenValue));
    const token = await db.prepare(
      `SELECT t.id, t.host_id, t.scopes_json
       FROM api_tokens AS t
       INNER JOIN hosts AS h ON h.id = t.host_id
       WHERE t.token_hash = ? AND t.token_prefix = 'rm1_' AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > ?) AND h.enabled = 1`,
    )
      .bind(tokenHash, now)
      .first<TokenRecord>();
    if (token === null) {
      return { kind: "invalid" };
    }

    let scopes: unknown;
    try {
      scopes = JSON.parse(token.scopes_json);
    } catch {
      return { kind: "forbidden" };
    }
    if (!Array.isArray(scopes) || !scopes.includes("ingest")) {
      return { kind: "forbidden" };
    }
    return { kind: "authorized", token };
  } catch {
    return { kind: "unavailable" };
  }
}

async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (request.body === null) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

class BodyTooLargeError extends Error {}

function validateEventSemantics(event: RunEvent, now: number): string | null {
  const occurredAt = parseUtcDateTime(event.occurred_at);
  if (occurredAt === null) return "invalid_event_time";
  if (occurredAt > now + FUTURE_SKEW_MS) return "future_event_time";

  if (event.event_type === "run.started") {
    return null;
  }

  if (
    event.operation !== "backup" &&
    event.result.metrics !== undefined &&
    Object.keys(event.result.metrics).some((key) => BACKUP_METRIC_KEYS.has(key))
  ) {
    return "metrics_not_supported_for_operation";
  }

  const startedAt = parseUtcDateTime(event.result.started_at);
  const finishedAt = parseUtcDateTime(event.result.finished_at);
  if (startedAt === null || finishedAt === null) return "invalid_run_time";
  if (startedAt > now + FUTURE_SKEW_MS || finishedAt > now + FUTURE_SKEW_MS) {
    return "future_run_time";
  }
  if (startedAt > finishedAt) return "invalid_run_time_order";
  if (Math.abs((finishedAt - startedAt) - event.result.duration_ms) > TIMESTAMP_TOLERANCE_MS) {
    return "duration_mismatch";
  }
  if (Math.abs(occurredAt - finishedAt) > TIMESTAMP_TOLERANCE_MS) {
    return "event_time_mismatch";
  }
  return null;
}

function parseUtcDateTime(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function authorizeEvent(
  event: RunEvent,
  hostId: string,
  db: D1Database,
): Promise<AuthorizedEventContext | null> {
  const job = await db.prepare(
    "SELECT id FROM jobs WHERE host_id = ? AND job_key = ? AND enabled = 1",
  )
    .bind(hostId, event.job_key)
    .first<{ id: string }>();
  if (job === null) return null;

  if (event.operation === "copy") {
    if (event.source_repository_key === event.repository_key) return null;
    const source = await findAllowedRepository(db, job.id, event.source_repository_key!, "source");
    const target = await findAllowedRepository(db, job.id, event.repository_key, "target");
    if (source === null || target === null) return null;
    return {
      job_id: job.id,
      repositories: [
        { role: "source", repository_id: source.id },
        { role: "target", repository_id: target.id },
      ],
    };
  }

  const repository = await findAllowedRepository(db, job.id, event.repository_key, "repository");
  if (repository === null) return null;
  return {
    job_id: job.id,
    repositories: [{ role: "repository", repository_id: repository.id }],
  };
}

async function findAllowedRepository(
  db: D1Database,
  jobId: string,
  repositoryKey: string,
  role: RepositoryBinding["role"],
): Promise<{ id: string } | null> {
  return db.prepare(
    `SELECT r.id
     FROM repositories AS r
     INNER JOIN job_repositories AS jr ON jr.repository_id = r.id
     WHERE jr.job_id = ? AND jr.role = ? AND r.repository_key = ? AND r.enabled = 1`,
  )
    .bind(jobId, role, repositoryKey)
    .first<{ id: string }>();
}

async function createCompletionFingerprint(
  event: CompletedEvent,
  context: AuthorizedEventContext,
  errorSummary: string | null,
): Promise<string> {
  const metrics = event.result.metrics;
  const fingerprintValue = {
    job_id: context.job_id,
    run_id: event.run_id,
    workflow_id: event.workflow_id ?? null,
    operation: event.operation,
    client: {
      name: event.client.name,
      version: event.client.version,
      restic_version: event.client.restic_version ?? null,
    },
    repositories: context.repositories,
    result: {
      exit_code: event.result.exit_code,
      started_at: event.result.started_at,
      finished_at: event.result.finished_at,
      duration_ms: event.result.duration_ms,
      error_summary: errorSummary,
      metrics: metrics === undefined
        ? null
        : {
            bytes_processed: metrics.bytes_processed ?? null,
            bytes_added: metrics.bytes_added ?? null,
            bytes_added_packed: metrics.bytes_added_packed ?? null,
            files_new: metrics.files_new ?? null,
            files_changed: metrics.files_changed ?? null,
            files_unmodified: metrics.files_unmodified ?? null,
            snapshot_id: metrics.snapshot_id ?? null,
          },
    },
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify(fingerprintValue)));
}

function sanitizeErrorSummary(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  return value
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\b(password|passwd|token|secret|api[_-]?key|access[_-]?key|authorization)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:https?|s3|gs|azure|b2|rest|sftp):\/\/[^\s]+/gi, "[URL]")
    .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s]*/g, "[PATH]")
    .replace(/(^|[\s=(])\/(?:[^\s/]+\/)*[^\s,;)]*/g, "$1[PATH]")
    .slice(0, 1024);
}

function mapExitCode(operation: Operation, exitCode: number):
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled" {
  if (exitCode === 0) return "success";
  if (exitCode === 3 && ["backup", "forget", "forget_prune"].includes(operation)) {
    return "partial_success";
  }
  if (exitCode === 130) return "cancelled";
  return "failed";
}

async function isRunConflict(
  event: RunEvent,
  authorized: AuthorizedEventContext,
  incomingFingerprint: string | null,
  db: D1Database,
): Promise<boolean> {
  const existing = await db.prepare(
    `SELECT job_id, workflow_id, operation, client_name, client_version,
            restic_version, completion_fingerprint
     FROM runs WHERE id = ?`,
  )
    .bind(event.run_id)
    .first<ExistingRun>();
  if (existing === null) return false;

  if (
    existing.job_id !== authorized.job_id ||
    existing.workflow_id !== (event.workflow_id ?? null) ||
    existing.operation !== event.operation ||
    existing.client_name !== event.client.name ||
    existing.client_version !== event.client.version ||
    existing.restic_version !== (event.client.restic_version ?? null) ||
    (existing.completion_fingerprint !== null && incomingFingerprint !== null &&
      existing.completion_fingerprint !== incomingFingerprint)
  ) {
    return true;
  }

  const existingRepositories = await db.prepare(
    "SELECT repository_id, role FROM run_repositories WHERE run_id = ?",
  )
    .bind(event.run_id)
    .all<RepositoryBinding>();
  return existingRepositories.results.some((existingRepository) =>
    authorized.repositories.some((incoming) =>
      incoming.role === existingRepository.role && incoming.repository_id !== existingRepository.repository_id
    ),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function acceptedResponse(
  context: AppContext,
  eventId: string,
  receivedAt: number,
  duplicate: boolean,
) {
  return context.json({
    event_id: eventId,
    accepted: true,
    duplicate,
    received_at: new Date(receivedAt).toISOString(),
  });
}
