import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker foundation", () => {
  it("returns a minimal health response", async () => {
    const response = await exports.default.fetch("http://localhost/healthz");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "restic-monitor",
    });
  });

  it("applies the initial D1 schema and enforces relational constraints", async () => {
    const now = 1_798_000_000_000;
    const hostId = "host-test";
    const repoId = "repo-test";
    const jobId = "job-test";

    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(hostId, "test-host", "Test Host", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO repositories (id, repository_key, name, backend_type, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(repoId, "repo-test", "Test Repository", "s3", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO repositories (id, repository_key, name, backend_type, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("repo-target", "repo-target", "Target Repository", "rest", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, host_id, job_key, name, schedule, timezone, grace_seconds, timeout_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(jobId, hostId, "daily", "Daily backup", "0 5 * * *", "Asia/Seoul", 600, 7200, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, ?)",
    )
      .bind(jobId, repoId, "repository")
      .run();
    await env.DB.prepare(
      "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, ?)",
    )
      .bind(jobId, repoId, "source")
      .run();
    await env.DB.prepare(
      "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, ?)",
    )
      .bind(jobId, "repo-target", "target")
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO jobs (id, host_id, job_key, name, schedule, timezone, timeout_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("job-duplicate", hostId, "daily", "Duplicate", "0 6 * * *", "UTC", 3600, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO jobs (id, host_id, job_key, name, schedule, timezone, timeout_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("job-orphan", "missing-host", "orphan", "Orphan", "0 6 * * *", "UTC", 3600, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO runs (id, job_id, operation, status, client_name, client_version, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("run-bad-status", jobId, "backup", "unknown", "test-client", "0.1.0", now, now, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO runs (id, job_id, operation, status, client_name, client_version, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("run-bad-operation", jobId, "unknown", "running", "test-client", "0.1.0", now, now, now)
        .run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      "INSERT INTO runs (id, job_id, operation, status, client_name, client_version, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("run-test", jobId, "backup", "running", "test-client", "0.1.0", now, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO run_repositories (run_id, repository_id, role) VALUES (?, ?, ?)",
    )
      .bind("run-test", repoId, "repository")
      .run();
    await env.DB.prepare(
      "INSERT INTO run_metrics (run_id, bytes_added, updated_at) VALUES (?, ?, ?)",
    )
      .bind("run-test", 4096, now)
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO run_metrics (run_id, bytes_added, updated_at) VALUES (?, ?, ?)",
      )
        .bind("run-test", 9007199254740992, now)
        .run(),
    ).rejects.toThrow();

    const tokenHash = "a".repeat(64);
    const payloadHash = "b".repeat(64);
    await env.DB.prepare(
      "INSERT INTO api_tokens (id, host_id, token_prefix, token_hash, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("token-test", hostId, "rm_test", tokenHash, '["ingest"]', now)
      .run();
    await env.DB.prepare(
      "INSERT INTO ingest_events (token_id, event_id, run_id, event_type, payload_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("token-test", "event-test", "run-test", "run.started", payloadHash, now)
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO ingest_events (token_id, event_id, run_id, event_type, payload_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind("token-test", "event-test", "run-test", "run.started", payloadHash, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO runs (id, job_id, operation, status, client_name, client_version, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("run-incomplete", jobId, "backup", "failed", "test-client", "0.1.0", now, now, now)
        .run(),
    ).rejects.toThrow();

    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM run_repositories WHERE run_id = ?")
        .bind("run-test")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });

    await env.DB.prepare(
      "INSERT INTO runs (id, job_id, operation, status, client_name, client_version, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("run-copy", jobId, "copy", "running", "test-client", "0.1.0", now, now, now)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO run_repositories (run_id, repository_id, role) VALUES (?, ?, ?)",
      ).bind("run-copy", repoId, "source"),
      env.DB.prepare(
        "INSERT INTO run_repositories (run_id, repository_id, role) VALUES (?, ?, ?)",
      ).bind("run-copy", "repo-target", "target"),
    ]);

    expect(
      await env.DB.prepare("SELECT role FROM run_repositories WHERE run_id = ? ORDER BY role")
        .bind("run-copy")
        .all<{ role: string }>(),
    ).toMatchObject({ results: [{ role: "source" }, { role: "target" }] });
  });
});
