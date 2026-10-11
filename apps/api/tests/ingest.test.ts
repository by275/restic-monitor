import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

let tokenCounter = 0;

interface Fixture {
  token: string;
  hostId: string;
  jobId: string;
  jobKey: string;
  repositoryKey: string;
  secondaryRepositoryKey: string;
  sourceRepositoryKey: string;
  targetRepositoryKey: string;
  now: number;
}

interface AcceptedResponse {
  event_id: string;
  accepted: boolean;
  duplicate: boolean;
  received_at: string;
}

async function seedFixture(options: {
  scopes?: string;
  expiresAt?: number | null;
  revokedAt?: number | null;
} = {}): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const now = Date.now();
  const hostId = `host-${suffix}`;
  const jobId = `job-${suffix}`;
  const jobKey = `daily-${suffix}`;
  const repositoryKey = `repo-${suffix}`;
  const secondaryRepositoryKey = `repo2-${suffix}`;
  const sourceRepositoryKey = `source-${suffix}`;
  const targetRepositoryKey = `target-${suffix}`;
  const tokenBytes = new Uint8Array(32).fill(++tokenCounter);
  const token = `rm1_${btoa(String.fromCharCode(...tokenBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
  const tokenHash = await digestHex(new TextEncoder().encode(token));
  const tokenId = `token-${suffix}`;

  await env.DB.prepare(
    "INSERT INTO hosts (id, name, display_name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(hostId, `host-${suffix}`, "Test Host", now)
    .run();
  await env.DB.prepare(
    "INSERT INTO jobs (id, host_id, job_key, name, schedule, timezone, grace_seconds, timeout_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(jobId, hostId, jobKey, "Daily backup", "0 5 * * *", "UTC", 300, 3600, now)
    .run();

  const repositories = [
    { id: `repository-${suffix}`, key: repositoryKey, role: "repository" },
    { id: `repository2-${suffix}`, key: secondaryRepositoryKey, role: "repository" },
    { id: `source-repository-${suffix}`, key: sourceRepositoryKey, role: "source" },
    { id: `target-repository-${suffix}`, key: targetRepositoryKey, role: "target" },
    { id: `unlinked-repository-${suffix}`, key: `foreign-${suffix}`, role: null },
  ] as const;
  for (const repository of repositories) {
    await env.DB.prepare(
      "INSERT INTO repositories (id, repository_key, name, backend_type, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(repository.id, repository.key, repository.key, "s3", now)
      .run();
    if (repository.role !== null) {
      await env.DB.prepare(
        "INSERT INTO job_repositories (job_id, repository_id, role) VALUES (?, ?, ?)",
      )
        .bind(jobId, repository.id, repository.role)
        .run();
    }
  }
  await env.DB.prepare(
    `INSERT INTO api_tokens (
       id, host_id, token_prefix, token_hash, scopes_json, expires_at, revoked_at, created_at
     ) VALUES (?, ?, 'rm1_', ?, ?, ?, ?, ?)`,
  )
    .bind(
      tokenId,
      hostId,
      tokenHash,
      options.scopes ?? '["ingest"]',
      options.expiresAt ?? null,
      options.revokedAt ?? null,
      now,
    )
    .run();

  return {
    token,
    hostId,
    jobId,
    jobKey,
    repositoryKey,
    secondaryRepositoryKey,
    sourceRepositoryKey,
    targetRepositoryKey,
    now,
  };
}

function startEvent(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const startedAt = fixture.now - 30_000;
  return {
    schema_version: 1,
    event_id: `event-start-${crypto.randomUUID().replaceAll("-", "")}`,
    run_id: `run-${crypto.randomUUID().replaceAll("-", "")}`,
    workflow_id: `workflow-${crypto.randomUUID().replaceAll("-", "")}`,
    event_type: "run.started",
    occurred_at: new Date(startedAt).toISOString(),
    job_key: fixture.jobKey,
    repository_key: fixture.repositoryKey,
    operation: "backup",
    client: { name: "restic-monitor-bash", version: "0.1.0", restic_version: "0.19.1" },
    ...overrides,
  };
}

function completedEvent(
  fixture: Fixture,
  overrides: {
    eventId?: string;
    runId?: string;
    operation?: string;
    repositoryKey?: string;
    sourceRepositoryKey?: string;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
    metrics?: Record<string, unknown>;
    errorSummary?: string;
  } = {},
) {
  const startedAt = overrides.startedAt ?? fixture.now - 10_000;
  const finishedAt = overrides.finishedAt ?? fixture.now - 5_000;
  const operation = overrides.operation ?? "backup";
  return {
    schema_version: 1,
    event_id: overrides.eventId ?? `event-complete-${crypto.randomUUID().replaceAll("-", "")}`,
    run_id: overrides.runId ?? `run-${crypto.randomUUID().replaceAll("-", "")}`,
    workflow_id: `workflow-${crypto.randomUUID().replaceAll("-", "")}`,
    event_type: "run.completed",
    occurred_at: new Date(finishedAt).toISOString(),
    job_key: fixture.jobKey,
    repository_key: overrides.repositoryKey ?? fixture.repositoryKey,
    ...(operation === "copy" ? { source_repository_key: overrides.sourceRepositoryKey ?? fixture.sourceRepositoryKey } : {}),
    operation,
    client: { name: "restic-monitor-bash", version: "0.1.0", restic_version: "0.19.1" },
    result: {
      exit_code: overrides.exitCode ?? 0,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      duration_ms: finishedAt - startedAt,
      ...(overrides.errorSummary === undefined ? {} : { error_summary: overrides.errorSummary }),
      ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
    },
  };
}

async function sendEvent(event: unknown, token?: string, rawBody?: string): Promise<Response> {
  const body = rawBody ?? JSON.stringify(event);
  return exports.default.fetch(
    new Request("http://localhost/api/v1/ingest/events", {
      method: "POST",
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
      },
      body,
    }),
  );
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function count(table: string, where: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${where} = ?`)
    .bind(value)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("event ingestion", () => {
  it("authenticates a Host token and atomically projects completed runs and metrics", async () => {
    const fixture = await seedFixture();
    const event = completedEvent(fixture, {
      metrics: {
        bytes_processed: 5000,
        bytes_added: 1250,
        bytes_added_packed: 900,
        files_new: 2,
        files_changed: 3,
        files_unmodified: 4,
        snapshot_id: "abcdef0123456789",
      },
      errorSummary: "backup completed",
    });

    const response = await sendEvent(event, fixture.token);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event_id: event.event_id,
      accepted: true,
      duplicate: false,
    });

    expect(
      await env.DB.prepare(
        "SELECT status, exit_code, started_at, finished_at, error_summary FROM runs WHERE id = ?",
      )
        .bind(event.run_id)
        .first(),
    ).toMatchObject({ status: "success", exit_code: 0, error_summary: "backup completed" });
    expect(
      await env.DB.prepare("SELECT bytes_processed, bytes_added, snapshot_id FROM run_metrics WHERE run_id = ?")
        .bind(event.run_id)
        .first(),
    ).toEqual({ bytes_processed: 5000, bytes_added: 1250, snapshot_id: "abcdef0123456789" });
    expect(await count("ingest_events", "run_id", event.run_id)).toBe(1);
    expect(await count("run_repositories", "run_id", event.run_id)).toBe(1);
  });

  it("maps partial, failed, cancelled and operation-specific exit codes", async () => {
    const fixture = await seedFixture();
    const cases = [
      { operation: "backup", exitCode: 3, expected: "partial_success" },
      { operation: "forget", exitCode: 3, expected: "partial_success" },
      { operation: "forget_prune", exitCode: 3, expected: "partial_success" },
      { operation: "prune", exitCode: 3, expected: "failed" },
      { operation: "backup", exitCode: 1, expected: "failed" },
      { operation: "check", exitCode: 130, expected: "cancelled" },
    ];

    for (const item of cases) {
      const event = completedEvent(fixture, { operation: item.operation, exitCode: item.exitCode });
      expect((await sendEvent(event, fixture.token)).status).toBe(200);
      const row = await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
        .bind(event.run_id)
        .first<{ status: string }>();
      expect(row?.status).toBe(item.expected);
    }
  });

  it("moves a run from running to its terminal result", async () => {
    const fixture = await seedFixture();
    const startedAt = fixture.now - 20_000;
    const start = startEvent(fixture, {
      occurred_at: new Date(startedAt).toISOString(),
    });
    expect((await sendEvent(start, fixture.token)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
        .bind(start.run_id)
        .first<{ status: string }>(),
    ).toEqual({ status: "running" });

    const completion = completedEvent(fixture, {
      runId: start.run_id,
      startedAt,
      finishedAt: fixture.now - 5_000,
    });
    completion.workflow_id = start.workflow_id;
    expect((await sendEvent(completion, fixture.token)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT status, started_at, finished_at FROM runs WHERE id = ?")
        .bind(start.run_id)
        .first(),
    ).toEqual({ status: "success", started_at: startedAt, finished_at: fixture.now - 5_000 });
    expect(await count("ingest_events", "run_id", start.run_id)).toBe(2);
  });

  it("marks a run timed out at the configured boundary and resolves the alert on late completion", async () => {
    const fixture = await seedFixture();
    await env.DB.prepare("UPDATE jobs SET timeout_seconds = 10 WHERE id = ?")
      .bind(fixture.jobId)
      .run();

    const startedAt = fixture.now - 30_000;
    const start = startEvent(fixture, { occurred_at: new Date(startedAt).toISOString() });
    expect((await sendEvent(start, fixture.token)).status).toBe(200);

    const timeoutAt = startedAt + 10_000;
    const worker = exports.default as typeof exports.default & {
      scheduled(controller: ScheduledController, env: { DB: D1Database }, context: ExecutionContext): Promise<void>;
    };
    const scheduledEvent = { cron: "*/5 * * * *", scheduledTime: timeoutAt } as ScheduledController;
    await worker.scheduled(scheduledEvent, env, {} as ExecutionContext);
    await worker.scheduled(scheduledEvent, env, {} as ExecutionContext);
    expect(
      await env.DB.prepare("SELECT status, finished_at FROM runs WHERE id = ?")
        .bind(start.run_id)
        .first(),
    ).toEqual({ status: "timed_out", finished_at: timeoutAt });
    expect(
      await env.DB.prepare("SELECT status FROM alerts WHERE run_id = ? AND rule_key = 'run_timeout'")
        .bind(start.run_id)
        .first(),
    ).toEqual({ status: "open" });
    expect(await count("alerts", "run_id", start.run_id)).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT notification_type, status FROM notification_deliveries
         WHERE alert_id = (SELECT id FROM alerts WHERE run_id = ? AND rule_key = 'run_timeout')
         ORDER BY notification_type`,
      )
        .bind(start.run_id)
        .all(),
    ).toMatchObject({ results: [{ notification_type: "open", status: "pending" }] });

    const completion = completedEvent(fixture, {
      runId: start.run_id,
      startedAt,
      finishedAt: timeoutAt,
    });
    completion.workflow_id = start.workflow_id;
    expect((await sendEvent(completion, fixture.token)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT status, finished_at FROM runs WHERE id = ?")
        .bind(start.run_id)
        .first(),
    ).toEqual({ status: "success", finished_at: timeoutAt });
    const resolvedAlert = await env.DB.prepare(
      "SELECT status, resolved_at FROM alerts WHERE run_id = ? AND rule_key = 'run_timeout'",
    )
      .bind(start.run_id)
      .first<{ status: string; resolved_at: number | null }>();
    expect(resolvedAlert?.status).toBe("resolved");
    expect(resolvedAlert?.resolved_at).toBeGreaterThan(timeoutAt);
    expect(
      await env.DB.prepare(
        `SELECT notification_type, status FROM notification_deliveries
         WHERE alert_id = (SELECT id FROM alerts WHERE run_id = ? AND rule_key = 'run_timeout')
         ORDER BY notification_type`,
      )
        .bind(start.run_id)
        .all(),
    ).toMatchObject({
      results: [
        { notification_type: "open", status: "pending" },
        { notification_type: "recovery", status: "pending" },
      ],
    });
  });

  it("accepts the same event only once and rejects event ID reuse with different bytes", async () => {
    const fixture = await seedFixture();
    const event = completedEvent(fixture);
    const body = JSON.stringify(event);
    const [first, retry] = await Promise.all([
      sendEvent(event, fixture.token, body),
      sendEvent(event, fixture.token, body),
    ]);
    const firstResult = await first.json() as AcceptedResponse;
    const retryResult = await retry.json() as AcceptedResponse;

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect([firstResult.duplicate, retryResult.duplicate].sort()).toEqual([false, true]);
    expect(retryResult.received_at).toBe(firstResult.received_at);
    expect(await count("ingest_events", "event_id", event.event_id)).toBe(1);

    const changedBody = `${body} `;
    expect((await sendEvent(event, fixture.token, changedBody)).status).toBe(409);
    expect(await count("ingest_events", "event_id", event.event_id)).toBe(1);
  });

  it("keeps a completed run terminal when its start event arrives late", async () => {
    const fixture = await seedFixture();
    const startedAt = fixture.now - 60_000;
    const finishedAt = fixture.now - 10_000;
    const completion = completedEvent(fixture, { startedAt, finishedAt });
    expect((await sendEvent(completion, fixture.token)).status).toBe(200);

    const lateStart = startEvent(fixture, {
      run_id: completion.run_id,
      workflow_id: completion.workflow_id,
      occurred_at: new Date(startedAt).toISOString(),
    });
    expect((await sendEvent(lateStart, fixture.token)).status).toBe(200);

    expect(
      await env.DB.prepare("SELECT status, finished_at FROM runs WHERE id = ?")
        .bind(completion.run_id)
        .first(),
    ).toMatchObject({ status: "success", finished_at: finishedAt });
    expect(await count("ingest_events", "run_id", completion.run_id)).toBe(2);
  });

  it("rejects conflicting completion and rolls back its event row", async () => {
    const fixture = await seedFixture();
    const first = completedEvent(fixture);
    expect((await sendEvent(first, fixture.token)).status).toBe(200);
    const conflicting = completedEvent(fixture, {
      runId: first.run_id,
      exitCode: 1,
    });
    conflicting.workflow_id = first.workflow_id;

    expect((await sendEvent(conflicting, fixture.token)).status).toBe(409);
    expect(await count("ingest_events", "event_id", conflicting.event_id)).toBe(0);
    expect(
      await env.DB.prepare("SELECT status, exit_code FROM runs WHERE id = ?")
        .bind(first.run_id)
        .first(),
    ).toEqual({ status: "success", exit_code: 0 });
  });

  it("rejects run identity and repository-role conflicts without partial writes", async () => {
    const fixture = await seedFixture();
    const first = startEvent(fixture);
    expect((await sendEvent(first, fixture.token)).status).toBe(200);

    const identityConflict = startEvent(fixture, {
      run_id: first.run_id,
      workflow_id: first.workflow_id,
      operation: "check",
    });
    expect((await sendEvent(identityConflict, fixture.token)).status).toBe(409);
    expect(await count("ingest_events", "event_id", identityConflict.event_id)).toBe(0);

    const repositoryConflict = startEvent(fixture, {
      run_id: first.run_id,
      workflow_id: first.workflow_id,
      repository_key: fixture.secondaryRepositoryKey,
    });
    expect((await sendEvent(repositoryConflict, fixture.token)).status).toBe(409);
    expect(await count("ingest_events", "event_id", repositoryConflict.event_id)).toBe(0);
    expect(await count("run_repositories", "run_id", first.run_id)).toBe(1);
  });

  it("validates token state, scope, Host Job and Repository associations", async () => {
    const noScope = await seedFixture({ scopes: "[\"read\"]" });
    expect((await sendEvent(startEvent(noScope), noScope.token)).status).toBe(403);

    const expired = await seedFixture({ expiresAt: Date.now() - 1000 });
    expect((await sendEvent(startEvent(expired), expired.token)).status).toBe(401);

    const revoked = await seedFixture({ revokedAt: Date.now() });
    expect((await sendEvent(startEvent(revoked), revoked.token)).status).toBe(401);

    const fixture = await seedFixture();
    const otherHost = await seedFixture();
    expect((await sendEvent(startEvent(fixture))).status).toBe(401);
    expect((await sendEvent(startEvent(fixture), `rm1_${"A".repeat(43)}`)).status).toBe(401);
    expect((await sendEvent(startEvent(fixture, { job_key: "unknown-job" }), fixture.token)).status).toBe(403);
    expect((await sendEvent(startEvent(fixture, {
      job_key: otherHost.jobKey,
      repository_key: otherHost.repositoryKey,
    }), fixture.token)).status).toBe(403);
    expect((await sendEvent(startEvent(fixture, { repository_key: `foreign-${fixture.hostId.slice(5)}` }), fixture.token)).status).toBe(403);
  });

  it("records copy source and target mappings and rejects an unlinked side", async () => {
    const fixture = await seedFixture();
    const event = completedEvent(fixture, {
      operation: "copy",
      repositoryKey: fixture.targetRepositoryKey,
      sourceRepositoryKey: fixture.sourceRepositoryKey,
    });
    expect((await sendEvent(event, fixture.token)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT role FROM run_repositories WHERE run_id = ? ORDER BY role")
        .bind(event.run_id)
        .all<{ role: string }>(),
    ).toMatchObject({ results: [{ role: "source" }, { role: "target" }] });

    const invalid = completedEvent(fixture, {
      operation: "copy",
      repositoryKey: fixture.targetRepositoryKey,
      sourceRepositoryKey: `foreign-${fixture.hostId.slice(5)}`,
    });
    expect((await sendEvent(invalid, fixture.token)).status).toBe(403);
    expect(await count("ingest_events", "event_id", invalid.event_id)).toBe(0);
  });

  it("rejects unsupported media types, malformed JSON, oversized bodies, schema and time violations", async () => {
    const fixture = await seedFixture();
    const noContentType = await exports.default.fetch(
      new Request("http://localhost/api/v1/ingest/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "text/plain" },
        body: "{}",
      }),
    );
    expect(noContentType.status).toBe(415);
    expect((await sendEvent({}, fixture.token, "{")).status).toBe(400);
    expect((await sendEvent({}, fixture.token, " ".repeat(65_537))).status).toBe(413);

    const invalidSchema = startEvent(fixture, { host: "untrusted-host" });
    expect((await sendEvent(invalidSchema, fixture.token)).status).toBe(422);

    const mismatchedDuration = completedEvent(fixture);
    mismatchedDuration.result.duration_ms += 5000;
    expect((await sendEvent(mismatchedDuration, fixture.token)).status).toBe(422);

    const unsupportedMetrics = completedEvent(fixture, {
      operation: "check",
      metrics: { bytes_processed: 1234 },
    });
    expect((await sendEvent(unsupportedMetrics, fixture.token)).status).toBe(422);

    const future = startEvent(fixture, {
      occurred_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    expect((await sendEvent(future, fixture.token)).status).toBe(422);
  });

  it("redacts credentials, URLs and local paths before persisting an error summary", async () => {
    const fixture = await seedFixture();
    const event = completedEvent(fixture, {
      exitCode: 1,
      errorSummary: "token=secret123 failed at /var/lib/restic/data using s3://user:pass@example/repo",
    });
    expect((await sendEvent(event, fixture.token)).status).toBe(200);
    const row = await env.DB.prepare("SELECT error_summary FROM runs WHERE id = ?")
      .bind(event.run_id)
      .first<{ error_summary: string }>();
    expect(row?.error_summary).not.toContain("secret123");
    expect(row?.error_summary).not.toContain("/var/lib/restic/data");
    expect(row?.error_summary).not.toContain("s3://");
    expect(row?.error_summary.length).toBeLessThanOrEqual(1024);
  });
});
