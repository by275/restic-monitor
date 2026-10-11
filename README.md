# Restic Monitor

Restic Monitor records backup job events while leaving the existing Docker, cron, and Restic execution model in place. The first implementation step establishes the API runtime, event contract, and D1 schema. It does not change a backup host or collect events yet.

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

The configured D1 database ID is a local-development placeholder. Replace it with a real database ID only when preparing a separately reviewed Cloudflare deployment. The event endpoint is specified by the contract and will be implemented in phase 2.
