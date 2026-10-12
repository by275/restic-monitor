import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateDeploymentConfig } from "./deploy-config.mjs";

const sourceConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const validEnv = {
  DEPLOY_WORKER_NAME: "restic-monitor-prod",
  DEPLOY_ADMIN_HOST: "monitor.example.com",
  DEPLOY_PING_HOST: "ingest.example.com",
  DEPLOY_D1_DATABASE_NAME: "restic-monitor-prod",
  DEPLOY_D1_DATABASE_ID: "12345678-1234-4234-8234-123456789abc",
};

test("deployment variables override only the production config values", () => {
  const config = generateDeploymentConfig(sourceConfig, validEnv);
  assert.equal(config.name, "restic-monitor-prod");
  assert.deepEqual(config.vars, {
    ...sourceConfig.vars,
    ADMIN_HOST: "monitor.example.com",
    PING_BASE_URL: "https://ingest.example.com",
  });
  assert.deepEqual(config.d1_databases, [{
    ...sourceConfig.d1_databases[0],
    database_name: "restic-monitor-prod",
    database_id: validEnv.DEPLOY_D1_DATABASE_ID,
  }]);
  assert.deepEqual(config.routes, [
    { pattern: "monitor.example.com", custom_domain: true },
    { pattern: "ingest.example.com", custom_domain: true },
  ]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.main, sourceConfig.main);
  assert.equal(config.assets.directory, sourceConfig.assets.directory);
  assert.deepEqual(config.triggers, sourceConfig.triggers);
  assert.equal(sourceConfig.name, "restic-monitor");
  assert.equal(sourceConfig.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000001");
});

test("optional account and compatibility overrides are validated and applied", () => {
  const config = generateDeploymentConfig(sourceConfig, {
    ...validEnv,
    DEPLOY_ACCOUNT_ID: "abcdef0123456789abcdef0123456789",
    DEPLOY_COMPATIBILITY_DATE: "2026-10-12",
  });
  assert.equal(config.account_id, "abcdef0123456789abcdef0123456789");
  assert.equal(config.compatibility_date, "2026-10-12");
});

test("required values and unsupported DEPLOY variables are rejected", () => {
  assert.throws(() => generateDeploymentConfig(sourceConfig, {}), /Missing required deployment variable/);
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_ADMIN_HOST: "" }), /DEPLOY_ADMIN_HOST/);
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_TELEGRAM_TOKEN: "secret" }), /Unsupported deployment variable.*DEPLOY_TELEGRAM_TOKEN/);
});

test("hostnames must be separate public DNS names", () => {
  for (const invalidHost of ["https://monitor.example.com", "monitor.example.com/path", "localhost", "monitor.example.com:443", "monitor.example.com."]) {
    assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_ADMIN_HOST: invalidHost }), /DEPLOY_ADMIN_HOST/);
  }
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_PING_HOST: "MONITOR.EXAMPLE.COM" }), /must be different/);
});

test("invalid Worker, D1, account, and compatibility values are rejected", () => {
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_WORKER_NAME: "Restic Monitor" }), /DEPLOY_WORKER_NAME/);
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_D1_DATABASE_NAME: "bad/name" }), /DEPLOY_D1_DATABASE_NAME/);
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000001" }), /tracked placeholder/);
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000" }), /DEPLOY_D1_DATABASE_ID/);
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_ACCOUNT_ID: "not-an-account" }), /DEPLOY_ACCOUNT_ID/);
  assert.throws(() => generateDeploymentConfig(sourceConfig, { ...validEnv, DEPLOY_COMPATIBILITY_DATE: "2026-02-30" }), /DEPLOY_COMPATIBILITY_DATE/);
});

test("tracked config must contain the DB binding", () => {
  assert.throws(() => generateDeploymentConfig({ ...sourceConfig, d1_databases: [] }, validEnv), /DB D1 binding/);
});

test("deployment config output is ignored by Git", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.wrangler\.deploy\.jsonc$/m);
});
