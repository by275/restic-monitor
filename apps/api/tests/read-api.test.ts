import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function get(path: string, hostname = "localhost"): Promise<Response> {
  return exports.default.fetch(`https://${hostname}${path}`);
}

async function seedReadData() {
  const now = Date.now();
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const hostId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(hostId, `read-host-${suffix}`, `Read Host ${suffix}`, now, now).run();
  await env.DB.prepare(
    `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
     VALUES (?, ?, ?, 's3', ?, ?)`,
  ).bind(repositoryId, `read-repo-${suffix}`, `Read Repository ${suffix}`, now, now).run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at)
     VALUES (?, ?, ?, 'Nightly backup', 'backup', 3600, ?, ?)`,
  ).bind(jobId, hostId, `nightly-${suffix}`, now, now).run();
  await env.DB.prepare(
    "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, 'repository')",
  ).bind(jobId, repositoryId).run();
  const runIds: string[] = [];
  for (const [index, status] of ["success", "failed", "running"].entries()) {
    const runId = crypto.randomUUID();
    runIds.push(runId);
    const startedAt = now - (3 - index) * 10_000;
    const running = status === "running";
    await env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, workflow_id, operation, status, exit_code, client_name,
         restic_version, started_at, finished_at, duration_ms, created_at, updated_at
       ) VALUES (?, ?, NULL, 'backup', ?, ?, 'example-client', '0.19.1', ?, ?, ?, ?, ?)`,
    ).bind(
      runId, jobId, status, running ? null : status === "success" ? 0 : 1,
      startedAt, running ? null : startedAt + 2000, running ? null : 2000, now + index, now + index,
    ).run();
    await env.DB.prepare(
      "INSERT INTO run_repositories (run_id, repository_id, role) VALUES (?, ?, 'repository')",
    ).bind(runId, repositoryId).run();
    if (!running) {
      await env.DB.prepare(
        `INSERT INTO run_metrics (run_id, bytes_processed, bytes_added, snapshot_id, updated_at)
         VALUES (?, 4096, ?, 'abcdef0123456789', ?)`,
      ).bind(runId, index * 1024, now + index).run();
    }
  }
  for (const [index, bytes] of [25_000, 32_000, 29_000].entries()) {
    await env.DB.prepare(
      `INSERT INTO repository_stats (
         id, repository_id, source_run_id, job_id, measurement_type, value_bytes,
         measured_at, details_json, created_at
       ) VALUES (?, ?, ?, ?, 'restic_restore_size', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), repositoryId, runIds[0], jobId, bytes,
      now - (2 - index) * 60_000, JSON.stringify({ source: "synthetic-test", sample: index }), now,
    ).run();
  }
  return {
    hostId,
    hostName: `read-host-${suffix}`,
    repositoryId,
    jobId,
    jobSlug: `nightly-${suffix}`,
    repositoryKey: `read-repo-${suffix}`,
    runIds,
  };
}

describe("read API", () => {
  it("paginates runs with a stable cursor and filters by Job slug and status", async () => {
    const fixture = await seedReadData();
    const base = `/api/v1/read/runs?job_slug=${fixture.jobSlug}&limit=2`;
    const firstResponse = await get(base);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("cache-control")).toBe("private, no-store");
    const first = await firstResponse.json() as {
      data: Array<{ id: string; job: { slug: string }; repositories: Array<{ repository_key: string }> }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    };
    expect(first.data).toHaveLength(2);
    expect(first.pagination.has_more).toBe(true);
    expect(first.data[0].job.slug).toBe(fixture.jobSlug);
    expect(first.data[0].repositories[0].repository_key).toBe(fixture.repositoryKey);
    const second = await (await get(`${base}&cursor=${encodeURIComponent(first.pagination.next_cursor!)}`)).json() as typeof first;
    expect(second.data).toHaveLength(1);
    expect(second.pagination).toMatchObject({ has_more: false, next_cursor: null });
    expect(new Set([...first.data, ...second.data].map((run) => run.id)).size).toBe(3);

    const failed = await (await get(`/api/v1/read/runs?job_slug=${fixture.jobSlug}&status=failed`)).json() as { data: Array<{ status: string }> };
    expect(failed.data).toMatchObject([{ status: "failed" }]);
    expect((await get("/api/v1/read/runs?limit=101")).status).toBe(400);
    expect((await get("/api/v1/read/runs?status=unknown")).status).toBe(400);
    expect((await get(`/api/v1/read/runs?job_slug=${fixture.jobSlug}&cursor=${encodeURIComponent(first.pagination.next_cursor!)}&status=failed`)).status).toBe(400);
  });

  it("returns dashboard counts, run details, and paginated repository measurements", async () => {
    const fixture = await seedReadData();
    const overviewResponse = await get(
      `/api/v1/read/overview?window_days=30&host_id=${fixture.hostId}&job_slug=${fixture.jobSlug}&repository_key=${fixture.repositoryKey}`,
    );
    expect(overviewResponse.status).toBe(200);
    const overview = await overviewResponse.json() as { counts: Record<string, number>; recent_runs: Array<{ id: string }> };
    expect(overview.counts).toMatchObject({ total_runs: 3, running: 1, success: 1, failed: 1 });
    expect(overview.recent_runs).toHaveLength(3);
    expect((await get("/api/v1/read/overview?window_days=365")).status).toBe(400);
    expect((await get("/api/v1/read/overview?status=failed")).status).toBe(400);

    const successfulRunId = (await env.DB.prepare(
      "SELECT id FROM runs WHERE job_id = ? AND status = 'success' LIMIT 1",
    ).bind(fixture.jobId).first<{ id: string }>())!.id;
    const detail = await (await get(`/api/v1/read/runs/${successfulRunId}`)).json() as {
      data: { status: string; metrics: { bytes_processed: number; bytes_added: number }; repositories: Array<{ role: string }> };
    };
    expect(detail.data).toMatchObject({
      status: "success",
      metrics: { bytes_processed: 4096 },
      repositories: [{ role: "repository" }],
    });
    expect((await get("/api/v1/read/runs/not-a-run")).status).toBe(404);

    const base = `/api/v1/read/repositories/${fixture.repositoryKey}/stats?measurement_type=restic_restore_size&limit=2`;
    const first = await (await get(base)).json() as {
      data: Array<{ value_bytes: number; details: { source: string }; job_id: string; is_anomalous: boolean }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    };
    expect(first.data.map((stat) => stat.value_bytes)).toEqual([29_000, 32_000]);
    expect(first.data[0]).toMatchObject({ job_id: fixture.jobId, is_anomalous: false });
    expect(first.data[0].details.source).toBe("synthetic-test");
    const second = await (await get(`${base}&cursor=${encodeURIComponent(first.pagination.next_cursor!)}`)).json() as typeof first;
    expect(second.data.map((stat) => stat.value_bytes)).toEqual([25_000]);
    expect((await get(`/api/v1/read/repositories/${fixture.repositoryKey}/stats?measurement_type=unknown`)).status).toBe(400);
  });

  it("keeps inventory read routes host guarded", async () => {
    const fixture = await seedReadData();
    const hosts = await (await get(`/api/v1/read/hosts?q=${fixture.hostName}&limit=1`)).json() as {
      data: Array<{ id: string; jobs_count: number }>;
    };
    expect(hosts.data).toHaveLength(1);
    expect(hosts.data[0]).toMatchObject({ id: fixture.hostId, jobs_count: 1 });
    const repositories = await (await get(`/api/v1/read/repositories?q=${fixture.repositoryKey}&limit=1`)).json() as {
      data: Array<{ repository_key: string; jobs_count: number }>;
    };
    expect(repositories.data).toMatchObject([{ repository_key: fixture.repositoryKey, jobs_count: 1 }]);
    expect((await get("/api/v1/read/overview", "public-ingest.example")).status).toBe(404);
  });
});
