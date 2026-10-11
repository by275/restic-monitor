import { Cron } from "croner";
import { queueOpenNotifications, queueRecoveryNotification } from "./notifications";

const MAX_JOBS_PER_TICK = 20;
const MAX_OCCURRENCES_PER_JOB_TICK = 20;
const MAX_MATCH_CANDIDATES = 100;

interface ScheduleJob {
  id: string;
  host_id: string;
  schedule: string;
  timezone: string;
  grace_seconds: number;
  timeout_seconds: number;
  enabled: number;
  state_schedule: string | null;
  state_timezone: string | null;
  evaluated_through: number | null;
}

interface ScheduleOccurrence {
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

/**
 * Reconciles a bounded number of jobs. Per-job state, generated slots, matches,
 * missed/timeout alerts, and cursor movement commit in one D1 batch.
 */
export async function runScheduleTick(db: D1Database, scheduledTime: number): Promise<void> {
  const now = Math.max(0, Math.trunc(scheduledTime));
  const jobs = await db.prepare(
    `SELECT j.id, j.host_id, j.schedule, j.timezone, j.grace_seconds,
            j.timeout_seconds, j.enabled,
            s.schedule AS state_schedule, s.timezone AS state_timezone,
            s.evaluated_through
     FROM jobs AS j
     LEFT JOIN job_schedule_state AS s ON s.job_id = j.id
     ORDER BY COALESCE(s.last_checked_at, 0) ASC, j.id ASC
     LIMIT ?`,
  )
    .bind(MAX_JOBS_PER_TICK)
    .all<ScheduleJob>();

  for (const job of jobs.results) {
    try {
      await reconcileJob(db, job, now);
    } catch {
      console.error("schedule reconciliation failed", { job_id: job.id });
      await touchFailedJob(db, job, now);
    }
  }
}

/**
 * Returns cron instants strictly after `after` and no later than `through`.
 * A full page intentionally leaves the cursor at its last slot for catch-up.
 */
export function enumerateDueOccurrences(
  schedule: string,
  timezone: string,
  after: number,
  through: number,
  limit = MAX_OCCURRENCES_PER_JOB_TICK,
): number[] {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9A-Za-z*/,-]+$/.test(field))) {
    throw new Error("schedule must be a five-field standard cron expression");
  }

  const cron = new Cron(schedule, { timezone, paused: true, domAndDow: false });
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

async function reconcileJob(db: D1Database, job: ScheduleJob, now: number): Promise<void> {
  const sameSchedule = job.state_schedule === job.schedule && job.state_timezone === job.timezone;
  const previousCursor = sameSchedule ? job.evaluated_through : null;
  const cursor = previousCursor ?? now;
  let newOccurrences: number[] = [];
  let nextCursor = now;

  if (job.enabled === 1) {
    try {
      newOccurrences = enumerateDueOccurrences(
        job.schedule,
        job.timezone,
        cursor,
        now,
      );
      if (newOccurrences.length === MAX_OCCURRENCES_PER_JOB_TICK) {
        nextCursor = newOccurrences[newOccurrences.length - 1];
      }
    } catch {
      console.error("invalid job schedule", { job_id: job.id });
      nextCursor = cursor;
    }
  }

  const catchUpPending = newOccurrences.length === MAX_OCCURRENCES_PER_JOB_TICK;
  const matchThrough = catchUpPending ? nextCursor : now;
  const statements: D1PreparedStatement[] = [];

  if (newOccurrences.length > 0) {
    const values = newOccurrences.map(() => "(?, ?, 'pending', ?, ?)").join(", ");
    const bindings = newOccurrences.flatMap((scheduledFor) => [job.id, scheduledFor, now, now]);
    statements.push(
      db.prepare(
        `INSERT INTO schedule_occurrences (job_id, scheduled_for, state, created_at, updated_at)
         VALUES ${values} ON CONFLICT(job_id, scheduled_for) DO NOTHING`,
      ).bind(...bindings),
    );
  }

  if (job.enabled === 1) {
    const existing = await db.prepare(
      `SELECT scheduled_for FROM schedule_occurrences
       WHERE job_id = ? AND state IN ('pending', 'missed') AND matched_run_id IS NULL
       ORDER BY scheduled_for DESC LIMIT ?`,
    )
      .bind(job.id, MAX_MATCH_CANDIDATES)
      .all<ScheduleOccurrence>();

    const occurrenceTimes = new Set(existing.results.map((row) => row.scheduled_for));
    for (const scheduledFor of newOccurrences) occurrenceTimes.add(scheduledFor);
    const occurrences = [...occurrenceTimes]
      .filter((scheduledFor) => scheduledFor <= matchThrough)
      .sort((left, right) => right - left)
      .slice(0, MAX_MATCH_CANDIDATES);

    if (occurrences.length > 0) {
      const oldestOccurrence = occurrences[occurrences.length - 1];
      const candidateResult = await db.prepare(
        `SELECT r.id, r.started_at FROM runs AS r
         WHERE r.job_id = ? AND r.started_at >= ? AND r.started_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM schedule_occurrences AS assigned
             WHERE assigned.matched_run_id = r.id
           )
         ORDER BY r.started_at ASC, r.id ASC LIMIT ?`,
      )
        .bind(job.id, oldestOccurrence, matchThrough, MAX_MATCH_CANDIDATES)
        .all<CandidateRun>();

      const matches = chooseMatches(occurrences, candidateResult.results);
      for (const match of matches) {
        statements.push(
          db.prepare(
            `UPDATE schedule_occurrences
             SET state = 'matched', matched_run_id = ?, updated_at = ?
             WHERE job_id = ? AND scheduled_for = ? AND state IN ('pending', 'missed')
               AND matched_run_id IS NULL`,
          ).bind(match.runId, now, job.id, match.scheduledFor),
          db.prepare(
            `UPDATE alerts SET status = 'resolved', resolved_at = ?
             WHERE rule_key = 'missed_schedule' AND status = 'open'
               AND occurrence_job_id = ? AND occurrence_scheduled_for = ?`,
          ).bind(now, job.id, match.scheduledFor),
          queueRecoveryNotification(
            db,
            `missed_schedule:${job.id}:${match.scheduledFor}`,
            now,
          ),
        );
      }
    }

    statements.push(
      db.prepare(
        `INSERT INTO alerts (
           id, dedupe_key, rule_key, severity, status, host_id, job_id, run_id,
           occurrence_job_id, occurrence_scheduled_for, message, opened_at, resolved_at, created_at
         )
         SELECT lower(hex(randomblob(16))),
                'missed_schedule:' || o.job_id || ':' || o.scheduled_for,
                'missed_schedule', 'warning', 'open', j.host_id, j.id, NULL,
                o.job_id, o.scheduled_for,
                'Scheduled run did not start within the configured grace period',
                ?, NULL, ?
         FROM schedule_occurrences AS o
         INNER JOIN jobs AS j ON j.id = o.job_id
         WHERE o.job_id = ? AND o.state = 'pending' AND o.matched_run_id IS NULL
           AND o.scheduled_for + (j.grace_seconds * 1000) <= ?
         ON CONFLICT(dedupe_key) DO NOTHING`,
      ).bind(now, now, job.id, matchThrough),
      db.prepare(
        `UPDATE schedule_occurrences
         SET state = 'missed', updated_at = ?
         WHERE job_id = ? AND state = 'pending' AND matched_run_id IS NULL
           AND scheduled_for + (? * 1000) <= ?`,
      ).bind(now, job.id, job.grace_seconds, matchThrough),
    );
  }

  statements.push(
    db.prepare(
      `INSERT INTO alerts (
         id, dedupe_key, rule_key, severity, status, host_id, job_id, run_id,
         occurrence_job_id, occurrence_scheduled_for, message, opened_at, resolved_at, created_at
       )
       SELECT lower(hex(randomblob(16))), 'run_timeout:' || r.id,
              'run_timeout', 'critical', 'open', j.host_id, j.id, r.id,
              NULL, NULL,
              'Run exceeded its configured timeout before a completion event arrived',
              ?, NULL, ?
       FROM runs AS r INNER JOIN jobs AS j ON j.id = r.job_id
       WHERE r.job_id = ? AND r.status = 'running'
         AND r.started_at + (j.timeout_seconds * 1000) <= ?
       ON CONFLICT(dedupe_key) DO NOTHING`,
    ).bind(now, now, job.id, now),
    queueOpenNotifications(db, job.id, now),
    db.prepare(
      `UPDATE runs
       SET status = 'timed_out',
           finished_at = started_at + (? * 1000),
           duration_ms = ? * 1000,
           error_summary = 'No completion event was received before the configured timeout',
           updated_at = ?
       WHERE job_id = ? AND status = 'running'
         AND started_at + (? * 1000) <= ?`,
    ).bind(job.timeout_seconds, job.timeout_seconds, now, job.id, job.timeout_seconds, now),
    db.prepare(
      `INSERT INTO job_schedule_state (
         job_id, schedule, timezone, evaluated_through, last_checked_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         evaluated_through = CASE
           WHEN job_schedule_state.schedule = excluded.schedule
             AND job_schedule_state.timezone = excluded.timezone
             THEN MAX(job_schedule_state.evaluated_through, excluded.evaluated_through)
           ELSE excluded.evaluated_through END,
         schedule = excluded.schedule,
         timezone = excluded.timezone,
         last_checked_at = excluded.last_checked_at,
         updated_at = excluded.updated_at`,
    ).bind(job.id, job.schedule, job.timezone, nextCursor, now, now),
  );

  await db.batch(statements);
}

function chooseMatches(occurrencesDescending: number[], runsAscending: CandidateRun[]): SlotMatch[] {
  const usedRunIds = new Set<string>();
  const matches: SlotMatch[] = [];

  for (const scheduledFor of occurrencesDescending) {
    const run = runsAscending.find(
      (candidate) => candidate.started_at >= scheduledFor && !usedRunIds.has(candidate.id),
    );
    if (run !== undefined) {
      usedRunIds.add(run.id);
      matches.push({ scheduledFor, runId: run.id });
    }
  }
  return matches;
}

async function touchFailedJob(db: D1Database, job: ScheduleJob, now: number): Promise<void> {
  try {
    const sameSchedule = job.state_schedule === job.schedule && job.state_timezone === job.timezone;
    await db.prepare(
      `INSERT INTO job_schedule_state (
         job_id, schedule, timezone, evaluated_through, last_checked_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         evaluated_through = CASE
           WHEN job_schedule_state.schedule = excluded.schedule
             AND job_schedule_state.timezone = excluded.timezone
             THEN job_schedule_state.evaluated_through
           ELSE excluded.evaluated_through END,
         schedule = excluded.schedule,
         timezone = excluded.timezone,
         last_checked_at = excluded.last_checked_at,
         updated_at = excluded.updated_at`,
    )
      .bind(
        job.id,
        job.schedule,
        job.timezone,
        sameSchedule ? (job.evaluated_through ?? now) : now,
        now,
        now,
      )
      .run();
  } catch {
    // A persistent D1 failure must not prevent other jobs from being attempted this tick.
  }
}
