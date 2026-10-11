# Restic Monitor

Restic Monitor records backup job events while leaving the existing Docker, cron, and Restic execution model in place. The current implementation accepts authenticated run events, projects them into D1, detects missed schedules and timed out runs, and sends alerts through a persistent Discord outbox. It also provides an opt-in Bash Reporter with a persistent retry spool. It does not modify an existing backup host or cron entry.

## Requirements

- Node.js 22.12 or newer
- Corepack-enabled pnpm (the repository pins pnpm 12.11.2)
- Bash 4+, `jq`, and `curl` on backup hosts that use the Reporter

## Local setup

```sh
corepack pnpm install
corepack pnpm db:migrate:local
corepack pnpm dev
```

Open `http://localhost:8787/healthz`; the expected response is `{"ok":true,"service":"restic-monitor"}`. Wrangler uses its local D1 database for these commands. No Cloudflare account or production binding is needed for local development.

The event endpoint is `POST /api/v1/ingest/events`; it requires an `application/json` event v1 body and a Host-scoped Bearer token. It accepts at most 65,536 body bytes and stores only the payload hash in the idempotency ledger.

Read-only dashboard APIs are under `/api/v1/read/` and only answer on the hostname configured in `ADMIN_HOST`. Protect that dashboard hostname with Cloudflare Access and use a separate public ingest hostname for Reporter traffic. See the [read API contract](docs/read-api.md) and [Cloudflare Access setup](docs/cloudflare-access.md) before deployment; host matching is a routing guard and does not replace Access login.

Discord delivery is optional until configured. For a deployed Worker, add `DISCORD_WEBHOOK_URL` as a Cloudflare Secret with `corepack pnpm exec wrangler secret put DISCORD_WEBHOOK_URL`. For local development, put the same key in the gitignored `.dev.vars` file next to `wrangler.jsonc`. If the secret is absent, notifications stay pending in D1 and resume when it is configured. Never put the webhook URL in `wrangler.jsonc`, source files, or logs.

To provision a local reporter token, first create its Host, Job, Repository, and Job/Repository associations in D1. Run `corepack pnpm token:mint <host-id>` and keep the printed token securely; insert the generated SQL row, which contains only the token hash. The token itself is shown once and cannot be recovered from D1.

## Bash Reporter

`bin/restic-monitor run` wraps a Restic command without changing its arguments. It records start/completion events, preserves Restic stdout, stderr, and exit status, and keeps events in a private local spool until the API accepts them. Output is captured in a private temporary directory and replayed when Restic exits, so progress is not displayed live. Set `RESTIC_MONITOR_JOB_KEY`, `RESTIC_MONITOR_REPOSITORY_KEY`, `RESTIC_MONITOR_OPERATION`, `RESTIC_MONITOR_API_URL`, `RESTIC_MONITOR_TOKEN`, and `RESTIC_MONITOR_SPOOL_DIR`, then invoke it like:

```sh
bin/restic-monitor run -- --json backup /data
bin/restic-monitor flush
```

`RESTIC_MONITOR_API_URL` is the Worker base URL; the reporter appends `/api/v1/ingest/events`. It queues the start event, begins a bounded delivery attempt in the background, and runs Restic. After Restic exits, it queues the completion event and attempts delivery again. Failed requests remain queued; `flush` retries transport errors, 408, 429, 401/403, and 5xx with persisted backoff. Other permanent 4xx responses, corrupt or expired queue entries, and events rejected after the spool reaches its configured capacity move to `quarantine/`; review and requeue those files manually after fixing the cause. Keep the spool on persistent storage and call `flush` from an existing cron or a separate cron entry.

For an existing wrapper that already creates protocol events, `bin/restic-monitor report event.json` queues one event, and `bin/restic-monitor flush` sends queued events. Do not pass the API token as a command-line argument; provide it through the environment or the existing secret mechanism used by the container.

## Checks

```sh
corepack pnpm test
corepack pnpm typecheck
```

`test:protocol` validates the versioned event examples and rejection cases with JSON Schema. `test:worker` runs the Worker in the Cloudflare Workers Vitest runtime and applies the D1 migrations to an isolated local database. `test:reporter` uses fake Restic and HTTP executables, so tests do not require a live repository or network. The dashboard is a dependency-free static app served by Workers Static Assets.

Wrangler binding types are generated in `worker-configuration.d.ts`, with runtime API types supplied by the pinned official `@cloudflare/workers-types` package. Run `corepack pnpm types:generate` after changing `wrangler.jsonc`; `corepack pnpm check` verifies that the generated binding file is current.

## Contract and migration locations

- Event schema and examples: `packages/protocol/`
- OpenAPI contract: `packages/protocol/openapi.yaml`
- D1 migrations: `apps/api/migrations/`
- Worker entry point: `apps/api/src/index.ts`

The configured D1 database ID is a local-development placeholder. Replace it with a real database ID only when preparing a separately reviewed Cloudflare deployment. Before exposing the endpoint publicly, configure edge rate limiting and review the account's Workers/D1 quotas. Rate limiting is not yet enforced in the Worker.
