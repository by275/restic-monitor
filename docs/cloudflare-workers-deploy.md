# Deploy with Cloudflare Workers Builds

This project can deploy from a connected GitHub repository with Cloudflare Workers Builds. The build reads a small, allow-listed set of `DEPLOY_*` values, writes an ignored `.wrangler.deploy.jsonc`, and runs Wrangler with that file. The tracked `wrangler.jsonc` remains the local development config.

## 1. Create the production D1 database

Create a D1 database in the Cloudflare account that owns the two hostnames. Copy its database name and UUID. The generated deployment config rejects the all-zero placeholder ID from the tracked local config.

Before the first Worker deployment, apply this project's initial schema to the new remote database:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run deploy:config
corepack pnpm exec wrangler d1 migrations apply "$DEPLOY_D1_DATABASE_NAME" --remote --config .wrangler.deploy.jsonc
```

Run the migration from a trusted local environment with the deployment variables set. It applies the existing migration files to the configured production D1; do not substitute `db:reset:local` or a destructive reset command.

## 2. Configure hostnames and Access

Use two DNS hostnames attached to the same Worker:

| Build variable | Example | Purpose |
|---|---|---|
| `DEPLOY_ADMIN_HOST` | `monitor.example.com` | Dashboard and admin/read API; protect with Cloudflare Access |
| `DEPLOY_PING_HOST` | `ingest.example.com` | Public client ping API; authenticate with each Job's capability URL |

Both hostnames must be DNS names in the account's Cloudflare zone, without a scheme, path, port, or trailing dot. They must be different. The generated Wrangler config attaches both as custom domains and disables the `workers.dev` hostname. Custom-domain DNS and certificates are managed by Cloudflare when Wrangler provisions the routes.

Create an Access Self-hosted application and allow policy for the admin hostname. Keep the ping hostname public so Restic clients can reach it. Configure an appropriate Cloudflare edge rate limit for the ping hostname before production use.

## 3. Set Workers Builds variables

Connect the GitHub repository in **Workers & Pages → Create application → Connect to Git**. Set the repository root directory to the project root and the Cloudflare Worker name to the same value as `DEPLOY_WORKER_NAME`. Cloudflare requires the connected Worker's name to match the Wrangler config's `name`. Pin the Workers Builds package manager to this repository's `packageManager` version (`PNPM_VERSION=12.11.2`), then configure the production commands:

```text
Build command:  corepack pnpm run typecheck && corepack pnpm test
Deploy command: corepack pnpm run deploy
```

Set these variables in the Production build environment for the deploy trigger:

| Variable | Required | Example |
|---|---:|---|
| `DEPLOY_WORKER_NAME` | Yes | `restic-monitor-prod` |
| `DEPLOY_ADMIN_HOST` | Yes | `monitor.example.com` |
| `DEPLOY_PING_HOST` | Yes | `ingest.example.com` |
| `DEPLOY_D1_DATABASE_NAME` | Yes | `restic-monitor-prod` |
| `DEPLOY_D1_DATABASE_ID` | Yes | UUID copied from D1 |
| `DEPLOY_ACCOUNT_ID` | No | 32-character Cloudflare account ID |
| `DEPLOY_COMPATIBILITY_DATE` | No | `2026-10-12` |
| `PNPM_VERSION` | Recommended | `12.11.2` |

`DEPLOY_*` values are build inputs used to generate Wrangler configuration. The generated config places `ADMIN_HOST` and `PING_BASE_URL` into the deployed Worker's runtime `vars`, declares the D1 `DB` binding, and configures the two custom domains. The D1 binding is a Worker resource binding, not a string-valued runtime variable.

Do not put Discord webhooks, Telegram bot tokens, Job ping URLs, or other credentials in build variables. Register notification targets in the dashboard after deployment; their credentials are stored in D1. Cloudflare Build variables are available to the build process, and any value embedded by a build tool can become part of the deployment artifact.

The deploy script rejects missing required settings, malformed values, identical admin and ping hostnames, unknown `DEPLOY_*` names, and the tracked placeholder D1 ID. It does not print configured values. Add a new `DEPLOY_*` build variable only after adding explicit validation and a test for how it maps into Wrangler config.

## 4. Validate and deploy

For a local bundle/config check, use synthetic production-shaped values and run:

```sh
corepack pnpm run deploy:dry-run
```

This runs `wrangler deploy --dry-run` with the generated file. It does not deploy the Worker or apply D1 migrations. To inspect only the generated config:

```sh
corepack pnpm run deploy:config
```

The generated file is ignored by Git and has owner-only permissions on Unix systems. A production deployment is triggered by the Workers Builds deploy command after the required Production build variables are set. Disable preview builds under **Settings → Builds → Branch control** until a separate preview Worker, hostnames, and D1 have been configured. Preview builds use their own command and can otherwise invoke Wrangler with the tracked local config.

After deploying, verify `/healthz` on the ping hostname, open the dashboard through Access on the admin hostname, register a Host and Repository, then create a synthetic Job and ping it. Confirm a start and completion in the dashboard before adapting a real Restic schedule.

## What each Cloudflare feature does here

| Cloudflare feature | Project use |
|---|---|
| Workers | Hosts the API, request routing, and schedule evaluator |
| Static Assets | Serves the dashboard HTML, CSS, and JavaScript from the Worker deployment |
| D1 | Stores configuration, runs, alert history, and notification delivery state |
| Cron Triggers | One `*/5 * * * *` trigger evaluates missed starts/timeouts and sends pending notifications |
| Workers Builds | Builds and deploys from GitHub using the production `DEPLOY_*` values |
| Worker runtime vars | `ADMIN_HOST` and `PING_BASE_URL`, generated from the build inputs |
| Custom Domains and DNS | Route the admin and client ping hostnames to the same Worker |
| Cloudflare Access | Protects the admin hostname for operators |
| Edge rate limiting | Limits public ping traffic before requests reach the Worker |

The application does not currently use Queues, KV, R2, Durable Objects, or Workers AI. Review current [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Workers Builds build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/), [preview build controls](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/), [Wrangler deploy options](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) when changing the deployment setup.
