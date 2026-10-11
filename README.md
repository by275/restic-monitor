# Restic Monitor

Restic Monitor records backup job events while leaving the existing Docker, cron, and Restic execution model in place. The current implementation accepts authenticated run events and projects them into D1. It does not change a backup host; the Bash Reporter and spool/retry queue are a later phase.

## Requirements

- Node.js 22.12 or newer
- Corepack-enabled pnpm (the repository pins pnpm 12.11.2)

## Local setup

```sh
corepack pnpm install
corepack pnpm db:migrate:local
corepack pnpm dev
```

Open `http://localhost:8787/healthz`; the expected response is `{"ok":true,"service":"restic-monitor"}`. Wrangler uses its local D1 database for these commands. No Cloudflare account or production binding is needed for local development.

The phase 2 event endpoint is `POST /api/v1/ingest/events`; it requires an `application/json` event v1 body and a Host-scoped Bearer token. It accepts at most 65,536 body bytes and stores only the payload hash in the idempotency ledger.

To provision a local reporter token, first create its Host, Job, Repository, and Job/Repository associations in D1. Run `corepack pnpm token:mint <host-id>` and keep the printed token securely; insert the generated SQL row, which contains only the token hash. The token itself is shown once and cannot be recovered from D1.

## Checks

```sh
corepack pnpm test
corepack pnpm typecheck
```

`test:protocol` validates the versioned event examples and rejection cases with JSON Schema. `test:worker` runs the Worker in the Cloudflare Workers Vitest runtime and applies the D1 migrations to an isolated local database before checking constraints.

Wrangler binding types are generated in `worker-configuration.d.ts`, with runtime API types supplied by the pinned official `@cloudflare/workers-types` package. Run `corepack pnpm types:generate` after changing `wrangler.jsonc`; `corepack pnpm check` verifies that the generated binding file is current.

## Contract and migration locations

- Event schema and examples: `packages/protocol/`
- OpenAPI contract: `packages/protocol/openapi.yaml`
- D1 migrations: `apps/api/migrations/`
- Worker entry point: `apps/api/src/index.ts`

The configured D1 database ID is a local-development placeholder. Replace it with a real database ID only when preparing a separately reviewed Cloudflare deployment. Before exposing the endpoint publicly, configure edge rate limiting and review the account's Workers/D1 quotas. Rate limiting is not yet enforced in the Worker.
