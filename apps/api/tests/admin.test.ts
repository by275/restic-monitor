import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const adminBase = "http://localhost/api/v1/admin";
const hostId = crypto.randomUUID();
const repositoryId = crypto.randomUUID();
const webhookUrl = "https://discord.com/api/webhooks/123456789012345678/test-webhook-token";

async function post(path: string, value: unknown) {
  return exports.default.fetch(`${adminBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function put(path: string, value: unknown) {
  return exports.default.fetch(`${adminBase}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function remove(path: string) {
  return exports.default.fetch(`${adminBase}${path}`, { method: "DELETE" });
}

describe("admin configuration API", () => {
  it("updates Host and Repository details, keeps stable keys, and protects referenced records from deletion", async () => {
    const now = Date.now();
    const localHostId = crypto.randomUUID();
    const unusedHostId = crypto.randomUUID();
    const localRepoId = crypto.randomUUID();
    const unusedRepoId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(localHostId, `host-${localHostId.slice(0, 8)}`, "Original host", now, now).run();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(unusedHostId, `host-${unusedHostId.slice(0, 8)}`, "Unused host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?), (?, ?, ?, 's3', ?, ?)`,
    ).bind(
      localRepoId, `repo-${localRepoId.slice(0, 8)}`, "Original repo", now, now,
      unusedRepoId, `repo-${unusedRepoId.slice(0, 8)}`, "Unused repo", now, now,
    ).run();

    const updatedHost = await put(`/hosts/${localHostId}`, { display_name: "Renamed host", enabled: false });
    expect(updatedHost.status).toBe(200);
    expect(await env.DB.prepare("SELECT name, display_name, enabled FROM hosts WHERE id = ?")
      .bind(localHostId).first()).toEqual({
      name: `host-${localHostId.slice(0, 8)}`,
      display_name: "Renamed host",
      enabled: 0,
    });
    expect((await put(`/hosts/${localHostId}`, { display_name: "", enabled: false })).status).toBe(422);
    expect((await remove(`/hosts/${unusedHostId}`)).status).toBe(204);

    const updatedRepository = await put(`/repositories/${localRepoId}`, {
      name: "Renamed repo",
      backend_type: "s3",
      enabled: false,
    });
    expect(updatedRepository.status).toBe(200);
    expect(await env.DB.prepare("SELECT repository_key, name, backend_type, enabled FROM repositories WHERE id = ?")
      .bind(localRepoId).first()).toEqual({
      repository_key: `repo-${localRepoId.slice(0, 8)}`,
      name: "Renamed repo",
      backend_type: "s3",
      enabled: 0,
    });
    expect((await remove(`/repositories/${unusedRepoId}`)).status).toBe(204);

    const job = await post("/jobs", {
      host_id: localHostId,
      name: "Linked backup",
      operation: "backup",
      max_runtime_seconds: 600,
      repositories: [{ repository_id: localRepoId, role: "repository" }],
      schedules: [{ schedule_type: "cron", expression: "0 3 * * *", timezone: "UTC", start_grace_seconds: 0 }],
    });
    expect(job.status).toBe(422);
    const reenableHost = await put(`/hosts/${localHostId}`, { display_name: "Renamed host", enabled: true });
    const reenableRepo = await put(`/repositories/${localRepoId}`, {
      name: "Renamed repo",
      backend_type: "s3",
      enabled: true,
    });
    expect(reenableHost.status).toBe(200);
    expect(reenableRepo.status).toBe(200);

    const jobInput = {
      host_id: localHostId,
      name: "Linked backup",
      operation: "backup",
      max_runtime_seconds: 600,
      repositories: [{ repository_id: localRepoId, role: "repository" }],
      schedules: [{ schedule_type: "cron", expression: "0 3 * * *", timezone: "UTC", start_grace_seconds: 0 }],
    };
    const createdJob = await post("/jobs", jobInput);
    expect(createdJob.status).toBe(201);
    const { id: jobId } = await createdJob.json() as { id: string };
    expect((await put(`/hosts/${localHostId}`, { display_name: "Renamed host", enabled: false })).status).toBe(200);
    expect((await put(`/repositories/${localRepoId}`, {
      name: "Renamed repo",
      backend_type: "s3",
      enabled: false,
    })).status).toBe(200);
    const editedWithHiddenReferences = await put(`/jobs/${jobId}`, { ...jobInput, name: "Still linked" });
    expect(editedWithHiddenReferences.status).toBe(200);
    const blockedHostDelete = await remove(`/hosts/${localHostId}`);
    expect(blockedHostDelete.status).toBe(409);
    await expect(blockedHostDelete.json()).resolves.toMatchObject({ error: "host_in_use", jobs_count: 1 });
    const blockedRepositoryDelete = await remove(`/repositories/${localRepoId}`);
    expect(blockedRepositoryDelete.status).toBe(409);
    await expect(blockedRepositoryDelete.json()).resolves.toMatchObject({
      error: "repository_in_use",
      jobs_count: 1,
      runs_count: 0,
      stats_count: 0,
    });
  });

  it("creates inventory and a server-configured Job with a one-time ping URL", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(hostId, `host-${hostId.slice(0, 8)}`, "Test Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?)`,
    ).bind(repositoryId, `repo-${repositoryId.slice(0, 8)}`, "Test Repository", now, now).run();

    const targetResponse = await post("/notification-targets", {
      name: "Ops Discord",
      provider: "discord",
      config: { webhook_url: webhookUrl },
    });
    expect(targetResponse.status).toBe(201);
    const target = await targetResponse.json() as { id: string; provider: string };
    expect(target.provider).toBe("discord");
    expect(JSON.stringify(target)).not.toContain(webhookUrl);

    const response = await post("/jobs", {
      host_id: hostId,
      name: "Nightly backup",
      description: "Test job",
      operation: "backup",
      max_runtime_seconds: 7200,
      notification_target_ids: [target.id],
      tags: ["production", "restic"],
      repositories: [{ repository_id: repositoryId, role: "repository" }],
      schedules: [
        { schedule_type: "cron", expression: "0 3 * * *", timezone: "Asia/Seoul", start_grace_seconds: 600 },
        { schedule_type: "cron", expression: "0 4 * * 0", timezone: "Asia/Seoul", start_grace_seconds: 900 },
      ],
    });

    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; slug: string; ping_url: string; token_shown_once: boolean };
    expect(created.slug).toBe("nightly-backup");
    expect(created.token_shown_once).toBe(true);
    expect(created.ping_url).toMatch(/^http:\/\/localhost\/api\/v1\/ping\/rmp1_[A-Za-z0-9_-]{43}$/);

    const token = new URL(created.ping_url).pathname.split("/").at(-1)!;
    const tokenRow = await env.DB.prepare(
      "SELECT token_hash, token_prefix, revoked_at FROM job_ping_tokens WHERE job_id = ?",
    ).bind(created.id).first<{ token_hash: string; token_prefix: string; revoked_at: number | null }>();
    expect(tokenRow?.token_hash).not.toBe(token);
    expect(tokenRow?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenRow?.token_prefix).toBe(token.slice(0, 9));
    expect(tokenRow?.revoked_at).toBeNull();

    const listing = await exports.default.fetch(`${adminBase}/jobs`);
    const listed = await listing.json() as { data: Array<Record<string, unknown>> };
    const job = listed.data.find((item) => item.id === created.id)!;
    expect(job.tags).toEqual(["production", "restic"]);
    expect(job.schedules).toHaveLength(2);
    expect(job.repositories).toMatchObject([{ repository_id: repositoryId, role: "repository" }]);
    expect(job.notification_targets).toMatchObject([{ id: target.id, name: "Ops Discord", provider: "discord", enabled: true }]);
    expect(JSON.stringify(job)).not.toContain(token);
    expect(JSON.stringify(job)).not.toContain(webhookUrl);
    const targets = await exports.default.fetch(`${adminBase}/notification-targets`);
    const targetsJson = await targets.text();
    expect(targetsJson).toContain("Ops Discord");
    expect(targetsJson).not.toContain(webhookUrl);
    expect(await env.DB.prepare("SELECT config_json FROM notification_targets WHERE id = ?")
      .bind(target.id).first<{ config_json: string }>()).toMatchObject({ config_json: expect.stringContaining(webhookUrl) });

    const duplicate = await post("/jobs", {
      host_id: hostId,
      slug: created.slug,
      name: "Duplicate slug",
      operation: "backup",
      max_runtime_seconds: 600,
      repositories: [{ repository_id: repositoryId, role: "repository" }],
      schedules: [{ schedule_type: "cron", expression: "0 3 * * *", timezone: "UTC", start_grace_seconds: 0 }],
    });
    expect(duplicate.status).toBe(409);
    const invalidWebhook = await post("/notification-targets", {
      name: "Invalid webhook",
      provider: "discord",
      config: { webhook_url: "https://attacker.example/webhook" },
    });
    expect(invalidWebhook.status).toBe(422);
  });

  it("rejects invalid schedule and an operation with the wrong repository role", async () => {
    const now = Date.now();
    const localHostId = crypto.randomUUID();
    const localRepoId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(localHostId, `host-${localHostId.slice(0, 8)}`, "Validation Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?)`,
    ).bind(localRepoId, `repo-${localRepoId.slice(0, 8)}`, "Validation Repository", now, now).run();

    const template = {
      host_id: localHostId,
      name: "Bad Job",
      operation: "backup",
      max_runtime_seconds: 600,
      repositories: [{ repository_id: localRepoId, role: "repository" }],
      schedules: [{ schedule_type: "cron", expression: "61 * * * *", timezone: "UTC", start_grace_seconds: 0 }],
    };
    expect((await post("/jobs", template)).status).toBe(422);
    expect((await post("/jobs", {
      ...template,
      schedules: [{ ...template.schedules[0], expression: "0 * * * *", timezone: "Not/A_Timezone" }],
    })).status).toBe(422);
    expect((await post("/jobs", {
      ...template,
      schedules: [{ ...template.schedules[0], expression: "0 * * * *" }],
      repositories: [{ repository_id: localRepoId, role: "target" }],
    })).status).toBe(422);
  });

  it("updates Job configuration, can disable it, and keeps its Host association immutable", async () => {
    const now = Date.now();
    const localHostId = crypto.randomUUID();
    const otherHostId = crypto.randomUUID();
    const localRepoId = crypto.randomUUID();
    for (const [id, name] of [[localHostId, "edit-host"], [otherHostId, "other-host"]]) {
      await env.DB.prepare(
        "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, `${name}-${id.slice(0, 8)}`, name, now, now).run();
    }
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?)`,
    ).bind(localRepoId, `repo-${localRepoId.slice(0, 8)}`, "Editable Repository", now, now).run();
    const targetResponse = await post("/notification-targets", {
      name: "Editable notification",
      provider: "discord",
      config: { webhook_url: webhookUrl },
    });
    const target = await targetResponse.json() as { id: string };
    const input = {
      host_id: localHostId,
      slug: "editable-job",
      name: "Editable Job",
      operation: "backup",
      max_runtime_seconds: 600,
      notification_target_ids: [target.id],
      enabled: true,
      tags: ["daily"],
      repositories: [{ repository_id: localRepoId, role: "repository" }],
      schedules: [{ schedule_type: "cron", expression: "0 5 * * *", timezone: "UTC", start_grace_seconds: 60 }],
    };
    const created = await post("/jobs", input);
    const { id, ping_url } = await created.json() as { id: string; ping_url: string };

    const updated = await put(`/jobs/${id}`, {
      ...input,
      name: "Disabled Job",
      max_runtime_seconds: 900,
      enabled: false,
      tags: ["maintenance", "nightly"],
      schedules: [{ ...input.schedules[0], expression: "30 5 * * *", start_grace_seconds: 120 }],
    });
    expect(updated.status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT host_id, name, enabled, max_runtime_seconds FROM jobs WHERE id = ?",
    ).bind(id).first()).toEqual({
      host_id: localHostId,
      name: "Disabled Job",
      enabled: 0,
      max_runtime_seconds: 900,
    });
    expect(await env.DB.prepare("SELECT target_id FROM job_notification_targets WHERE job_id = ?")
      .bind(id).first()).toEqual({ target_id: target.id });
    expect(await env.DB.prepare("SELECT tag FROM job_tags WHERE job_id = ? ORDER BY tag")
      .bind(id).all()).toMatchObject({ results: [{ tag: "maintenance" }, { tag: "nightly" }] });

    const removeTarget = await put(`/jobs/${id}`, {
      ...input,
      name: "Keep webhook",
      notification_target_ids: [],
      enabled: false,
    });
    expect(removeTarget.status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM job_notification_targets WHERE job_id = ?")
      .bind(id).first()).toEqual({ count: 0 });
    const token = new URL(ping_url).pathname.split("/").at(-1)!;
    expect((await exports.default.fetch(
      `http://localhost/api/v1/ping/${token}/runs/${crypto.randomUUID()}/start`,
      { method: "POST" },
    )).status).toBe(401);

    const moved = await put(`/jobs/${id}`, { ...input, host_id: otherHostId });
    expect(moved.status).toBe(409);
    await expect(moved.json()).resolves.toEqual({ error: "job_host_is_immutable" });
  });

  it("manages reusable Telegram targets without exposing credentials and guards Job references", async () => {
    const botToken = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const create = await post("/notification-targets", {
      name: "Telegram operations",
      provider: "telegram",
      config: { bot_token: botToken, chat_id: "-1001234567890" },
    });
    expect(create.status).toBe(201);
    const target = await create.json() as { id: string; provider: string };
    expect(target.provider).toBe("telegram");

    const listing = await exports.default.fetch(`${adminBase}/notification-targets`);
    const listingText = await listing.text();
    expect(listingText).toContain("Telegram operations");
    expect(listingText).not.toContain(botToken);
    expect(listingText).not.toContain("-1001234567890");

    const preserve = await put(`/notification-targets/${target.id}`, {
      name: "Telegram alerts",
      provider: "telegram",
      enabled: false,
    });
    expect(preserve.status).toBe(200);
    expect(await env.DB.prepare("SELECT config_json, enabled FROM notification_targets WHERE id = ?")
      .bind(target.id).first<{ config_json: string; enabled: number }>()).toMatchObject({
      config_json: JSON.stringify({ bot_token: botToken, chat_id: "-1001234567890" }),
      enabled: 0,
    });
    expect((await put(`/notification-targets/${target.id}`, {
      name: "Provider switch",
      provider: "discord",
    })).status).toBe(409);
    expect((await post("/notification-targets", {
      name: "Bad Telegram",
      provider: "telegram",
      config: { bot_token: botToken, chat_id: "bad chat id" },
    })).status).toBe(422);

    const now = Date.now();
    const localHostId = crypto.randomUUID();
    const localRepoId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(localHostId, `target-host-${localHostId.slice(0, 8)}`, "Target Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?)`,
    ).bind(localRepoId, `target-repo-${localRepoId.slice(0, 8)}`, "Target Repository", now, now).run();
    const jobInput = {
      host_id: localHostId,
      name: "Telegram Job",
      operation: "backup",
      max_runtime_seconds: 600,
      notification_target_ids: [target.id],
      repositories: [{ repository_id: localRepoId, role: "repository" }],
      schedules: [{ schedule_type: "cron", expression: "0 3 * * *", timezone: "UTC", start_grace_seconds: 0 }],
    };
    expect((await post("/jobs", jobInput)).status).toBe(422);
    const enable = await put(`/notification-targets/${target.id}`, {
      name: "Telegram alerts",
      provider: "telegram",
      enabled: true,
      config: { bot_token: botToken, chat_id: "-1001234567890" },
    });
    expect(enable.status).toBe(200);
    const createdJob = await post("/jobs", jobInput);
    expect(createdJob.status).toBe(201);
    const { id: jobId } = await createdJob.json() as { id: string };
    const blockedDelete = await remove(`/notification-targets/${target.id}`);
    expect(blockedDelete.status).toBe(409);
    await expect(blockedDelete.json()).resolves.toMatchObject({ error: "notification_target_in_use", jobs_count: 1 });
    expect((await put(`/jobs/${jobId}`, { ...jobInput, notification_target_ids: [] })).status).toBe(200);

    const alertId = crypto.randomUUID();
    const createdAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO alerts (
         id, dedupe_key, rule_key, severity, status, host_id, job_id, message, opened_at, created_at
       ) VALUES (?, ?, 'run_timeout', 'critical', 'open', ?, ?, 'Pending alert', ?, ?)`,
    ).bind(alertId, `target-delete:${alertId}`, localHostId, jobId, createdAt, createdAt).run();
    await env.DB.prepare(
      `INSERT INTO notification_deliveries (
         id, alert_id, target_id, provider, target_name, notification_type, status,
         attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'telegram', 'Telegram alerts', 'open', 'pending', 0, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), alertId, target.id, createdAt, createdAt, createdAt).run();
    expect((await remove(`/notification-targets/${target.id}`)).status).toBe(204);
    expect(await env.DB.prepare(
      "SELECT status, last_error, target_name, provider FROM notification_deliveries WHERE alert_id = ?",
    ).bind(alertId).first()).toEqual({
      status: "dead",
      last_error: "notification_target_deleted",
      target_name: "Telegram alerts",
      provider: "telegram",
    });
  });

  it("rotates the capability token and rejects administration on another hostname", async () => {
    const now = Date.now();
    const localHostId = crypto.randomUUID();
    const localRepoId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(localHostId, `host-${localHostId.slice(0, 8)}`, "Rotate Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?)`,
    ).bind(localRepoId, `repo-${localRepoId.slice(0, 8)}`, "Rotate Repository", now, now).run();
    const createdResponse = await post("/jobs", {
      host_id: localHostId,
      slug: "rotate-me",
      name: "Rotate me",
      operation: "backup",
      max_runtime_seconds: 600,
      repositories: [{ repository_id: localRepoId, role: "repository" }],
      schedules: [{ schedule_type: "cron", expression: "0 5 * * *", timezone: "UTC", start_grace_seconds: 0 }],
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; ping_url: string };
    const oldToken = new URL(created.ping_url).pathname.split("/").at(-1)!;

    const rotatedResponse = await exports.default.fetch(`${adminBase}/jobs/${created.id}/rotate-ping-token`, {
      method: "POST",
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { ping_url: string };
    const newToken = new URL(rotated.ping_url).pathname.split("/").at(-1)!;
    expect(newToken).not.toBe(oldToken);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM job_ping_tokens WHERE job_id = ? AND revoked_at IS NULL",
    ).bind(created.id).first()).toEqual({ count: 1 });
    const oldPing = await exports.default.fetch(
      `http://localhost/api/v1/ping/${oldToken}/runs/${crypto.randomUUID()}/start`,
      { method: "POST" },
    );
    expect(oldPing.status).toBe(401);
    const newPing = await exports.default.fetch(
      `http://localhost/api/v1/ping/${newToken}/runs/${crypto.randomUUID()}/start`,
      { method: "POST" },
    );
    expect(newPing.status).toBe(200);

    const blocked = await exports.default.fetch("http://public.example/api/v1/admin/hosts");
    expect(blocked.status).toBe(404);
  });
});
