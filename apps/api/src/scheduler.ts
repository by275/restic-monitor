import { Cron } from "croner";
import {
  queueOpenNotifications,
  queueRecoveryNotification,
} from "./notifications";

const MAX_RULES_PER_TICK = 20;
const MAX_RUNNING_JOBS_PER_TICK = 20;
const MAX_OCCURRENCES_PER_RULE_TICK = 20;
const MAX_MATCH_CANDIDATES = 100;

interface ScheduleRule {
  id: string;
  job_id: string;
  host_id: string;
  expression: string;
  timezone: string;
  start_grace_seconds: number;
  enabled: number;
  state_expression: string | null;
  state_timezone: string | null;
  evaluated_through: number | null;
}

interface Occurrence {
  scheduled_for: number;
}

interface CandidateRun {
  id: string;
  started_at: number;
}

interface SlotMatch {
  scheduledFor: number;
  runId: string;
}

interface RunningJob {
  id: string;
  host_id: string;
  max_runtime_seconds: number;
}

export async function runScheduleTick(db: D1Database, scheduledTime: number): Promise<void> {
  const now = Math.max(0, Math.trunc(scheduledTime));
  const rules = await db.prepare(
    `SELECT s.id, s.job_id, j.host_id, s.expression, s.timezone,
            s.start_grace_seconds, s.enabled,
            state.expression AS state_expression, state.timezone AS state_timezone,
            state.evaluated_through
     FROM job_schedule_rules AS s
     INNER JOIN jobs AS j ON j.id = s.job_id
     LEFT JOIN job_schedule_state AS state ON state.schedule_rule_id = s.id
     WHERE s.enabled = 1 AND j.enabled = 1
     ORDER BY COALESCE(state.last_checked_at, 0), s.id LIMIT ?`,
  ).bind(MAX_RULES_PER_TICK).all<ScheduleRule>();

  for (const rule of rules.results) {
    try {
      await reconcileRule(db, rule, now);
    } catch {
      console.error("schedule rule reconciliation failed", { schedule_rule_id: rule.id });
      await touchFailedRule(db, rule, now);
    }
  }

  await reconcileRunningJobs(db, now);
}

export function enumerateDueOccurrences(
  expression: string,
  timezone: string,
  after: number,
  through: number,
  limit = MAX_OCCURRENCES_PER_RULE_TICK,
): number[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9A-Za-z*/,-]+$/.test(field))) {
    throw new Error("schedule must be a five-field standard cron expression");
  }
  const cron = new Cron(expression, { timezone, paused: true, domAndDow: false });
  const result: number[] = [];
  let current = new Date(after);
  try {
    while (result.length < limit) {
      const next = cron.nextRun(current);
      if (next === null || next.getTime() > through) break;
      result.push(next.getTime());
      current = next;
    }
  } finally {
    cron.stop();
  }
  return result;
}

async function reconcileRule(db: D1Database, rule: ScheduleRule, now: number): Promise<void> {
  const sameRule = rule.state_expression === rule.expression && rule.state_timezone === rule.timezone;
  const cursor = sameRule ? rule.evaluated_through ?? now : now;
  let nextCursor = now;
  let due: number[] = [];
  try {
    due = enumerateDueOccurrences(rule.expression, rule.timezone, cursor, now);
    if (due.length === MAX_OCCURRENCES_PER_RULE_TICK) {
      nextCursor = due[due.length - 1]!;
    }
  } catch {
    console.error("invalid cron rule", { schedule_rule_id: rule.id });
    nextCursor = cursor;
  }

  const catchUpPending = due.length === MAX_OCCURRENCES_PER_RULE_TICK;
  const matchThrough = catchUpPending ? nextCursor : now;
  const statements: D1PreparedStatement[] = [];
  if (due.length > 0) {
    const values = due.map(() => "(?, ?, 'pending', ?, ?)").join(", ");
    const bindings = due.flatMap((scheduledFor) => [rule.id, scheduledFor, now, now]);
    statements.push(
      db.prepare(
        `INSERT INTO schedule_occurrences (schedule_rule_id, scheduled_for, state, created_at, updated_at)
         VALUES ${values} ON CONFLICT(schedule_rule_id, scheduled_for) DO NOTHING`,
      ).bind(...bindings),
    );
  }

  const stored = await db.prepare(
    `SELECT scheduled_for FROM schedule_occurrences
     WHERE schedule_rule_id = ? AND state IN ('pending', 'missed') AND matched_run_id IS NULL
     ORDER BY scheduled_for DESC LIMIT ?`,
  ).bind(rule.id, MAX_MATCH_CANDIDATES).all<Occurrence>();
  const times = new Set(stored.results.map((row) => row.scheduled_for));
  for (const scheduledFor of due) times.add(scheduledFor);
  const occurrences = [...times]
    .filter((scheduledFor) => scheduledFor <= matchThrough)
    .sort((a, b) => b - a)
    .slice(0, MAX_MATCH_CANDIDATES);

  if (occurrences.length > 0) {
    const oldest = occurrences[occurrences.length - 1]!;
    const candidates = await db.prepare(
      `SELECT r.id, r.started_at FROM runs AS r
       WHERE r.job_id = ? AND r.started_at >= ? AND r.started_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM schedule_occurrences AS assigned WHERE assigned.matched_run_id = r.id
         )
       ORDER BY r.started_at ASC, r.id ASC LIMIT ?`,
    ).bind(rule.job_id, oldest, matchThrough, MAX_MATCH_CANDIDATES).all<CandidateRun>();

    for (const match of chooseMatches(occurrences, candidates.results)) {
      statements.push(
        db.prepare(
          `UPDATE schedule_occurrences
           SET state = 'matched', matched_run_id = ?, updated_at = ?
           WHERE schedule_rule_id = ? AND scheduled_for = ?
             AND state IN ('pending', 'missed') AND matched_run_id IS NULL`,
        ).bind(match.runId, now, rule.id, match.scheduledFor),
        db.prepare(
          `UPDATE alerts SET status = 'resolved', resolved_at = ?
           WHERE rule_key = 'missed_schedule' AND status = 'open'
             AND schedule_rule_id = ? AND occurrence_scheduled_for = ?`,
        ).bind(now, rule.id, match.scheduledFor),
        queueRecoveryNotification(db, `missed_schedule:${rule.job_id}:${match.scheduledFor}`, now),
      );
    }
  }

  statements.push(
    db.prepare(
      `INSERT INTO alerts (
         id, dedupe_key, rule_key, severity, status, host_id, job_id,
         schedule_rule_id, occurrence_scheduled_for, message, opened_at, created_at
       ) SELECT lower(hex(randomblob(16))),
                'missed_schedule:' || j.id || ':' || o.scheduled_for,
                'missed_schedule', 'warning', 'open', j.host_id, j.id,
                o.schedule_rule_id, o.scheduled_for,
                'Scheduled run did not start within the configured grace period', ?, ?
         FROM schedule_occurrences AS o
         INNER JOIN job_schedule_rules AS s ON s.id = o.schedule_rule_id
         INNER JOIN jobs AS j ON j.id = s.job_id
         WHERE o.schedule_rule_id = ? AND o.state = 'pending' AND o.matched_run_id IS NULL
           AND o.scheduled_for + (s.start_grace_seconds * 1000) <= ?
         ON CONFLICT(dedupe_key) DO NOTHING`,
    ).bind(now, now, rule.id, matchThrough),
    db.prepare(
      `UPDATE schedule_occurrences
       SET state = 'missed', updated_at = ?
       WHERE schedule_rule_id = ? AND state = 'pending' AND matched_run_id IS NULL
         AND scheduled_for + (? * 1000) <= ?`,
    ).bind(now, rule.id, rule.start_grace_seconds, matchThrough),
    db.prepare(
      `INSERT INTO job_schedule_state (
         schedule_rule_id, expression, timezone, evaluated_through, last_checked_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(schedule_rule_id) DO UPDATE SET
         evaluated_through = CASE
           WHEN job_schedule_state.expression = excluded.expression
             AND job_schedule_state.timezone = excluded.timezone
             THEN MAX(job_schedule_state.evaluated_through, excluded.evaluated_through)
           ELSE excluded.evaluated_through END,
         expression = excluded.expression,
         timezone = excluded.timezone,
         last_checked_at = excluded.last_checked_at,
         updated_at = excluded.updated_at`,
    ).bind(rule.id, rule.expression, rule.timezone, nextCursor, now, now),
  );
  await db.batch(statements);
  await queueOpenNotifications(db, rule.job_id, now).run();
}

async function reconcileRunningJobs(db: D1Database, now: number): Promise<void> {
  const jobs = await db.prepare(
    `SELECT DISTINCT j.id, j.host_id, j.max_runtime_seconds
     FROM jobs AS j INNER JOIN runs AS r ON r.job_id = j.id
     WHERE r.status = 'running'
     ORDER BY j.id LIMIT ?`,
  ).bind(MAX_RUNNING_JOBS_PER_TICK).all<RunningJob>();

  for (const job of jobs.results) {
    await db.batch([
      db.prepare(
        `INSERT INTO alerts (
           id, dedupe_key, rule_key, severity, status, host_id, job_id, run_id,
           message, opened_at, created_at
         ) SELECT lower(hex(randomblob(16))), 'run_timeout:' || r.id,
                  'run_timeout', 'critical', 'open', j.host_id, j.id, r.id,
                  'Run exceeded its configured maximum runtime before completion', ?, ?
           FROM runs AS r INNER JOIN jobs AS j ON j.id = r.job_id
           WHERE j.id = ? AND r.status = 'running'
             AND r.started_at + (j.max_runtime_seconds * 1000) <= ?
           ON CONFLICT(dedupe_key) DO NOTHING`,
      ).bind(now, now, job.id, now),
      db.prepare(
        `UPDATE runs
         SET status = 'timed_out',
             finished_at = started_at + (? * 1000),
             duration_ms = ? * 1000,
             error_summary = 'No completion ping arrived before the configured maximum runtime',
             updated_at = ?
         WHERE job_id = ? AND status = 'running'
           AND started_at + (? * 1000) <= ?`,
      ).bind(job.max_runtime_seconds, job.max_runtime_seconds, now, job.id, job.max_runtime_seconds, now),
      queueOpenNotifications(db, job.id, now),
    ]);
  }
}

function chooseMatches(occurrencesDescending: number[], runsAscending: CandidateRun[]): SlotMatch[] {
  const used = new Set<string>();
  const matches: SlotMatch[] = [];
  for (const scheduledFor of occurrencesDescending) {
    const run = runsAscending.find((candidate) => candidate.started_at >= scheduledFor && !used.has(candidate.id));
    if (run !== undefined) {
      used.add(run.id);
      matches.push({ scheduledFor, runId: run.id });
    }
  }
  return matches;
}

async function touchFailedRule(db: D1Database, rule: ScheduleRule, now: number): Promise<void> {
  try {
    const row = await db.prepare(
      "SELECT expression, timezone, evaluated_through FROM job_schedule_state WHERE schedule_rule_id = ?",
    ).bind(rule.id).first<{ expression: string; timezone: string; evaluated_through: number }>();
    const cursor = row?.expression === rule.expression && row.timezone === rule.timezone
      ? row.evaluated_through
      : now;
    await db.prepare(
      `INSERT INTO job_schedule_state (
         schedule_rule_id, expression, timezone, evaluated_through, last_checked_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(schedule_rule_id) DO UPDATE SET
         expression = excluded.expression, timezone = excluded.timezone,
         last_checked_at = excluded.last_checked_at, updated_at = excluded.updated_at`,
    ).bind(rule.id, rule.expression, rule.timezone, cursor, now, now).run();
  } catch {
    // The next Cron tick retries this rule.
  }
}
