#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${RESTIC_MONITOR_TEST_IMAGE:-restic-monitor-docker:pilot}
TEST_UID=$(id -u)
TEST_GID=$(id -g)

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker is required for the local Restic end-to-end test.' >&2
  exit 2
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf 'Docker image %s is missing. Build it with the instructions in integrations/docker-restic/README.md.\n' "$IMAGE" >&2
  exit 2
fi

TEST_ROOT=$(mktemp -d "$ROOT/.restic-monitor-e2e.XXXXXX")
cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_ROOT/source/nested" "$TEST_ROOT/repository" "$TEST_ROOT/cache"
mkdir -p "$TEST_ROOT/home"
printf 'Restic Monitor local integration fixture\n' > "$TEST_ROOT/source/readme.txt"
printf 'A second small file verifies that the snapshot contains more than one item.\n' \
  > "$TEST_ROOT/source/nested/payload.txt"
printf 'temporary-local-password-%s-%s\n' "$RANDOM" "$RANDOM" > "$TEST_ROOT/password"
chmod 0600 "$TEST_ROOT/password"

run_restic() {
  local monitor_enabled=$1
  shift
  docker run --rm --network none --user "$TEST_UID:$TEST_GID" \
    --volume "$TEST_ROOT:/test" \
    --env HOME=/test/home \
    --env RESTIC_REPOSITORY=/test/repository \
    --env RESTIC_PASSWORD_FILE=/test/password \
    --env RESTIC_CACHE_DIR=/test/cache \
    --env RESTIC_MONITOR_ENABLED="$monitor_enabled" \
    --env RESTIC_MONITOR_JOB_KEY=local-restic-e2e \
    --env RESTIC_MONITOR_REPOSITORY_KEY=local-restic-repository \
    --env RESTIC_MONITOR_SPOOL_DIR=/test/spool \
    --entrypoint /usr/local/bin/restic \
    "$IMAGE" "$@"
}

printf 'Creating an encrypted local-only Restic repository...\n'
run_restic 0 init > "$TEST_ROOT/init.out"

printf 'Running a real Restic backup through the Reporter shim...\n'
run_restic 1 backup --json /test/source > "$TEST_ROOT/backup.jsonl"
jq -s -e 'any(.[]; .message_type == "summary")' "$TEST_ROOT/backup.jsonl" >/dev/null || {
  printf '%s\n' 'Restic backup JSON did not contain a summary event.' >&2
  exit 1
}

printf 'Running a repository check through the Reporter shim...\n'
run_restic 1 check > "$TEST_ROOT/check.out"

printf 'Verifying the snapshot and queued protocol events...\n'
run_restic 0 snapshots --json > "$TEST_ROOT/snapshots.json"
jq -e 'type == "array" and length == 1' "$TEST_ROOT/snapshots.json" >/dev/null || {
  printf '%s\n' 'The local repository should contain exactly one snapshot.' >&2
  exit 1
}

pending_events=("$TEST_ROOT"/spool/pending/*.json)
if ((${#pending_events[@]} != 4)); then
  printf 'Expected 4 queued start/completion events, found %s.\n' "${#pending_events[@]}" >&2
  exit 1
fi
jq -s -e '
  length == 4 and
  all(.[]; .job_key == "local-restic-e2e" and .repository_key == "local-restic-repository") and
  ([.[] | select(.event_type == "run.started")] | length) == 2 and
  ([.[] | select(.event_type == "run.completed" and .result.exit_code == 0) |
    "\(.operation):\(.result.exit_code)"] | sort) == ["backup:0", "check:0"] and
  ([.[] | select(.event_type == "run.completed" and .operation == "backup") |
    (.result.metrics.snapshot_id | type == "string")] | all)
' "${pending_events[@]}" >/dev/null || {
  printf '%s\n' 'Queued events did not match the real Restic backup and check results.' >&2
  exit 1
}

printf '%s\n' 'Local Restic end-to-end test passed; the temporary repository and spool were removed.'
