import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { enumerateDueOccurrences, runScheduleTick } from "../src/scheduler";

const minute = 60_000;
const epoch = Date.UTC(2025, 0, 1, 0, 0, 0);

interface JobFixture {
  jobId: string;
  hostId: string;
}

async function seedJob(options: {
  schedule?: string;
  timezone?: string;
  graceSeconds?: number;
  timeoutSeconds?: number;
  enabled?: number;
} = {}): Promise<JobFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const hostId = `schedule-host-${suffix}`;
  const jobId = `schedule-job-${suffix}`;
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(hostId, `schedule-host-${suffix}`, "Schedule Test", epoch)
    .run();
  await env.DB.prepare(
    `INSERT INTO jobs (
       id, host_id, job_key, name, schedule, timezone, grace_seconds,
       timeout_seconds, enabled, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      hostId,
      `job-${suffix}`,
      "Schedule Test Job",
      options.schedule ?? "* * * * *",
      options.timezone ?? "UTC",
      options.graceSeconds ?? 0,
      options.timeoutSeconds ?? 3600,
      options.enabled ?? 1,
      epoch,
    )
    .run();
  return { jobId, hostId };
}

async function scheduled(scheduledTime: number): Promise<void> {
  await runScheduleTick(env.DB, scheduledTime);
}

async function rows<T>(jobId: string, sql: string): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(jobId).all<T>();
  return result.results;
}

describe("schedule reconciliation", () => {
  it("creates a missed alert only after grace, then resolves it when a late run is matched", async () => {
    const { jobId } = await seedJob({ graceSeconds: 120 });
    await scheduled(epoch);
    await scheduled(epoch + minute);

    expect(
      await env.DB.prepare("SELECT state FROM schedule_occurrences WHERE job_id = ? ORDER BY scheduled_for")
        .bind(jobId)
        .all(),
    ).toMatchObject({ results: [{ state: "pending" }] });
    expect(await rows(jobId, "SELECT id FROM alerts WHERE job_id = ?")).toHaveLength(0);

    await scheduled(epoch + 3 * minute);
    expect(
      await env.DB.prepare(
        "SELECT state FROM schedule_occurrences WHERE job_id = ? AND scheduled_for = ?",
      )
        .bind(jobId, epoch + minute)
        .first(),
    ).toEqual({ state: "missed" });
    expect(
      await env.DB.prepare("SELECT status, rule_key FROM alerts WHERE job_id = ?")
        .bind(jobId)
        .all(),
    ).toMatchObject({ results: [{ status: "open", rule_key: "missed_schedule" }] });

    await env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, operation, status, client_name, client_version,
         started_at, finished_at, duration_ms, created_at, updated_at
       ) VALUES (?, ?, 'backup', 'success', 'test', '1', ?, ?, ?, ?, ?)`,
    )
      .bind("late-scheduled-run", jobId, epoch + minute + 30_000, epoch + minute + 60_000, 30_000, epoch, epoch)
      .run();

    await scheduled(epoch + 5 * minute);
    expect(
      await env.DB.prepare(
        "SELECT state, matched_run_id FROM schedule_occurrences WHERE job_id = ? AND scheduled_for = ?",
      )
        .bind(jobId, epoch + minute)
        .first(),
    ).toEqual({ state: "matched", matched_run_id: "late-scheduled-run" });
    expect(
      await env.DB.prepare(
        `SELECT status FROM alerts
         WHERE job_id = ? AND rule_key = 'missed_schedule' AND occurrence_scheduled_for = ?`,
      )
        .bind(jobId, epoch + minute)
        .first(),
    ).toEqual({ status: "resolved" });
  });

  it("catches up across bounded pages and is safe to invoke repeatedly", async () => {
    const { jobId } = await seedJob();
    await scheduled(epoch);

    const delayedTime = epoch + 60 * minute;
    await scheduled(delayedTime);
    expect(await rows(jobId, "SELECT scheduled_for FROM schedule_occurrences WHERE job_id = ?")).toHaveLength(20);

    await scheduled(delayedTime);
    await scheduled(delayedTime);
    await scheduled(delayedTime);
    expect(await rows(jobId, "SELECT scheduled_for FROM schedule_occurrences WHERE job_id = ?")).toHaveLength(60);
    expect(await rows(jobId, "SELECT id FROM alerts WHERE job_id = ?")).toHaveLength(60);

    await scheduled(delayedTime);
    expect(await rows(jobId, "SELECT id FROM alerts WHERE job_id = ?")).toHaveLength(60);
    const state = await env.DB.prepare(
      "SELECT evaluated_through FROM job_schedule_state WHERE job_id = ?",
    )
      .bind(jobId)
      .first<{ evaluated_through: number }>();
    expect(state?.evaluated_through).toBe(delayedTime);
  });

  it("uses actual invocation time when the Cron event's scheduled time is delayed", async () => {
    const { jobId } = await seedJob();
    await env.DB.prepare(
      `INSERT INTO job_schedule_state (
         job_id, schedule, timezone, evaluated_through, last_checked_at, updated_at
       ) VALUES (?, '* * * * *', 'UTC', ?, ?, ?)`,
    )
      .bind(jobId, epoch, epoch, epoch)
      .run();

    const worker = exports.default as typeof exports.default & {
      scheduled(controller: ScheduledController, env: { DB: D1Database }, context: ExecutionContext): Promise<void>;
    };
    const invokedAt = Date.now();
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: epoch + minute } as ScheduledController,
      env,
      {} as ExecutionContext,
    );

    expect(invokedAt).toBeGreaterThan(epoch + 60 * minute);
    expect(await rows(jobId, "SELECT scheduled_for FROM schedule_occurrences WHERE job_id = ?"))
      .toHaveLength(20);
  });

  it("rebases on schedule edits and continues processing other jobs after one invalid schedule", async () => {
    const invalid = await seedJob({ schedule: "invalid cron" });
    const valid = await seedJob();
    await scheduled(epoch);
    await scheduled(epoch + minute);

    expect(await rows(valid.jobId, "SELECT scheduled_for FROM schedule_occurrences WHERE job_id = ?"))
      .toHaveLength(1);

    await env.DB.prepare("UPDATE jobs SET schedule = '0 5 * * *', timezone = 'Asia/Seoul' WHERE id = ?")
      .bind(valid.jobId)
      .run();
    await scheduled(epoch + 2 * minute);
    expect(await rows(valid.jobId, "SELECT scheduled_for FROM schedule_occurrences WHERE job_id = ?"))
      .toHaveLength(1);
    expect(await rows(invalid.jobId, "SELECT scheduled_for FROM schedule_occurrences WHERE job_id = ?"))
      .toHaveLength(0);
  });

  it("uses the timezone's cron slots through DST gaps and folds", () => {
    const springStart = Date.parse("2025-03-08T05:00:00Z");
    expect(enumerateDueOccurrences("30 2 * * *", "America/New_York", springStart, Date.parse("2025-03-10T12:00:00Z"), 5))
      .toEqual([
        Date.parse("2025-03-08T07:30:00Z"),
        Date.parse("2025-03-09T07:30:00Z"),
        Date.parse("2025-03-10T06:30:00Z"),
      ]);

    const fallStart = Date.parse("2025-11-01T04:00:00Z");
    expect(enumerateDueOccurrences("30 1 * * *", "America/New_York", fallStart, Date.parse("2025-11-03T12:00:00Z"), 5))
      .toEqual([
        Date.parse("2025-11-01T05:30:00Z"),
        Date.parse("2025-11-02T05:30:00Z"),
        Date.parse("2025-11-03T06:30:00Z"),
      ]);
  });

  it("still evaluates run timeouts if a job's cron expression is invalid", async () => {
    const { jobId } = await seedJob({ schedule: "invalid cron", timeoutSeconds: 10 });
    const startedAt = epoch;
    await env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, operation, status, client_name, client_version,
         started_at, created_at, updated_at
       ) VALUES (?, ?, 'backup', 'running', 'test', '1', ?, ?, ?)`,
    )
      .bind("invalid-cron-timeout-run", jobId, startedAt, epoch, epoch)
      .run();

    await scheduled(startedAt + 10_000);
    expect(
      await env.DB.prepare("SELECT status, finished_at FROM runs WHERE id = ?")
        .bind("invalid-cron-timeout-run")
        .first(),
    ).toEqual({ status: "timed_out", finished_at: startedAt + 10_000 });
    expect(
      await env.DB.prepare("SELECT rule_key, status FROM alerts WHERE job_id = ?")
        .bind(jobId)
        .first(),
    ).toEqual({ rule_key: "run_timeout", status: "open" });
  });
});
