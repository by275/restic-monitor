#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";

const hostId = process.argv[2];
if (hostId === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) {
  console.error("Usage: pnpm token:mint <host-id>");
  process.exit(2);
}

const token = `rm1_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
const tokenId = randomUUID();
const createdAt = Date.now();

console.log("Reporter token (store securely; it cannot be recovered):");
console.log(token);
console.log("\nInsert this hash-only row after the host exists:");
console.log(
  `INSERT INTO api_tokens (id, host_id, token_prefix, token_hash, scopes_json, created_at) VALUES ('${tokenId}', '${hostId}', 'rm1_', '${tokenHash}', '[\"ingest\"]', ${createdAt});`,
);
