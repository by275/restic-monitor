import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { enumerateDueOccurrences, runScheduleTick } from "../src/scheduler";

const minute = 60_000;
const base = Date.UTC(2025, 0, 1, 0, 0, 0);

async function seedScheduledJob(options: {
  grace?: number;
  timeout?: number;
  schedules?: Array<{ expression: string; grace: number }>;
} = {}) {
  const hostId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const suffix = hostId.replaceAll("-", "").slice(0, 12);
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(hostId, `scheduler-${suffix}`, "Scheduler test", base, base).run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at)
     VALUES (?, ?, ?, 'Scheduled job', 'backup', ?, ?, ?)`,
  ).bind(jobId, hostId, `scheduled-${suffix}`, options.timeout ?? 3600, base, base).run();
  const scheduleIds: string[] = [];
  for (const [index, schedule] of (options.schedules ?? [{ expression: "* * * * *", grace: options.grace ?? 0 }]).entries()) {
    const scheduleId = crypto.randomUUID();
    scheduleIds.push(scheduleId);
    await env.DB.prepare(
      `INSERT INTO job_schedule_rules (
         id, job_id, schedule_type, expression, timezone, start_grace_seconds, sort_order, created_at, updated_at
       ) VALUES (?, ?, 'cron', ?, 'UTC', ?, ?, ?, ?)`,
    ).bind(scheduleId, jobId, schedule.expression, schedule.grace, index, base, base).run();
  }
  return { hostId, jobId, scheduleIds };
}

describe("job schedule reconciliation", () => {
  it("waits through start grace, opens one missed alert, then matches a late run", async () => {
    const { jobId, scheduleIds: [scheduleId] } = await seedScheduledJob({ grace: 60 });
    await runScheduleTick(env.DB, base);
    await runScheduleTick(env.DB, base + minute);
    const scheduledFor = base + minute;
    await runScheduleTick(env.DB, scheduledFor + 60_000 - 1);
    expect(await env.DB.prepare("SELECT id FROM alerts WHERE job_id = ?").bind(jobId).all()).toMatchObject({ results: [] });

    await runScheduleTick(env.DB, scheduledFor + 60_000);
    const missed = await env.DB.prepare(
      "SELECT id, status FROM alerts WHERE job_id = ? AND rule_key = 'missed_schedule'",
    ).bind(jobId).first<{ id: string; status: string }>();
    expect(missed?.status).toBe("open");

    const runId = crypto.randomUUID();
    const startedAt = scheduledFor + 30_000;
    await env.DB.prepare(
      `INSERT INTO runs (id, job_id, operation, status, started_at, finished_at, duration_ms, created_at, updated_at)
       VALUES (?, ?, 'backup', 'success', ?, ?, 1000, ?, ?)`,
    ).bind(runId, jobId, startedAt, startedAt + 1000, base, base).run();
    await runScheduleTick(env.DB, scheduledFor + 3 * minute);

    expect(await env.DB.prepare(
      "SELECT state, matched_run_id FROM schedule_occurrences WHERE schedule_rule_id = ? AND scheduled_for = ?",
    ).bind(scheduleId, scheduledFor).first()).toEqual({ state: "matched", matched_run_id: runId });
    expect(await env.DB.prepare("SELECT status FROM alerts WHERE id = ?").bind(missed!.id).first())
      .toEqual({ status: "resolved" });
  });

  it("tracks several cron rules for one Job independently", async () => {
    const { jobId, scheduleIds } = await seedScheduledJob({
      schedules: [
        { expression: "* * * * *", grace: 30 },
        { expression: "* * * * *", grace: 120 },
      ],
    });
    await runScheduleTick(env.DB, base);
    await runScheduleTick(env.DB, base + minute);
    await runScheduleTick(env.DB, base + minute + 30_000);
    const states = await env.DB.prepare(
      `SELECT schedule_rule_id, state FROM schedule_occurrences
       WHERE schedule_rule_id IN (?, ?) AND scheduled_for = ? ORDER BY schedule_rule_id`,
    ).bind(...scheduleIds, base + minute).all<{ schedule_rule_id: string; state: string }>();
    expect(states.results).toHaveLength(2);
    expect(states.results.map((row) => row.state).sort()).toEqual(["missed", "pending"]);
    const alerts = await env.DB.prepare(
      "SELECT count(*) AS count FROM alerts WHERE job_id = ? AND rule_key = 'missed_schedule'",
    ).bind(jobId).first<{ count: number }>();
    expect(alerts?.count).toBe(1);
  });

  it("catches up in bounded, repeatable pages after a delayed scheduler invocation", async () => {
    const { jobId } = await seedScheduledJob();
    await runScheduleTick(env.DB, base);
    const delayed = base + 60 * minute;
    await runScheduleTick(env.DB, delayed);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM schedule_occurrences WHERE schedule_rule_id IN (SELECT id FROM job_schedule_rules WHERE job_id = ?)")
      .bind(jobId).first()).toEqual({ count: 20 });
    await runScheduleTick(env.DB, delayed);
    await runScheduleTick(env.DB, delayed);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM schedule_occurrences WHERE schedule_rule_id IN (SELECT id FROM job_schedule_rules WHERE job_id = ?)")
      .bind(jobId).first()).toEqual({ count: 60 });
    await runScheduleTick(env.DB, delayed);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM alerts WHERE job_id = ? AND rule_key = 'missed_schedule'")
      .bind(jobId).first()).toEqual({ count: 60 });
  });

  it("times out a running invocation using max runtime even without a due schedule", async () => {
    const { jobId } = await seedScheduledJob({ timeout: 10, schedules: [] });
    const runId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO runs (id, job_id, operation, status, started_at, created_at, updated_at)
       VALUES (?, ?, 'backup', 'running', ?, ?, ?)`,
    ).bind(runId, jobId, base, base, base).run();
    await runScheduleTick(env.DB, base + 10_000);
    expect(await env.DB.prepare("SELECT status, finished_at, duration_ms FROM runs WHERE id = ?")
      .bind(runId).first()).toEqual({ status: "timed_out", finished_at: base + 10_000, duration_ms: 10_000 });
    expect(await env.DB.prepare("SELECT rule_key, status FROM alerts WHERE run_id = ?")
      .bind(runId).first()).toEqual({ rule_key: "run_timeout", status: "open" });
  });

  it("enumerates cron slots in the configured timezone across daylight-saving changes", () => {
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
});
