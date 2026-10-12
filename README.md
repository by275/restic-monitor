# Restic Monitor

Restic Monitor is a Cloudflare Worker, D1 database, and web UI for registering backup Jobs, receiving start/completion pings, detecting missed schedules and timeouts, and sending selected alerts to Discord.

The client side is intentionally small. A Job gets a private ping URL in the UI. The machine that already runs Restic generates one UUID for each command, POSTs a start ping, runs Restic, then POSTs the exit code and optional parsed summary using the same UUID. Linux Bash and Windows PowerShell examples are in [`examples/`](examples/). Your existing scheduler remains responsible for running Restic; add the example calls to the command or script that already runs it.

## Local development

Requirements: Node.js 22.12+, Corepack, and pnpm 12.11.2.

```sh
corepack pnpm install
corepack pnpm db:reset:local
corepack pnpm dev
```

`db:reset:local` deletes and recreates only this project's local Wrangler D1 tables from the single baseline schema. It always passes `--local`; it does not contact a Cloudflare remote database. Use it only when local Restic Monitor data can be discarded.

Open `http://localhost:8787/healthz`. The local dashboard and admin API share `ADMIN_HOST=localhost`. Create a Host and Repository, then register Jobs from the dashboard's **설정** section. A Job's ping URL is shown only after creation or token rotation. Store it as a secret on the machine that runs Restic.

## Job and client model

- A Job represents one independently scheduled command with one operation, repository association, schedule policy, timeout, tags, and Discord preference.
- Register backup and prune as separate Jobs when their schedules or results are independent. Add multiple cron rules to one Job only when all invocations have the same reporting meaning.
- The UI generates a random per-Job capability token. D1 stores its SHA-256 hash. Rotating it immediately revokes the previous URL.
- The client creates a `run_id` UUID for each invocation and reuses it on both pings and retries. It does not send Job name, slug, operation, repository, client timestamp, or duration.

Read the [client protocol v1](docs/client-protocol.md), [dashboard read API](docs/read-api.md), and [implementation plan](docs/implementation-plan.md) before adapting a client.

## Alerts and deployment

Each Job has its own optional Discord webhook URL. Enter it in the Job form; on edit, leave the field blank to keep the current URL, enter a new URL to replace it, or select the removal checkbox. The dashboard shows whether a URL is configured but does not return its current value in the Job list API. Alerts remain pending until that Job has a webhook and Discord notifications are enabled.

For deployment, protect the dashboard hostname with Cloudflare Access and set `ADMIN_HOST` to that hostname. Set `PING_BASE_URL` to a separate public hostname such as `https://ingest.example.com`; the generated URL must not point at the Access-protected dashboard host. The public ping routes authenticate with each Job's capability URL. See [Cloudflare Access and hostname setup](docs/cloudflare-access.md).

The design uses one five-minute Worker Cron Trigger for all Jobs and starts with Workers Free + D1. Review the current [Workers and D1 Free quotas](docs/cloudflare-access.md#free-plan-fit) against your expected run volume before deployment.

Do not deploy the placeholder D1 database ID from `wrangler.jsonc`. Create a new Cloudflare D1 database for production, set its ID, apply the baseline schema to that remote database, and review the [Cloudflare deployment checklist](docs/cloudflare-access.md#production-checklist). No production Worker or database is deployed by the local tests.

## Checks

```sh
corepack pnpm test
corepack pnpm typecheck
```

Tests use isolated D1 databases and synthetic Restic output. The Bash example test replaces both `restic` and `curl` with fake executables; it does not access a repository or network. The PowerShell example is provided for Windows hosts; PowerShell is not installed in the Linux development environment, so run it with synthetic output in a Windows test environment before adapting it to a live backup task.

## Project boundaries

- Server configuration, ping API v1, schedules, D1, status UI, and Discord alert delivery belong here.
- Reporter implementations, host-specific service installation, Docker composition, and real repository testing belong to the client/operator environment.
- Do not modify the sibling `docker-restic` repository as part of this project.

## Main files

- Protocol: [`packages/protocol/`](packages/protocol/)
- Worker and API: [`apps/api/src/`](apps/api/src/)
- Clean D1 baseline: [`apps/api/migrations/0001_initial_schema.sql`](apps/api/migrations/0001_initial_schema.sql)
- Local D1 reset script: [`scripts/reset-local-d1.sql`](scripts/reset-local-d1.sql)
- Client examples: [`examples/`](examples/)
- Synthetic Restic fixtures: [`tests/fixtures/restic/0.19.1/`](tests/fixtures/restic/0.19.1/)
