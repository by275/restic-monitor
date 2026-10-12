import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const TEST_HOST_ID = "00000000-0000-4000-8000-000000000001";
const TEST_REPOSITORY_ID = "00000000-0000-4000-8000-000000000002";
const TEST_JOB_ID = "00000000-0000-4000-8000-000000000003";
const TEST_SCHEDULE_ID = "00000000-0000-4000-8000-000000000004";
const TEST_RUN_ID = "00000000-0000-4000-8000-000000000005";

describe("worker foundation", () => {
  it("returns a minimal health response", async () => {
    const response = await exports.default.fetch("http://localhost/healthz");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true, service: "restic-monitor" });
  });

  it("applies the fresh Job-centric D1 schema and enforces its key constraints", async () => {
    const now = 1_798_000_000_000;
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(TEST_HOST_ID, "test-host", "Test Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(TEST_REPOSITORY_ID, "repo-test", "Test Repository", "s3", now, now).run();
    await env.DB.prepare(
      `INSERT INTO jobs (
         id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'backup', 3600, ?, ?)`,
    ).bind(TEST_JOB_ID, TEST_HOST_ID, "daily-backup", "Daily backup", now, now).run();
    await env.DB.prepare(
      "INSERT INTO job_tags (job_id, tag) VALUES (?, ?)",
    ).bind(TEST_JOB_ID, "production").run();
    await env.DB.prepare(
      "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, 'repository')",
    ).bind(TEST_JOB_ID, TEST_REPOSITORY_ID).run();
    await env.DB.prepare(
      `INSERT INTO job_schedule_rules (
         id, job_id, schedule_type, expression, timezone, start_grace_seconds, created_at, updated_at
       ) VALUES (?, ?, 'cron', '0 3 * * *', 'Asia/Seoul', 300, ?, ?)`,
    ).bind(TEST_SCHEDULE_ID, TEST_JOB_ID, now, now).run();
    await env.DB.prepare(
      `INSERT INTO job_ping_tokens (id, job_id, token_prefix, token_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("00000000-0000-4000-8000-000000000006", TEST_JOB_ID, "rmp1_test", "a".repeat(64), now).run();

    await expect(
      env.DB.prepare(
        `INSERT INTO jobs (
           id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'backup', 3600, ?, ?)`,
      ).bind("00000000-0000-4000-8000-000000000007", TEST_HOST_ID, "daily-backup", "Duplicate", now, now).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO job_ping_tokens (id, job_id, token_prefix, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind("00000000-0000-4000-8000-000000000008", TEST_JOB_ID, "rmp1_next", "b".repeat(64), now).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, job_id, operation, status, started_at, created_at, updated_at)
         VALUES (?, ?, 'backup', 'unknown', ?, ?, ?)`,
      ).bind(TEST_RUN_ID, TEST_JOB_ID, now, now, now).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO run_metrics (run_id, bytes_added, updated_at) VALUES (?, ?, ?)",
      ).bind(TEST_RUN_ID, 9007199254740992, now).run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      `INSERT INTO runs (
         id, job_id, operation, status, started_at, start_ping_received, created_at, updated_at
       ) VALUES (?, ?, 'backup', 'running', ?, 1, ?, ?)`,
    ).bind(TEST_RUN_ID, TEST_JOB_ID, now, now, now).run();
    await env.DB.prepare(
      "INSERT INTO run_repositories (run_id, repository_id, role) VALUES (?, ?, 'repository')",
    ).bind(TEST_RUN_ID, TEST_REPOSITORY_ID).run();
    await env.DB.prepare(
      "INSERT INTO run_metrics (run_id, bytes_added, updated_at) VALUES (?, ?, ?)",
    ).bind(TEST_RUN_ID, 4096, now).run();

    expect(await env.DB.prepare("SELECT slug FROM jobs WHERE id = ?").bind(TEST_JOB_ID).first())
      .toEqual({ slug: "daily-backup" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM run_repositories WHERE run_id = ?")
      .bind(TEST_RUN_ID).first()).toEqual({ count: 1 });
  });
});
