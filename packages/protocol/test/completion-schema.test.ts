import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/completion-v1.schema.json", import.meta.url), "utf8"),
);
const backup = JSON.parse(
  readFileSync(new URL("../examples/complete.backup.json", import.meta.url), "utf8"),
);
const stats = JSON.parse(
  readFileSync(new URL("../examples/complete.stats.json", import.meta.url), "utf8"),
);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

describe("ping completion contract v1", () => {
  it("accepts compact backup and repository stats completions", () => {
    expect(validate(backup), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(stats), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ exit_code: 1 }), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["missing exit code", {}],
    ["string exit code", { exit_code: "0" }],
    ["negative exit code", { exit_code: -1 }],
    ["exit code above 255", { exit_code: 256 }],
    ["negative metric", { exit_code: 0, metrics: { bytes_added: -1 } }],
    ["unsafe integer metric", { exit_code: 0, metrics: { bytes_added: 9007199254740992 } }],
    ["unknown metric", { exit_code: 0, metrics: { files_skipped: 1 } }],
    ["oversized error summary", { exit_code: 1, error_summary: "x".repeat(1025) }],
    ["unsupported stats mode", { exit_code: 0, repository_stats: { mode: "total_size", value_bytes: 1 } }],
    ["unsafe stats value", { exit_code: 0, repository_stats: { mode: "raw-data", value_bytes: 9007199254740992 } }],
    ["unneeded event metadata", { exit_code: 0, event_id: "event-1", schema_version: 1 }],
  ])("rejects %s", (_label, body) => {
    expect(validate(body)).toBe(false);
  });

  it("keeps completion fixtures under the versioned contract", () => {
    expect(fileURLToPath(new URL("../schemas/completion-v1.schema.json", import.meta.url)))
      .toContain("completion-v1.schema.json");
  });
});
