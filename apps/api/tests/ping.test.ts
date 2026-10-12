import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPingToken, sha256Hex } from "../src/security";

interface Fixture {
  hostId: string;
  repositoryId: string;
  jobId: string;
  token: string;
}

async function createFixture(operation: string = "backup", withNotificationTarget = false): Promise<Fixture> {
  const hostId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(hostId, `host-${hostId.slice(0, 8)}`, "Ping test host", now, now).run();
  await env.DB.prepare(
    `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
     VALUES (?, ?, ?, 'local', ?, ?)`,
  ).bind(repositoryId, `repo-${repositoryId.slice(0, 8)}`, "Ping test repository", now, now).run();
  await env.DB.prepare(
    `INSERT INTO jobs (
       id, host_id, slug, name, operation, max_runtime_seconds, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 7200, ?, ?)`,
  ).bind(jobId, hostId, `job-${jobId.slice(0, 8)}`, "Ping test job", operation, now, now).run();
  if (withNotificationTarget) {
    const targetId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO notification_targets (id, name, provider, config_json, created_at, updated_at)
       VALUES (?, ?, 'discord', ?, ?, ?)`,
    ).bind(targetId, `ping-target-${targetId.slice(0, 8)}`, JSON.stringify({
      webhook_url: "https://discord.com/api/webhooks/123456789012345678/test-token",
    }), now, now).run();
    await env.DB.prepare(
      "INSERT INTO job_notification_targets (job_id, target_id, created_at) VALUES (?, ?, ?)",
    ).bind(jobId, targetId, now).run();
  }
  const role = operation === "copy" ? "target" : "repository";
  await env.DB.prepare(
    "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, ?)",
  ).bind(jobId, repositoryId, role).run();
  if (operation === "copy") {
    const sourceId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?)`,
    ).bind(sourceId, `source-${sourceId.slice(0, 8)}`, "Source repository", now, now).run();
    await env.DB.prepare(
      "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, 'source')",
    ).bind(jobId, sourceId).run();
  }
  const token = createPingToken();
  await env.DB.prepare(
    `INSERT INTO job_ping_tokens (id, job_id, token_prefix, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), jobId, token.slice(0, 9), await sha256Hex(token), now).run();
  return { hostId, repositoryId, jobId, token };
}

function pingPath(fixture: Fixture, runId: string, phase: "start" | "complete") {
  return `http://localhost/api/v1/ping/${fixture.token}/runs/${runId}/${phase}`;
}

async function start(fixture: Fixture, runId: string, headers: HeadersInit = {}) {
  return exports.default.fetch(pingPath(fixture, runId, "start"), { method: "POST", headers });
}

async function complete(fixture: Fixture, runId: string, body: unknown) {
  return exports.default.fetch(pingPath(fixture, runId, "complete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Job ping API v1", () => {
  it("records a run and makes start and completion retries idempotent", async () => {
    const fixture = await createFixture();
    const runId = crypto.randomUUID();
    const started = await start(fixture, runId, { "X-Restic-Monitor-Client": "bash-example/1.0" });
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({ run_id: runId, accepted: true, duplicate: false, status: "running" });
    const initial = await env.DB.prepare("SELECT started_at, client_name FROM runs WHERE id = ?")
      .bind(runId).first<{ started_at: number; client_name: string }>();
    expect(initial?.client_name).toBe("bash-example/1.0");

    const repeatedStart = await start(fixture, runId);
    await expect(repeatedStart.json()).resolves.toMatchObject({ duplicate: true, status: "running" });
    const afterStartRetry = await env.DB.prepare("SELECT started_at FROM runs WHERE id = ?")
      .bind(runId).first<{ started_at: number }>();
    expect(afterStartRetry?.started_at).toBe(initial?.started_at);

    const body = {
      exit_code: 0,
      restic_version: "0.19.1",
      metrics: {
        bytes_processed: 1570181939,
        bytes_added: 135926784,
        files_new: 7,
        files_changed: 2,
        files_unmodified: 5,
        snapshot_id: "4e066584",
      },
    };
    const finished = await complete(fixture, runId, body);
    expect(finished.status).toBe(200);
    await expect(finished.json()).resolves.toMatchObject({ accepted: true, duplicate: false, status: "success" });
    const retried = await complete(fixture, runId, {
      metrics: body.metrics,
      restic_version: body.restic_version,
      exit_code: body.exit_code,
    });
    await expect(retried.json()).resolves.toMatchObject({ accepted: true, duplicate: true, status: "success" });
    expect((await complete(fixture, runId, { exit_code: 1 })).status).toBe(409);

    const stored = await env.DB.prepare(
      "SELECT status, exit_code, duration_ms, completion_hash FROM runs WHERE id = ?",
    ).bind(runId).first<{ status: string; exit_code: number; duration_ms: number; completion_hash: string }>();
    expect(stored).toMatchObject({ status: "success", exit_code: 0 });
    expect(stored?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(stored?.completion_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await env.DB.prepare("SELECT bytes_added, snapshot_id FROM run_metrics WHERE run_id = ?")
      .bind(runId).first()).toEqual({ bytes_added: 135926784, snapshot_id: "4e066584" });
  });

  it("maps partial and failed results to alerts routed to selected notification targets", async () => {
    const fixture = await createFixture("backup", true);
    const partialRunId = crypto.randomUUID();
    await start(fixture, partialRunId);
    const partial = await complete(fixture, partialRunId, { exit_code: 3 });
    await expect(partial.json()).resolves.toMatchObject({ status: "partial_success" });
    const alert = await env.DB.prepare(
      "SELECT rule_key, severity, status FROM alerts WHERE run_id = ?",
    ).bind(partialRunId).first();
    expect(alert).toEqual({ rule_key: "run_result", severity: "warning", status: "open" });
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM notification_deliveries WHERE alert_id IN (SELECT id FROM alerts WHERE run_id = ?)",
    ).bind(partialRunId).first()).toEqual({ count: 1 });

    const failedRunId = crypto.randomUUID();
    await start(fixture, failedRunId);
    await complete(fixture, failedRunId, {
      exit_code: 1,
      error_summary: `failed at /home/user/secret token=abc123 Authorization: Bearer bearer-secret RESTIC_PASSWORD=restic-secret ping=${fixture.token}`,
    });
    const failed = await env.DB.prepare(
      "SELECT status, error_summary FROM runs WHERE id = ?",
    ).bind(failedRunId).first<{ status: string; error_summary: string }>();
    expect(failed?.status).toBe("failed");
    expect(failed?.error_summary).not.toContain("/home/user/secret");
    expect(failed?.error_summary).not.toContain("abc123");
    expect(failed?.error_summary).not.toContain("bearer-secret");
    expect(failed?.error_summary).not.toContain("restic-secret");
    expect(failed?.error_summary).not.toContain(fixture.token);

    const quietFixture = await createFixture();
    const quietRunId = crypto.randomUUID();
    await start(quietFixture, quietRunId);
    await complete(quietFixture, quietRunId, { exit_code: 1 });
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM notification_deliveries WHERE alert_id IN (SELECT id FROM alerts WHERE run_id = ?)",
    ).bind(quietRunId).first()).toEqual({ count: 0 });
  });

  it("maps cancellation separately and treats unrecognized non-zero exit codes as failures", async () => {
    const fixture = await createFixture();
    const cancelledRunId = crypto.randomUUID();
    await start(fixture, cancelledRunId);
    await expect((await complete(fixture, cancelledRunId, { exit_code: 130 })).json())
      .resolves.toMatchObject({ status: "cancelled" });

    const unknownRunId = crypto.randomUUID();
    await start(fixture, unknownRunId);
    await expect((await complete(fixture, unknownRunId, { exit_code: 42 })).json())
      .resolves.toMatchObject({ status: "failed" });
  });

  it("accepts Repository stats only for successful stats Jobs", async () => {
    const fixture = await createFixture("stats");
    const runId = crypto.randomUUID();
    await start(fixture, runId);
    expect((await complete(fixture, runId, {
      exit_code: 0,
      metrics: { files_new: 1 },
    })).status).toBe(422);
    expect((await complete(fixture, runId, {
      exit_code: 1,
      repository_stats: { mode: "raw-data", value_bytes: 8192 },
    })).status).toBe(422);
    const response = await complete(fixture, runId, {
      exit_code: 0,
      repository_stats: {
        mode: "restore-size",
        value_bytes: 8192,
        total_file_count: 4,
        total_blob_count: 8,
        snapshots_count: 2,
      },
    });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT measurement_type, value_bytes FROM repository_stats WHERE source_run_id = ?",
    ).bind(runId).first()).toEqual({ measurement_type: "restic_restore_size", value_bytes: 8192 });
  });

  it("keeps completion-first results terminal when the delayed start ping arrives", async () => {
    const fixture = await createFixture();
    const runId = crypto.randomUUID();
    const completion = await complete(fixture, runId, { exit_code: 1 });
    await expect(completion.json()).resolves.toMatchObject({ status: "failed", duplicate: false });
    const lateStart = await start(fixture, runId);
    await expect(lateStart.json()).resolves.toMatchObject({ duplicate: true, status: "failed" });
    expect(await env.DB.prepare(
      "SELECT status, start_ping_received, duration_ms FROM runs WHERE id = ?",
    ).bind(runId).first()).toEqual({ status: "failed", start_ping_received: 0, duration_ms: null });
  });

  it("rejects malformed, oversized, invalid-token, and revoked-token requests", async () => {
    const fixture = await createFixture();
    const runId = crypto.randomUUID();
    expect((await exports.default.fetch(pingPath(fixture, runId, "start"), {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(400);
    const wrongToken = await exports.default.fetch(
      `http://localhost/api/v1/ping/rmp1_${"A".repeat(43)}/runs/${runId}/start`,
      { method: "POST" },
    );
    expect(wrongToken.status).toBe(401);
    expect((await exports.default.fetch(pingPath(fixture, "not-a-uuid", "start"), { method: "POST" })).status).toBe(400);
    expect((await exports.default.fetch(pingPath(fixture, runId, "complete"), { method: "POST", body: "{}" })).status).toBe(415);
    expect((await exports.default.fetch(pingPath(fixture, runId, "complete"), {
      method: "POST", headers: { "content-type": "application/json" }, body: "not-json",
    })).status).toBe(400);
    expect((await exports.default.fetch(pingPath(fixture, runId, "complete"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exit_code: 0, event_id: "old-field" }),
    })).status).toBe(422);

    const huge = JSON.stringify({ exit_code: 1, error_summary: "x".repeat(65_540) });
    expect((await exports.default.fetch(pingPath(fixture, runId, "complete"), {
      method: "POST", headers: { "content-type": "application/json" }, body: huge,
    })).status).toBe(413);

    const tokenHash = await sha256Hex(fixture.token);
    await env.DB.prepare("UPDATE job_ping_tokens SET revoked_at = ? WHERE token_hash = ?")
      .bind(Date.now(), tokenHash).run();
    expect((await start(fixture, crypto.randomUUID())).status).toBe(401);
  });

  it("allows multiple independent run IDs for one Job", async () => {
    const fixture = await createFixture();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await start(fixture, first);
    await start(fixture, second);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM runs WHERE job_id = ? AND status = 'running'")
      .bind(fixture.jobId).first()).toEqual({ count: 2 });
  });
});
