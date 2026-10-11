import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

type TestBindings = typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

beforeAll(async () => {
  const testEnv = env as TestBindings;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
