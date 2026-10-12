import { Validator, type Schema } from "@cfworker/json-schema";
import { Hono, type Context } from "hono";
import completionSchema from "../../../packages/protocol/schemas/completion-v1.schema.json";
import {
  canonicalJson,
  PING_TOKEN_PATTERN,
  sanitizeErrorSummary,
  sha256Hex,
  UUID_PATTERN,
} from "./security";
import {
  queueOpenNotifications,
  queueRecoveryNotification,
  queueResolvedJobNotifications,
} from "./notifications";
import {
  prepareRepositoryStatsStatements,
  type RepositoryStatsMeasurement,
} from "./repository-stats";

const MAX_BODY_BYTES = 65_536;
const completionValidator = new Validator(completionSchema as unknown as Schema, "2020-12");
const api = new Hono<{ Bindings: Env }>();

type Operation = "backup" | "forget" | "prune" | "forget_prune" | "copy" | "stats" | "check" | "restore";
type RunStatus = "running" | "success" | "partial_success" | "failed" | "timed_out" | "cancelled";

interface PingJob {
  token_id: string;
  job_id: string;
  host_id: string;
  operation: Operation;
  max_runtime_seconds: number;
}

interface RunRow {
  id: string;
  job_id: string;
  operation: Operation;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  start_ping_received: number;
  completion_hash: string | null;
}

interface RepositoryBinding {
  repository_id: string;
  repository_key: string;
  name: string;
  role: "repository" | "source" | "target";
}

interface CompletionBody {
  exit_code: number;
  restic_version?: string;
  error_summary?: string;
  metrics?: {
    bytes_processed?: number | null;
    bytes_added?: number | null;
    bytes_added_packed?: number | null;
    files_new?: number | null;
    files_changed?: number | null;
    files_unmodified?: number | null;
    snapshot_id?: string | null;
  };
  repository_stats?: RepositoryStatsMeasurement;
}

api.post("/:pingToken/runs/:runId/start", async (context) => {
  const runId = context.req.param("runId");
  if (!UUID_PATTERN.test(runId)) return context.json({ error: "invalid_run_id" }, 400);
  const auth = await resolvePingToken(context.req.param("pingToken"), context.env.DB);
  if (auth.kind === "invalid") return context.json({ error: "unauthorized" }, 401);
  if (auth.kind === "unavailable") return context.json({ error: "temporarily_unavailable" }, 503);
  if (context.req.raw.body !== null) {
    const body = await readBody(context.req.raw, 0);
    if (body.kind !== "ok" || body.bytes.byteLength !== 0) {
      return context.json({ error: "start_body_not_allowed" }, 400);
    }
  }
  const { job } = auth;
  const now = Date.now();
  const clientName = normalizeClientName(context.req.header("X-Restic-Monitor-Client"));

  try {
    const prior = await context.env.DB.prepare(
      `SELECT id, job_id, status, started_at, completion_hash FROM runs WHERE id = ?`,
    ).bind(runId).first<Pick<RunRow, "id" | "job_id" | "status" | "started_at" | "completion_hash">>();
    if (prior !== null) {
      if (prior.job_id !== job.job_id) return context.json({ error: "run_id_conflict" }, 409);
      return pingResponse(context, prior.id, prior.status, prior.started_at, true);
    }
    const repositories = await getJobRepositories(context.env.DB, job.job_id);
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO runs (
           id, job_id, operation, status, exit_code, client_name, client_version,
           restic_version, started_at, start_ping_received, finished_at, duration_ms,
           error_summary, completion_hash, created_at, updated_at
         ) VALUES (?, ?, ?, 'running', NULL, ?, 'unknown', NULL, ?, 1, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(runId, job.job_id, job.operation, clientName, now, now, now),
    ];
    for (const repository of repositories) {
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO run_repositories (run_id, repository_id, role)
           SELECT ?, ?, ? FROM runs WHERE id = ? AND job_id = ?
           ON CONFLICT(run_id, repository_id, role) DO NOTHING`,
        ).bind(runId, repository.repository_id, repository.role, runId, job.job_id),
      );
    }
    const batchResults = await context.env.DB.batch(statements);
    const run = await context.env.DB.prepare(
      "SELECT id, job_id, status, started_at, completion_hash FROM runs WHERE id = ?",
    ).bind(runId).first<Pick<RunRow, "id" | "job_id" | "status" | "started_at" | "completion_hash">>();
    if (run === null || run.job_id !== job.job_id) {
      return context.json({ error: "run_id_conflict" }, 409);
    }
    return pingResponse(context, run.id, run.status, run.started_at, batchResults[0]?.meta.changes === 0);
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

api.post("/:pingToken/runs/:runId/complete", async (context) => {
  const runId = context.req.param("runId");
  if (!UUID_PATTERN.test(runId)) return context.json({ error: "invalid_run_id" }, 400);
  const auth = await resolvePingToken(context.req.param("pingToken"), context.env.DB);
  if (auth.kind === "invalid") return context.json({ error: "unauthorized" }, 401);
  if (auth.kind === "unavailable") return context.json({ error: "temporarily_unavailable" }, 503);

  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return context.json({ error: "unsupported_media_type" }, 415);
  const bodyBytes = await readBody(context.req.raw, MAX_BODY_BYTES);
  if (bodyBytes.kind === "too_large") return context.json({ error: "payload_too_large" }, 413);
  if (bodyBytes.kind === "invalid") return context.json({ error: "invalid_body" }, 400);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes.bytes));
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  if (!completionValidator.validate(body).valid) return context.json({ error: "invalid_completion" }, 422);

  const requestBody = body as CompletionBody;
  const safeBody: CompletionBody = {
    exit_code: requestBody.exit_code,
    ...(requestBody.restic_version === undefined ? {} : { restic_version: requestBody.restic_version }),
    ...(requestBody.error_summary === undefined
      ? {}
      : { error_summary: sanitizeErrorSummary(requestBody.error_summary) ?? "" }),
    ...(requestBody.metrics === undefined ? {} : { metrics: requestBody.metrics }),
    ...(requestBody.repository_stats === undefined ? {} : { repository_stats: requestBody.repository_stats }),
  };
  const completionHash = await sha256Hex(canonicalJson(safeBody));
  const now = Date.now();
  const { job } = auth;

  try {
    let run = await context.env.DB.prepare(
      `SELECT id, job_id, operation, status, started_at, finished_at,
              start_ping_received, completion_hash
       FROM runs WHERE id = ?`,
    ).bind(runId).first<RunRow>();
    if (run !== null && run.job_id !== job.job_id) return context.json({ error: "run_id_conflict" }, 409);
    if (run?.completion_hash !== null && run?.completion_hash !== undefined && run.completion_hash !== completionHash) {
      return context.json({ error: "completion_conflict" }, 409);
    }

    const operation = run?.operation ?? job.operation;
    const semanticError = validateCompletionForOperation(safeBody, operation);
    if (semanticError !== null) return context.json({ error: semanticError }, 422);
    if (run === null) {
      run = {
        id: runId,
        job_id: job.job_id,
        operation,
        status: "running",
        started_at: now,
        finished_at: null,
        start_ping_received: 0,
        completion_hash: null,
      };
    }

    let repositories = await getRunRepositories(context.env.DB, runId);
    if (repositories.length === 0) repositories = await getJobRepositories(context.env.DB, job.job_id);
    if (safeBody.repository_stats !== undefined && !repositories.some((repository) => repository.role === "repository")) {
      return context.json({ error: "repository_stats_require_repository" }, 422);
    }

    const terminalStatus = mapExitCode(operation, safeBody.exit_code);
    const startedAt = run.started_at;
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO runs (
           id, job_id, operation, status, exit_code, client_name, client_version,
           restic_version, started_at, start_ping_received, finished_at, duration_ms,
           error_summary, completion_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           exit_code = excluded.exit_code,
           restic_version = COALESCE(excluded.restic_version, runs.restic_version),
           finished_at = excluded.finished_at,
           duration_ms = CASE WHEN runs.start_ping_received = 1
             THEN MAX(0, excluded.finished_at - runs.started_at) ELSE NULL END,
           error_summary = excluded.error_summary,
           completion_hash = excluded.completion_hash,
           updated_at = excluded.updated_at
         WHERE runs.job_id = excluded.job_id AND runs.completion_hash IS NULL`,
      ).bind(
        runId,
        job.job_id,
        operation,
        terminalStatus,
        safeBody.exit_code,
        normalizeClientName(context.req.header("X-Restic-Monitor-Client")),
        safeBody.restic_version ?? null,
        startedAt,
        run.start_ping_received,
        now,
        run.start_ping_received === 1 ? Math.max(0, now - startedAt) : null,
        safeBody.error_summary ?? null,
        completionHash,
        now,
        now,
      ),
    ];
    for (const repository of repositories) {
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO run_repositories (run_id, repository_id, role)
           SELECT ?, ?, ? FROM runs WHERE id = ? AND job_id = ? AND completion_hash = ?
           ON CONFLICT(run_id, repository_id, role) DO NOTHING`,
        ).bind(runId, repository.repository_id, repository.role, runId, job.job_id, completionHash),
      );
    }
    if (safeBody.metrics !== undefined) {
      const metrics = safeBody.metrics;
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO run_metrics (
             run_id, bytes_processed, bytes_added, bytes_added_packed, files_new,
             files_changed, files_unmodified, snapshot_id, metrics_json, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?
             WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND completion_hash = ?)
           ON CONFLICT(run_id) DO UPDATE SET
             bytes_processed = excluded.bytes_processed,
             bytes_added = excluded.bytes_added,
             bytes_added_packed = excluded.bytes_added_packed,
             files_new = excluded.files_new,
             files_changed = excluded.files_changed,
             files_unmodified = excluded.files_unmodified,
             snapshot_id = excluded.snapshot_id,
             updated_at = excluded.updated_at
           WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND completion_hash = ?)`,
        ).bind(
          runId,
          metrics.bytes_processed ?? null,
          metrics.bytes_added ?? null,
          metrics.bytes_added_packed ?? null,
          metrics.files_new ?? null,
          metrics.files_changed ?? null,
          metrics.files_unmodified ?? null,
          metrics.snapshot_id ?? null,
          now,
          runId,
          completionHash,
          runId,
          completionHash,
        ),
      );
    }
    statements.push(
      context.env.DB.prepare(
        `UPDATE alerts SET status = 'resolved', resolved_at = ?
         WHERE rule_key = 'run_timeout' AND status = 'open' AND run_id = ?
           AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND completion_hash = ?)`,
      ).bind(now, runId, runId, completionHash),
      context.env.DB.prepare(
        `INSERT INTO alerts (
           id, dedupe_key, rule_key, severity, status, host_id, job_id, run_id,
           message, opened_at, created_at
         ) SELECT lower(hex(randomblob(16))), 'run_result:' || r.id,
                  'run_result', ?, 'open', j.host_id, j.id, r.id, ?, ?, ?
           FROM runs AS r INNER JOIN jobs AS j ON j.id = r.job_id
           WHERE r.id = ? AND r.completion_hash = ? AND r.status IN ('failed', 'partial_success', 'cancelled')
         ON CONFLICT(dedupe_key) DO NOTHING`,
      ).bind(
        terminalStatus === "partial_success" ? "warning" : "critical",
        resultAlertMessage(terminalStatus, safeBody.exit_code),
        now,
        now,
        runId,
        completionHash,
      ),
      context.env.DB.prepare(
        `UPDATE alerts SET status = 'resolved', resolved_at = ?
         WHERE job_id = ? AND rule_key = 'run_result' AND status = 'open'
           AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND completion_hash = ? AND status = 'success')`,
      ).bind(now, job.job_id, runId, completionHash),
    );
    await context.env.DB.batch(statements);

    const acceptedRun = await context.env.DB.prepare(
      `SELECT id, job_id, operation, status, started_at, finished_at,
              start_ping_received, completion_hash
       FROM runs WHERE id = ?`,
    ).bind(runId).first<RunRow>();
    if (acceptedRun === null || acceptedRun.job_id !== job.job_id) {
      return context.json({ error: "completion_conflict" }, 409);
    }
    if (acceptedRun.completion_hash !== completionHash) {
      return context.json({ error: "completion_conflict" }, 409);
    }

    const notificationStatements = [
      queueRecoveryNotification(context.env.DB, `run_timeout:${runId}`, now),
      queueResolvedJobNotifications(context.env.DB, job.job_id, now, "run_result"),
    ];
    if (terminalStatus !== "success") notificationStatements.push(queueOpenNotifications(context.env.DB, job.job_id, now));
    await context.env.DB.batch(notificationStatements);

    if (safeBody.repository_stats !== undefined && terminalStatus === "success") {
      const repository = repositories.find((item) => item.role === "repository");
      if (repository !== undefined) {
        const statsStatements = await prepareRepositoryStatsStatements(context.env.DB, {
          jobId: job.job_id,
          hostId: job.host_id,
          repositoryId: repository.repository_id,
          repositoryKey: repository.repository_key,
          runId,
          measuredAt: acceptedRun.finished_at ?? now,
          receivedAt: now,
          measurement: safeBody.repository_stats,
        });
        await context.env.DB.batch(statsStatements);
      }
    }

    return pingResponse(
      context,
      runId,
      acceptedRun.status,
      acceptedRun.finished_at ?? now,
      run !== null && run.completion_hash !== null,
    );
  } catch {
    return context.json({ error: "temporarily_unavailable" }, 503);
  }
});

async function resolvePingToken(token: string, db: D1Database): Promise<
  | { kind: "authorized"; job: PingJob }
  | { kind: "invalid" }
  | { kind: "unavailable" }
> {
  if (!PING_TOKEN_PATTERN.test(token)) return { kind: "invalid" };
  try {
    const tokenHash = await sha256Hex(token);
    const job = await db.prepare(
      `SELECT t.id AS token_id, j.id AS job_id, j.host_id, j.operation, j.max_runtime_seconds
       FROM job_ping_tokens AS t
       INNER JOIN jobs AS j ON j.id = t.job_id
       INNER JOIN hosts AS h ON h.id = j.host_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND j.enabled = 1 AND h.enabled = 1`,
    ).bind(tokenHash).first<PingJob>();
    return job === null ? { kind: "invalid" } : { kind: "authorized", job };
  } catch {
    return { kind: "unavailable" };
  }
}

async function getJobRepositories(db: D1Database, jobId: string): Promise<RepositoryBinding[]> {
  const result = await db.prepare(
    `SELECT r.id AS repository_id, r.repository_key, r.name, jr.role
     FROM job_repositories AS jr INNER JOIN repositories AS r ON r.id = jr.repository_id
     WHERE jr.job_id = ? AND r.enabled = 1 ORDER BY jr.role, r.id`,
  ).bind(jobId).all<RepositoryBinding>();
  return result.results;
}

async function getRunRepositories(db: D1Database, runId: string): Promise<RepositoryBinding[]> {
  const result = await db.prepare(
    `SELECT r.id AS repository_id, r.repository_key, r.name, rr.role
     FROM run_repositories AS rr INNER JOIN repositories AS r ON r.id = rr.repository_id
     WHERE rr.run_id = ? ORDER BY rr.role, r.id`,
  ).bind(runId).all<RepositoryBinding>();
  return result.results;
}

function validateCompletionForOperation(body: CompletionBody, operation: Operation): string | null {
  if (body.metrics !== undefined && operation !== "backup") return "metrics_not_supported_for_operation";
  if (body.repository_stats !== undefined && operation !== "stats") return "repository_stats_not_supported_for_operation";
  if (body.repository_stats !== undefined && body.exit_code !== 0) return "repository_stats_require_success";
  return null;
}

async function readBody(request: Request, limit: number): Promise<
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "too_large" }
  | { kind: "invalid" }
> {
  if (request.body === null) return { kind: "ok", bytes: new Uint8Array() };
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
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

function normalizeClientName(value: string | undefined): string {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 128);
  return normalized || "unknown";
}

function mapExitCode(operation: Operation, exitCode: number): RunStatus {
  if (exitCode === 0) return "success";
  if (exitCode === 3 && ["backup", "forget", "forget_prune"].includes(operation)) return "partial_success";
  if (exitCode === 130) return "cancelled";
  return "failed";
}

function resultAlertMessage(status: RunStatus, exitCode: number): string {
  const label = status === "partial_success" ? "partially succeeded" : status === "cancelled" ? "was cancelled" : "failed";
  return `Restic Job ${label} (exit code ${exitCode})`;
}

function pingResponse(
  context: Context<{ Bindings: Env }>,
  runId: string,
  status: RunStatus,
  receivedAt: number,
  duplicate: boolean,
) {
  return context.json({
    run_id: runId,
    accepted: true,
    duplicate,
    status,
    received_at: new Date(receivedAt).toISOString(),
  });
}

export default api;
