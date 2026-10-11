import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.resolve(process.cwd(), "apps/api/migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    include: ["apps/api/tests/**/*.test.ts"],
    setupFiles: ["./test/setup-workers.ts"],
  },
});
