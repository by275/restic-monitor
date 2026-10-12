import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRepositoryStatsStatements } from "../src/repository-stats";

let fixture: { hostId: string; repositoryId: string; jobId: string } | null = null;

afterEach(async () => {
  if (fixture === null) return;
  await env.DB.prepare("DELETE FROM notification_deliveries WHERE alert_id IN (SELECT id FROM alerts WHERE job_id = ?)")
    .bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM alerts WHERE job_id = ?").bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM repository_stats WHERE job_id = ?").bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM run_metrics WHERE run_id IN (SELECT id FROM runs WHERE job_id = ?)")
    .bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM run_repositories WHERE run_id IN (SELECT id FROM runs WHERE job_id = ?)")
    .bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM runs WHERE job_id = ?").bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM job_repositories WHERE job_id = ?").bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(fixture.jobId).run();
  await env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind(fixture.repositoryId).run();
  await env.DB.prepare("DELETE FROM hosts WHERE id = ?").bind(fixture.hostId).run();
  fixture = null;
});

describe("Repository stats growth alerts", () => {
  it("uses recent successful stats as baseline and queues open and recovery notices", async () => {
    const hostId = crypto.randomUUID();
    const repositoryId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const suffix = hostId.replaceAll("-", "").slice(0, 10);
    const now = Date.now();
    fixture = { hostId, repositoryId, jobId };
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(hostId, `stats-host-${suffix}`, "Stats test host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, 'Stats repository', 'local', ?, ?)`,
    ).bind(repositoryId, `stats-repo-${suffix}`, now, now).run();
    await env.DB.prepare(
      `INSERT INTO jobs (id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at)
       VALUES (?, ?, ?, 'Repository stats', 'stats', 3600, ?, ?)`,
    ).bind(jobId, hostId, `stats-${suffix}`, now, now).run();
    await env.DB.prepare(
      "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, 'repository')",
    ).bind(jobId, repositoryId).run();

    const baselineBytes = 10_000_000;
    for (let index = 0; index < 5; index++) {
      const runId = crypto.randomUUID();
      const measuredAt = now - (5 - index) * 60_000;
      await env.DB.prepare(
        `INSERT INTO runs (id, job_id, operation, status, exit_code, started_at, finished_at, duration_ms, created_at, updated_at)
         VALUES (?, ?, 'stats', 'success', 0, ?, ?, 1000, ?, ?)`,
      ).bind(runId, jobId, measuredAt, measuredAt + 1000, measuredAt, measuredAt).run();
      await env.DB.prepare(
        `INSERT INTO repository_stats (
           id, repository_id, source_run_id, job_id, measurement_type, value_bytes,
           measured_at, details_json, created_at
         ) VALUES (?, ?, ?, ?, 'restic_restore_size', ?, ?, '{}', ?)`,
      ).bind(`${runId}:restic_restore_size`, repositoryId, runId, jobId, baselineBytes, measuredAt, measuredAt).run();
    }

    const anomalousRunId = crypto.randomUUID();
    const anomalousAt = now;
    await env.DB.prepare(
      `INSERT INTO runs (id, job_id, operation, status, exit_code, started_at, finished_at, duration_ms, created_at, updated_at)
       VALUES (?, ?, 'stats', 'success', 0, ?, ?, 1000, ?, ?)`,
    ).bind(anomalousRunId, jobId, now, now + 1000, now, now).run();
    await env.DB.batch(await prepareRepositoryStatsStatements(env.DB, {
      jobId,
      hostId,
      repositoryId,
      repositoryKey: `stats-repo-${suffix}`,
      runId: anomalousRunId,
      measuredAt: anomalousAt,
      receivedAt: now,
      measurement: { mode: "restore-size", value_bytes: baselineBytes + 150 * 1024 * 1024 },
    }));

    const openAlert = await env.DB.prepare(
      "SELECT id, status, baseline_value_bytes FROM alerts WHERE job_id = ? AND rule_key = 'repository_growth'",
    ).bind(jobId).first<{ id: string; status: string; baseline_value_bytes: number }>();
    expect(openAlert).toMatchObject({ status: "open", baseline_value_bytes: baselineBytes });
    expect(await env.DB.prepare(
      "SELECT is_anomalous FROM repository_stats WHERE source_run_id = ?",
    ).bind(anomalousRunId).first()).toEqual({ is_anomalous: 1 });
    expect(await env.DB.prepare(
      "SELECT status, notification_type FROM notification_deliveries WHERE alert_id = ?",
    ).bind(openAlert!.id).first()).toEqual({ status: "pending", notification_type: "open" });

    const recoveredRunId = crypto.randomUUID();
    const recoveredAt = now + 60_000;
    await env.DB.prepare(
      `INSERT INTO runs (id, job_id, operation, status, exit_code, started_at, finished_at, duration_ms, created_at, updated_at)
       VALUES (?, ?, 'stats', 'success', 0, ?, ?, 1000, ?, ?)`,
    ).bind(recoveredRunId, jobId, recoveredAt, recoveredAt + 1000, recoveredAt, recoveredAt).run();
    await env.DB.batch(await prepareRepositoryStatsStatements(env.DB, {
      jobId,
      hostId,
      repositoryId,
      repositoryKey: `stats-repo-${suffix}`,
      runId: recoveredRunId,
      measuredAt: recoveredAt,
      receivedAt: recoveredAt,
      measurement: { mode: "restore-size", value_bytes: baselineBytes },
    }));
    expect(await env.DB.prepare("SELECT status, resolved_at FROM alerts WHERE id = ?")
      .bind(openAlert!.id).first<{ status: string; resolved_at: number }>())
      .toEqual({ status: "resolved", resolved_at: recoveredAt });
    expect(await env.DB.prepare(
      "SELECT status, notification_type FROM notification_deliveries WHERE alert_id = ? AND notification_type = 'recovery'",
    ).bind(openAlert!.id).first()).toEqual({ status: "pending", notification_type: "recovery" });
  });
});
