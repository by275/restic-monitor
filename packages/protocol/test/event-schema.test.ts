import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/event-v1.schema.json", import.meta.url), "utf8"),
);
const started = JSON.parse(
  readFileSync(new URL("../examples/run.started.json", import.meta.url), "utf8"),
);
const completed = JSON.parse(
  readFileSync(new URL("../examples/run.completed.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("event protocol v1 JSON Schema", () => {
  it("accepts the shared started and completed examples", () => {
    expect(validate(started), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(completed), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["client supplied host identity", { ...started, host: "untrusted-host" }],
    ["client supplied status", { ...completed, status: "success" }],
    ["started event with a result", { ...started, result: completed.result }],
    ["completed event without a result", { ...completed, result: undefined }],
    ["copy without source repository", { ...started, operation: "copy" }],
    ["non-UTC event timestamp", { ...started, occurred_at: "2026-10-11T05:00:00+09:00" }],
    ["negative metric", { ...completed, result: { ...completed.result, metrics: { bytes_added: -1 } } }],
    ["metric beyond exact JSON integer range", { ...completed, result: { ...completed.result, metrics: { bytes_added: 9007199254740992 } } }],
    ["oversized error summary", { ...completed, result: { ...completed.result, error_summary: "x".repeat(1025) } }],
  ])("rejects %s", (_label, event) => {
    expect(validate(event)).toBe(false);
  });

  it("allows additive envelope fields for forward-compatible clients", () => {
    const additiveEvent = { ...started, future_extension: { sequence: 2 } };

    expect(validate(additiveEvent), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a copy event with explicit source and target repositories", () => {
    expect(
      validate({ ...started, operation: "copy", source_repository_key: "repo-source" }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it("keeps the schema and fixtures in one stable location", () => {
    expect(fileURLToPath(new URL("../schemas/event-v1.schema.json", import.meta.url))).toContain(
      "event-v1.schema.json",
    );
  });
});
