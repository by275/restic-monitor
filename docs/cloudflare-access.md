# Cloudflare Access and hostname setup

## Cloudflare components in this project

| Component | Use here | State |
|---|---|---|
| Workers | Runs the API and request router | Configured in `wrangler.jsonc`; not deployed |
| Workers Static Assets | Serves the dashboard HTML, CSS, and JavaScript from the Worker deployment | Configured in `wrangler.jsonc` |
| D1 | Stores Hosts, Repositories, Jobs, runs, alerts, notification targets, and notification deliveries | Local database is tested; production database is not created |
| Cron Triggers | Every five minutes, evaluates missed schedules and timeouts, then drains the notification outbox | One `*/5 * * * *` trigger is configured; not deployed |
| Worker variables | `ADMIN_HOST` restricts admin/read routes by hostname; `PING_BASE_URL` builds client ping URLs | Local `ADMIN_HOST` configured; production values are operator setup |
| Cloudflare Access | Protects the dashboard and admin/read API hostname | Recommended deployment setup; no Access application is configured here |
| Custom Domains and DNS | Route the dashboard and public ping hostname to this Worker | Required for the documented two-hostname deployment; not configured here |
| Edge rate limiting | Limits public ping traffic before it reaches the Worker | Recommended before exposing the ping hostname; not configured here |

The application does not currently use Queues, KV, R2, Durable Objects, or Workers AI. Wrangler is the local development, D1 schema, and deployment CLI rather than a runtime service. The current plan limits are listed below and should be rechecked before production deployment.

Discord and Telegram are external services. Their connection details are registered as reusable notification targets in the dashboard and stored in D1. Jobs can select zero or more targets. No Worker-wide webhook or bot token is required.

The web UI and admin API are for operators. Protect their hostname with Cloudflare Access. Restic clients cannot complete an Access login, so send pings to a separate public hostname and authenticate them with the per-Job ping URL.

## Hostnames

Use two custom domains on the same Worker:

| Purpose | Example | Access policy |
|---|---|---|
| Dashboard and admin API | `monitor.example.com` | Require an operator identity |
| Client ping API | `ingest.example.com` | Publicly reachable; each Job URL is a secret capability |

Set the Worker variables:

- `ADMIN_HOST=monitor.example.com`
- `PING_BASE_URL=https://ingest.example.com`

`PING_BASE_URL` must be an origin only: no path, credentials, query, or fragment. The Worker refuses to create or rotate a Job ping URL if this value is missing on a non-local hostname or if it points at the Access-protected admin hostname. Local development uses the request origin when `PING_BASE_URL` is not set.

In Cloudflare One, create a Self-hosted Access application for `monitor.example.com` and allow the operator accounts or email addresses that need the dashboard. Protect the whole hostname, including static assets and `/api/v1/admin/*` and `/api/v1/read/*`. Do not add a public Bypass rule to this hostname.

Do not put an Access login gate in front of `ingest.example.com`. The ping token is a high-entropy capability: anyone who obtains a Job URL can report runs for that Job until the token is rotated. Store it in the host's secret configuration, avoid shell history and process listings where possible, and do not print the full URL in routine logs. The Worker stores only the token hash and a short prefix.

The API does not currently enforce request rate limits in the Worker. Before exposing the ping hostname, configure Cloudflare edge rate limiting appropriate to the expected cron frequency and review the account's Workers and D1 quotas. A rate limit must allow normal retries and simultaneous Jobs.

## Free plan fit

This is a low-volume, Free-first design, not a guarantee that every backup fleet fits Free quotas. Current Workers Free limits include 100,000 requests per day, 10 ms CPU per HTTP request and Cron invocation, and five Cron Triggers per account. D1 Free includes five million rows read per day, 100,000 rows written per day, and 5 GB of total storage. The Worker uses one five-minute Cron Trigger for all Jobs, so per-Job schedules do not consume separate Cloudflare triggers. Watch CPU and D1 row metrics after deployment; if they approach limits, reduce catch-up work or move to Workers Paid. See official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Production checklist

Follow the [Workers Builds deployment guide](cloudflare-workers-deploy.md) to create D1, configure `DEPLOY_*` build variables, apply the baseline schema, and deploy the generated Wrangler config. Protect the admin hostname with Access, leave the ping hostname reachable to clients, and configure edge rate limiting for ping traffic. Then create Hosts, Repositories, notification targets, and Jobs in the UI and verify a synthetic start/completion request before adapting a live schedule.

Never run `db:reset:local` for a remote database. That command is deliberately hard-coded to local Wrangler D1.

## Local development

`wrangler dev` uses `ADMIN_HOST=localhost` and does not simulate Cloudflare Access. Its dashboard and admin routes are only a local-development convenience. Local tests use isolated databases. The local reset command acts only on this repository's `.wrangler` D1 state.

Official Cloudflare references: [Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/), [Self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/), [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Workers static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/), and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
