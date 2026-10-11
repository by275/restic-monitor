#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SHIM="$ROOT/integrations/docker-restic/restic-shim"
REPORTER="$ROOT/bin/restic-monitor"
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/restic-monitor-shim-tests.XXXXXX")
trap 'rm -rf -- "$TEST_DIR"' EXIT

cat > "$TEST_DIR/fake-restic" <<'FAKE_RESTIC'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FAKE_RESTIC_ARGS_LOG"
if [[ ${1:-} == version ]]; then
  printf 'restic 0.19.1\n'
else
  printf 'fake restic stdout\n'
  printf 'fake restic stderr\n' >&2
fi
exit "${FAKE_RESTIC_EXIT_CODE:-0}"
FAKE_RESTIC
chmod 0755 "$TEST_DIR/fake-restic"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local expected=$1 actual=$2 label=$3
  [[ $actual == "$expected" ]] || fail "$label: expected <$expected>, got <$actual>"
}

run_and_check() {
  local exit_code=$1
  local spool="$TEST_DIR/spool-$exit_code" stdout="$TEST_DIR/stdout-$exit_code"
  local stderr="$TEST_DIR/stderr-$exit_code" status=0 completion
  mkdir -p "$spool"
  RESTIC_MONITOR_ENABLED=1 \
    RESTIC_MONITOR_BIN="$REPORTER" \
    RESTIC_MONITOR_RESTIC_BIN="$TEST_DIR/fake-restic" \
    RESTIC_MONITOR_SPOOL_DIR="$spool" \
    RESTIC_MONITOR_JOB_KEY=default-job \
    RESTIC_MONITOR_JOB_KEY_BACKUP=backup-job \
    RESTIC_MONITOR_REPOSITORY_KEY=repo-a \
    FAKE_RESTIC_EXIT_CODE="$exit_code" \
    FAKE_RESTIC_ARGS_LOG="$TEST_DIR/args-$exit_code" \
    "$SHIM" backup --json /source > "$stdout" 2> "$stderr" || status=$?

  assert_eq "$exit_code" "$status" "Restic exit $exit_code must pass through"
  assert_eq "fake restic stdout" "$(cat "$stdout")" 'stdout must be preserved'
  assert_eq "fake restic stderr" "$(cat "$stderr")" 'stderr must be preserved'
  assert_eq 'backup --json /source' "$(cat "$TEST_DIR/args-$exit_code")" 'Restic argv must be unchanged'
  assert_eq 2 "$(find "$spool/pending" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d '[:space:]')" 'start and completion events must be queued'

  completion=$(find "$spool/pending" -maxdepth 1 -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
  [[ -n $completion ]] || fail 'completed event was not queued'
  jq -e --argjson code "$exit_code" '.operation == "backup" and .job_key == "backup-job" and .result.exit_code == $code' "$completion" >/dev/null || fail 'completed event must preserve operation, Job key, and exit code'
}

printf 'Testing docker-restic command shim...\n'

disabled_status=0
RESTIC_MONITOR_ENABLED=0 \
  RESTIC_MONITOR_RESTIC_BIN="$TEST_DIR/fake-restic" \
  FAKE_RESTIC_EXIT_CODE=0 \
  FAKE_RESTIC_ARGS_LOG="$TEST_DIR/disabled-args" \
  "$SHIM" backup --json /source > "$TEST_DIR/disabled-out" 2> "$TEST_DIR/disabled-err" || disabled_status=$?
assert_eq 0 "$disabled_status" 'monitoring-off must preserve the Restic exit code'
assert_eq 'fake restic stdout' "$(cat "$TEST_DIR/disabled-out")" 'monitoring-off stdout must be preserved'
assert_eq 'fake restic stderr' "$(cat "$TEST_DIR/disabled-err")" 'monitoring-off stderr must be preserved'
assert_eq 'backup --json /source' "$(cat "$TEST_DIR/disabled-args")" 'monitoring-off argv must be unchanged'

for exit_code in 0 3 1; do
  run_and_check "$exit_code"
done

forget_prune_status=0
RESTIC_MONITOR_ENABLED=1 \
  RESTIC_MONITOR_BIN="$REPORTER" \
  RESTIC_MONITOR_RESTIC_BIN="$TEST_DIR/fake-restic" \
  RESTIC_MONITOR_SPOOL_DIR="$TEST_DIR/spool-forget-prune" \
  RESTIC_MONITOR_JOB_KEY=default-job \
  RESTIC_MONITOR_JOB_KEY_FORGET=forget-job \
  RESTIC_MONITOR_JOB_KEY_FORGET_PRUNE=forget-prune-job \
  RESTIC_MONITOR_REPOSITORY_KEY=repo-a \
  FAKE_RESTIC_EXIT_CODE=0 \
  FAKE_RESTIC_ARGS_LOG="$TEST_DIR/forget-prune-args" \
  "$SHIM" forget --json --prune > "$TEST_DIR/forget-prune-out" 2> "$TEST_DIR/forget-prune-err" || forget_prune_status=$?
assert_eq 0 "$forget_prune_status" 'forget --prune must preserve the Restic exit code'
assert_eq 'forget --json --prune' "$(cat "$TEST_DIR/forget-prune-args")" 'forget --prune argv must be unchanged'
forget_prune_completion=$(find "$TEST_DIR/spool-forget-prune/pending" -maxdepth 1 -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
[[ -n $forget_prune_completion ]] || fail 'forget --prune completion event was not queued'
jq -e '.operation == "forget_prune" and .job_key == "forget-prune-job"' "$forget_prune_completion" >/dev/null || fail 'forget --prune must use the dedicated operation and Job key'

cat > "$TEST_DIR/capture-token-monitor" <<'CAPTURE_TOKEN'
#!/usr/bin/env bash
printf '%s' "${RESTIC_MONITOR_TOKEN:-}" > "${RESTIC_MONITOR_TOKEN_CAPTURE:?}"
exec "${RESTIC_MONITOR_REAL_BIN:?}" "$@"
CAPTURE_TOKEN
chmod 0755 "$TEST_DIR/capture-token-monitor"
secret_token="rm1_$(printf 'T%.0s' {1..43})"
printf '%s\n' "$secret_token" > "$TEST_DIR/reporter-token"
token_status=0
env -u RESTIC_MONITOR_TOKEN \
  RESTIC_MONITOR_ENABLED=1 \
  RESTIC_MONITOR_BIN="$TEST_DIR/capture-token-monitor" \
  RESTIC_MONITOR_REAL_BIN="$REPORTER" \
  RESTIC_MONITOR_TOKEN_CAPTURE="$TEST_DIR/captured-token" \
  RESTIC_MONITOR_TOKEN_FILE="$TEST_DIR/reporter-token" \
  RESTIC_MONITOR_RESTIC_BIN="$TEST_DIR/fake-restic" \
  RESTIC_MONITOR_SPOOL_DIR="$TEST_DIR/spool-token" \
  RESTIC_MONITOR_JOB_KEY=token-test-job \
  RESTIC_MONITOR_REPOSITORY_KEY=repo-a \
  FAKE_RESTIC_EXIT_CODE=0 \
  FAKE_RESTIC_ARGS_LOG="$TEST_DIR/token-args" \
  "$SHIM" backup --json /source > "$TEST_DIR/token-out" 2> "$TEST_DIR/token-err" || token_status=$?
assert_eq 0 "$token_status" 'secret-file token injection must preserve the Restic exit code'
assert_eq "$secret_token" "$(cat "$TEST_DIR/captured-token")" 'the mounted secret file must provide the Reporter token'

version_status=0
RESTIC_MONITOR_ENABLED=1 \
  RESTIC_MONITOR_RESTIC_BIN="$TEST_DIR/fake-restic" \
  FAKE_RESTIC_ARGS_LOG="$TEST_DIR/version-args" \
  "$SHIM" version > "$TEST_DIR/version-out" 2> "$TEST_DIR/version-err" || version_status=$?
assert_eq 0 "$version_status" 'version command must bypass event reporting'
assert_eq 'restic 0.19.1' "$(cat "$TEST_DIR/version-out")" 'version command must call the real Restic executable'
assert_eq version "$(cat "$TEST_DIR/version-args")" 'version command argv must be unchanged'

printf 'docker-restic command shim tests passed.\n'
