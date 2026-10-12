import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const adminBase = "http://localhost/api/v1/admin";
const hostId = crypto.randomUUID();
const repositoryId = crypto.randomUUID();

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

describe("admin configuration API", () => {
  it("creates inventory and a server-configured Job with a one-time ping URL", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(hostId, `host-${hostId.slice(0, 8)}`, "Test Host", now, now).run();
    await env.DB.prepare(
      `INSERT INTO repositories (id, repository_key, name, backend_type, created_at, updated_at)
       VALUES (?, ?, ?, 'local', ?, ?)`,
    ).bind(repositoryId, `repo-${repositoryId.slice(0, 8)}`, "Test Repository", now, now).run();

    const response = await post("/jobs", {
      host_id: hostId,
      name: "Nightly backup",
      description: "Test job",
      operation: "backup",
      max_runtime_seconds: 7200,
      discord_enabled: true,
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
    expect(JSON.stringify(job)).not.toContain(token);

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
    const input = {
      host_id: localHostId,
      slug: "editable-job",
      name: "Editable Job",
      operation: "backup",
      max_runtime_seconds: 600,
      discord_enabled: true,
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
      discord_enabled: false,
      enabled: false,
      tags: ["maintenance", "nightly"],
      schedules: [{ ...input.schedules[0], expression: "30 5 * * *", start_grace_seconds: 120 }],
    });
    expect(updated.status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT host_id, name, enabled, discord_enabled, max_runtime_seconds FROM jobs WHERE id = ?",
    ).bind(id).first()).toEqual({
      host_id: localHostId,
      name: "Disabled Job",
      enabled: 0,
      discord_enabled: 0,
      max_runtime_seconds: 900,
    });
    expect(await env.DB.prepare("SELECT tag FROM job_tags WHERE job_id = ? ORDER BY tag")
      .bind(id).all()).toMatchObject({ results: [{ tag: "maintenance" }, { tag: "nightly" }] });
    const token = new URL(ping_url).pathname.split("/").at(-1)!;
    expect((await exports.default.fetch(
      `http://localhost/api/v1/ping/${token}/runs/${crypto.randomUUID()}/start`,
      { method: "POST" },
    )).status).toBe(401);

    const moved = await put(`/jobs/${id}`, { ...input, host_id: otherHostId });
    expect(moved.status).toBe(409);
    await expect(moved.json()).resolves.toEqual({ error: "job_host_is_immutable" });
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
