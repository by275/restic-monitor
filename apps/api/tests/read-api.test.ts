import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface ReadFixture {
  hostId: string;
  secondaryHostId: string;
  jobId: string;
  jobKey: string;
  repositoryKey: string;
  secondaryRepositoryKey: string;
  runIds: string[];
  copyRunId: string;
}

async function seedReadFixture(): Promise<ReadFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const now = Date.now();
  const hostId = `host-read-${suffix}`;
  const secondaryHostId = `host-read-secondary-${suffix}`;
  const jobId = `job-read-${suffix}`;
  const jobKey = `read-job-${suffix}`;
  const repositoryId = `repository-read-${suffix}`;
  const secondaryRepositoryId = `repository-read-secondary-${suffix}`;
  const repositoryKey = `read-repo-${suffix}-a`;
  const secondaryRepositoryKey = `read-repo-${suffix}-b`;

  for (const [id, name, displayName] of [
    [hostId, `read-host-${suffix}-a`, `Read Host ${suffix} A`],
    [secondaryHostId, `read-host-${suffix}-b`, `Read Host ${suffix} B`],
  ]) {
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, name, displayName, now)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO repositories (id, repository_key, name, backend_type, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(repositoryId, repositoryKey, `Read Repository ${suffix} A`, "s3", now)
    .run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, repository_key, name, backend_type, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(secondaryRepositoryId, secondaryRepositoryKey, `Read Repository ${suffix} B`, "rest", now)
    .run();
  await env.DB.prepare(
    `INSERT INTO jobs (
       id, host_id, job_key, name, schedule, timezone, grace_seconds, timeout_seconds, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(jobId, hostId, jobKey, `Read Job ${suffix}`, "0 5 * * *", "UTC", 300, 3600, now)
    .run();
  for (const [repository, role] of [
    [repositoryId, "repository"],
    [repositoryId, "source"],
    [secondaryRepositoryId, "target"],
  ]) {
    await env.DB.prepare(
      "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, ?)",
    )
      .bind(jobId, repository, role)
      .run();
  }

  const runIds = [
    `run-read-a-${suffix}`,
    `run-read-b-${suffix}`,
    `run-read-c-${suffix}`,
    `run-read-d-${suffix}`,
  ];
  const runSeeds = [
    { id: runIds[0], status: "success", operation: "backup", startedAt: now - 50_000, repository: repositoryId },
    { id: runIds[1], status: "failed", operation: "backup", startedAt: now - 25_000, repository: repositoryId },
    { id: runIds[2], status: "running", operation: "backup", startedAt: now - 25_000, repository: repositoryId },
    { id: runIds[3], status: "partial_success", operation: "copy", startedAt: now - 10_000, repository: null },
  ];
  for (const [index, run] of runSeeds.entries()) {
    const finishedAt = run.status === "running" ? null : run.startedAt + 5_000;
    await env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, workflow_id, operation, status, exit_code, client_name, client_version,
         restic_version, started_at, finished_at, duration_ms, error_summary, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        run.id,
        jobId,
        `workflow-${suffix}`,
        run.operation,
        run.status,
        run.status === "running" ? null : run.status === "failed" ? 1 : run.status === "partial_success" ? 3 : 0,
        "restic-monitor-bash",
        "0.1.0",
        "0.19.1",
        run.startedAt,
        finishedAt,
        finishedAt === null ? null : 5_000,
        run.status === "failed" ? "fixture error summary" : null,
        now + index,
        now + index,
      )
      .run();
    const links = run.operation === "copy"
      ? [[repositoryId, "source"], [secondaryRepositoryId, "target"]]
      : [[run.repository!, "repository"]];
    for (const [repository, role] of links) {
      await env.DB.prepare(
        "INSERT INTO run_repositories (run_id, repository_id, role) VALUES (?, ?, ?)",
      )
        .bind(run.id, repository, role)
        .run();
    }
    if (finishedAt !== null) {
      await env.DB.prepare(
        `INSERT INTO run_metrics (run_id, bytes_processed, bytes_added, bytes_added_packed, files_new, snapshot_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(run.id, 100_000 + index, 10_000 + index, 7_500 + index, index + 1, `abcdef${index}12345678`, now + index)
        .run();
    }
  }

  for (const [index, value] of [25_000, 32_000, 29_000].entries()) {
    await env.DB.prepare(
      `INSERT INTO repository_stats (
         id, repository_id, source_run_id, measurement_type, value_bytes,
         measured_at, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `stat-read-${index}-${suffix}`,
        repositoryId,
        runIds[0],
        "restic_restore_size",
        value,
        now - (2 - index) * 60_000,
        JSON.stringify({ source: "read-api-test", sample: index }),
        now,
      )
      .run();
  }

  return {
    hostId,
    secondaryHostId,
    jobId,
    jobKey,
    repositoryKey,
    secondaryRepositoryKey,
    runIds,
    copyRunId: runIds[3],
  };
}

async function get(path: string): Promise<Response> {
  return exports.default.fetch(`http://localhost${path}`);
}

describe("read API", () => {
  it("paginates runs with a stable keyset and applies bound filters", async () => {
    const fixture = await seedReadFixture();
    const base = `/api/v1/read/runs?job_key=${fixture.jobKey}&limit=2`;
    const firstResponse = await get(base);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("cache-control")).toBe("private, no-store");
    const first = await firstResponse.json() as {
      data: Array<{ id: string }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    };
    expect(first.data).toHaveLength(2);
    expect(first.pagination.has_more).toBe(true);
    expect(first.pagination.next_cursor).toBeTypeOf("string");

    const secondResponse = await get(`${base}&cursor=${encodeURIComponent(first.pagination.next_cursor!)}`);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as typeof first;
    expect(second.data).toHaveLength(2);
    expect(second.pagination.has_more).toBe(false);
    expect(second.pagination.next_cursor).toBeNull();
    expect(new Set([...first.data, ...second.data].map((row) => row.id)).size).toBe(4);
    expect([...first.data, ...second.data].map((row) => row.id)).toContain(fixture.copyRunId);

    const failedResponse = await get(`/api/v1/read/runs?job_key=${fixture.jobKey}&status=failed`);
    const failed = await failedResponse.json() as { data: Array<{ id: string; status: string }> };
    expect(failed.data).toHaveLength(1);
    expect(failed.data[0]).toMatchObject({ status: "failed" });

    const mismatchedCursor = await get(
      `/api/v1/read/runs?job_key=another-job&cursor=${encodeURIComponent(first.pagination.next_cursor!)}`,
    );
    expect(mismatchedCursor.status).toBe(400);
    expect((await get("/api/v1/read/runs?limit=101")).status).toBe(400);
    expect((await get("/api/v1/read/runs?status=unknown")).status).toBe(400);
  });

  it("paginates and filters hosts and repositories", async () => {
    const fixture = await seedReadFixture();
    const hostPath = `/api/v1/read/hosts?q=read-host-${fixture.hostId.replace("host-read-", "")}&limit=1`;
    const hostsFirst = await (await get(hostPath)).json() as {
      data: Array<{ id: string; jobs_count: number; last_run_status: string | null }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    };
    expect(hostsFirst.data).toHaveLength(1);
    expect(hostsFirst.pagination.has_more).toBe(true);
    expect(hostsFirst.data[0].jobs_count).toBe(1);
    expect(hostsFirst.data[0].last_run_status).toBe("partial_success");
    const hostsSecond = await (await get(`${hostPath}&cursor=${encodeURIComponent(hostsFirst.pagination.next_cursor!)}`)).json() as typeof hostsFirst;
    expect(hostsSecond.data).toHaveLength(1);
    expect(hostsSecond.pagination.has_more).toBe(false);
    expect((await get(`${hostPath}&enabled=maybe`)).status).toBe(400);

    const repoPrefix = fixture.repositoryKey.slice(0, -1);
    const repoPath = `/api/v1/read/repositories?q=${repoPrefix}&limit=1`;
    const reposFirst = await (await get(repoPath)).json() as {
      data: Array<{ repository_key: string; jobs_count: number }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    };
    expect(reposFirst.data).toHaveLength(1);
    expect(reposFirst.pagination.has_more).toBe(true);
    const reposSecond = await (await get(`${repoPath}&cursor=${encodeURIComponent(reposFirst.pagination.next_cursor!)}`)).json() as typeof reposFirst;
    expect(reposSecond.data).toHaveLength(1);
    expect(reposSecond.pagination.has_more).toBe(false);
    expect((await get("/api/v1/read/repositories?backend_type=unknown")).status).toBe(400);
  });

  it("returns overview counts with host, job and repository filters", async () => {
    const fixture = await seedReadFixture();
    const response = await get(
      `/api/v1/read/overview?window_days=30&host_id=${fixture.hostId}&job_key=${fixture.jobKey}&repository_key=${fixture.repositoryKey}`,
    );
    expect(response.status).toBe(200);
    const overview = await response.json() as {
      window_days: number;
      counts: Record<string, number>;
      recent_runs: Array<{ id: string }>;
    };
    expect(overview.window_days).toBe(30);
    expect(overview.counts).toMatchObject({
      total_runs: 4,
      running: 1,
      success: 1,
      partial_success: 1,
      failed: 1,
    });
    expect(overview.recent_runs).toHaveLength(4);
    const empty = await get(`/api/v1/read/overview?job_key=missing-${fixture.jobKey}`);
    expect((await empty.json() as { counts: { total_runs: number } }).counts.total_runs).toBe(0);
    expect((await get("/api/v1/read/overview?window_days=365")).status).toBe(400);
    expect((await get("/api/v1/read/overview?status=failed")).status).toBe(400);
  });

  it("returns linked run details and paginated repository measurements", async () => {
    const fixture = await seedReadFixture();
    const detailResponse = await get(`/api/v1/read/runs/${fixture.copyRunId}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as {
      data: {
        status: string;
        metrics: { bytes_added: number };
        repositories: Array<{ repository_key: string; role: string }>;
      };
    };
    expect(detail.data.status).toBe("partial_success");
    expect(detail.data.metrics.bytes_added).toBe(10_003);
    expect(detail.data.repositories).toHaveLength(2);
    expect(detail.data.repositories.map((repository) => repository.role).sort()).toEqual(["source", "target"]);
    expect((await get("/api/v1/read/runs/unknown-run")).status).toBe(404);

    const base = `/api/v1/read/repositories/${fixture.repositoryKey}/stats?measurement_type=restic_restore_size&limit=2`;
    const first = await (await get(base)).json() as {
      data: Array<{ value_bytes: number; details: { source: string } }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    };
    expect(first.data.map((stat) => stat.value_bytes)).toEqual([29_000, 32_000]);
    expect(first.data[0].details.source).toBe("read-api-test");
    expect(first.pagination.has_more).toBe(true);
    const second = await (await get(`${base}&cursor=${encodeURIComponent(first.pagination.next_cursor!)}`)).json() as typeof first;
    expect(second.data.map((stat) => stat.value_bytes)).toEqual([25_000]);
    expect(second.pagination.has_more).toBe(false);
    expect((await get(`/api/v1/read/repositories/${fixture.repositoryKey}/stats?measurement_type=unknown`)).status).toBe(400);
    expect((await get("/api/v1/read/repositories/missing-repository/stats")).status).toBe(404);
  });

  it("rejects read API requests made on a hostname outside ADMIN_HOST", async () => {
    const response = await exports.default.fetch("https://public-ingest.example/api/v1/read/overview");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
