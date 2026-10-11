# Read API v1

The dashboard uses read-only endpoints under `/api/v1/read/`. They return JSON with `Cache-Control: private, no-store` and never expose API token hashes, repository URLs, raw Restic output, or unmasked credentials. Timestamps are Unix epoch milliseconds, matching the D1 model.

## Overview

`GET /api/v1/read/overview`

Query parameters:

- `window_days`: integer from 1 to 90; defaults to 7.
- `host_id`, `job_key`, `repository_key`, `operation`: optional exact filters for the run counts and recent runs.

Response includes `generated_at`, `window_days`, the applied `filters`, status counts, active host/job/repository counts, and up to eight recent runs.

## Runs

`GET /api/v1/read/runs`

Optional exact filters: `host_id`, `job_key`, `repository_key`, `status`, and `operation`. `repository_key` matches any linked repository role, including copy source and target. `limit` defaults to 25 and is capped at 100. Results sort by `started_at DESC, id DESC`.

The response contains `data` and `pagination` (`limit`, `has_more`, `next_cursor`). Use the returned cursor unchanged with the same filters to fetch the next page. It is an opaque base64url keyset cursor bound to the resource and filter values; it is not an access credential. Run list rows include job/host names, linked repositories, and the compact backup metrics needed by the dashboard.

`GET /api/v1/read/runs/{runId}` returns one run with full metrics, linked repositories and roles, client/Restic version, exit code, timestamps, duration, and sanitized error summary. An unknown run returns 404.

## Hosts

`GET /api/v1/read/hosts`

Optional filters: `enabled=true|false` and `q`, a prefix matched against host name or display name. `limit` defaults to 25 and is capped at 100. Results sort by `created_at ASC, id ASC` and include job count and most recent run status/time.

## Repositories and measurements

`GET /api/v1/read/repositories`

Optional filters: `enabled=true|false`, `backend_type`, and `q`, a prefix matched against repository key or name. Results sort by `repository_key ASC, id ASC` and include linked job count, last run, and last measurement time.

`GET /api/v1/read/repositories/{repositoryKey}/stats`

Optional `measurement_type` filters one of `restic_restore_size`, `restic_raw_data`, `restic_total_size`, or `backend_physical_bytes`. Pagination uses the same `limit` and `cursor` fields, sorted by `measured_at DESC, id DESC`. Each measurement includes `value_bytes`, source run, timestamp, and parsed `details` JSON. The API distinguishes Restic logical measurements from backend physical usage; the UI does not infer one from the other.

## Errors and access boundary

- `400`: invalid filter, page size, or cursor.
- `404`: unknown run/repository or request hostname does not match `ADMIN_HOST`.
- `503`: D1 read failed; retry after the database is available.

Read API hostname matching is a guard against accidentally serving dashboard data through `workers.dev` or a public ingest hostname. It does not authenticate a person. The configured dashboard hostname must be protected by a Cloudflare Access Allow policy; see [Cloudflare Access setup](cloudflare-access.md). The ingest hostname remains separate and uses the Reporter Bearer token.
