# Optional docker-restic integration

This overlay adds an opt-in `restic` command shim to the existing `ghcr.io/by275/restic` image. It leaves the image's backup, prune, and check scripts and their cron commands unchanged. The shim receives the exact argument vector produced by those scripts, then calls `restic-monitor run`; the Reporter invokes a renamed copy of the original Restic executable. Monitoring is disabled unless `RESTIC_MONITOR_ENABLED=1` or `true`.

The Reporter buffers Restic output until the command exits. Restic stdout, stderr, argv, and exit code are preserved, while live progress output is delayed. The shim may add a short monitoring diagnostic to stderr if its configuration is invalid; monitoring errors do not change the Restic exit code. Invalid monitoring configuration falls back to the original Restic executable.

## Build the opt-in image

Pin the base image to the same Restic build used by the Host before a pilot. The default tag is only a convenience for local evaluation.

```sh
docker build \
  --build-arg RESTIC_BASE_IMAGE=ghcr.io/by275/restic:<pinned-tag-or-digest> \
  -f integrations/docker-restic/Dockerfile \
  -t restic-monitor-docker:pilot .
```

The base image is Alpine-based and must provide `/usr/local/bin/restic`. The overlay adds `bash`, `coreutils`, `curl`, and `jq`, preserves the original binary at `/usr/local/libexec/restic.real`, and installs the Reporter shim at the original command path. It builds as root and defaults to running as UID 0, matching Alpine's usual default. If the original image declares another runtime `USER`, pass that exact UID or `UID:GID` with `--build-arg RESTIC_RUNTIME_USER=...` so the pilot preserves it.

The shim maps `restic forget --prune` to the protocol operation `forget_prune`; an optional `RESTIC_MONITOR_JOB_KEY_FORGET_PRUNE` can override that operation's Job key. Other commands and arguments are passed unchanged.

## Compose opt-in

The example override is intended to merge with the existing docker-restic Compose file, whose services are named `backup`, `prune`, and `check`:

```sh
docker compose \
  -f /path/to/docker-compose.yml \
  -f integrations/docker-restic/compose.monitor.override.example.yml \
  config
```

Set the following values in the invoking environment or an untracked Compose env file:

- `RESTIC_MONITOR_REPOSITORY_KEY`: registered logical Repository key.
- `RESTIC_MONITOR_BACKUP_JOB_KEY`, `RESTIC_MONITOR_PRUNE_JOB_KEY`, and `RESTIC_MONITOR_CHECK_JOB_KEY`: registered Job keys matching each service schedule and timezone.
- `RESTIC_MONITOR_API_URL`: Worker base URL; the Reporter appends `/api/v1/ingest/events`.
- `RESTIC_MONITOR_SECRET_FILE`: path to a protected file containing the Host-scoped Reporter token.

The override uses Docker Compose Secrets for the token and separate named spool volumes for each service. It does not add or change any Restic cron expression. Register each Job in D1 using the same cadence and IANA timezone as its existing container. If a six-field cron's first (seconds) field is `0`, remove that field to get the corresponding five-field Worker Job schedule. A nonzero seconds field has no equivalent in the Worker's minute-granularity schedule and needs a deliberate monitoring schedule. Check the actual Host configuration before setting these values.

The shim also recognizes `stats`, including explicit `stats --mode restore-size --json` and `stats --mode raw-data --json` calls. This override does not schedule a new stats command. Add one only after choosing a dedicated Job schedule that matches the Worker configuration.

## Safe local check

Run `bash tests/docker-restic-shim.sh` to test the shim with a fake Restic executable. It checks opt-in/off behavior, success/partial/failure exit codes, exact output replay, event creation, `forget --prune` mapping, per-operation Job keys, and reading the Reporter token from a secret file. It does not access a live Repository or send requests. The full project check runs this test automatically.

For a live pilot, keep the original Compose file and image tag available for rollback. Start with one service and a separately authorized test Repository or other safe target. Verify backup output and exit code against the original image before enabling the remaining services.

## Local real-Restic end-to-end check

After building the image, run `corepack pnpm test:local-restic-e2e`. This creates a temporary encrypted filesystem Repository under the project root, backs up two fixture files, runs `restic check`, and verifies the snapshot plus the Reporter start/completion events. Docker runs with `--network none`; no Cloudflare endpoint, external backend, or existing backup source is used. The temporary Repository, password file, and spool are removed on exit. The test requires Docker and the locally built `restic-monitor-docker:pilot` image; `RESTIC_MONITOR_TEST_IMAGE` can select another locally built image.
