# Cloudflare Access and hostname setup

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

1. Create a new Cloudflare D1 database and replace the placeholder `database_id` in `wrangler.jsonc` for the production configuration.
2. Apply the clean baseline schema to the remote database with `wrangler d1 migrations apply restic-monitor --remote` after checking the configured database name and ID.
3. Set `ADMIN_HOST` and `PING_BASE_URL` as Worker variables. Attach both custom domains to the Worker.
4. Protect `monitor.example.com` with Access; leave `ingest.example.com` reachable to clients and configure edge rate limiting there.
5. Add `DISCORD_WEBHOOK_URL` with `wrangler secret put DISCORD_WEBHOOK_URL` if Discord delivery is wanted.
6. Create one Host, Repository, and Job per independently scheduled Restic command in the UI. Save each one-time ping URL securely on its client.
7. Verify a synthetic start/completion request against the deployed Worker, then confirm the run and alert in the dashboard. Do not test against a production Restic repository during initial setup.

Never run `db:reset:local` for a remote database. That command is deliberately hard-coded to local Wrangler D1.

## Local development

`wrangler dev` uses `ADMIN_HOST=localhost` and does not simulate Cloudflare Access. Its dashboard and admin routes are only a local-development convenience. Local tests use isolated databases. The local reset command acts only on this repository's `.wrangler` D1 state.

Official Cloudflare references: [Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/), [Self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/), [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Workers static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/), and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
