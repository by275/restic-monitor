import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/protocol/test/**/*.test.ts"],
    environment: "node",
  },
});
