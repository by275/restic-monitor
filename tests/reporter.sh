#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPORTER="$ROOT_DIR/bin/restic-monitor"
FIXTURES="$ROOT_DIR/tests/fixtures/restic/0.19.1"
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/restic-monitor-tests.XXXXXX")
FAKE_RESTIC="$TEST_DIR/fake-restic"
FAKE_CURL="$TEST_DIR/fake-curl"
TEST_TOKEN="rm1_$(printf 'A%.0s' {1..43})"
export RESTIC_MONITOR_TOKEN="$TEST_TOKEN"
trap 'rm -rf -- "$TEST_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  local expected=$1 actual=$2 message=$3
  [[ $expected == "$actual" ]] || fail "$message (expected '$expected', got '$actual')"
}

assert_file_eq() {
  cmp -s -- "$1" "$2" || fail "$3"
}

assert_contains() {
  local needle=$1 file=$2
  grep -Fq -- "$needle" "$file" || fail "expected '$needle' in $file"
}

setup_spool() {
  local name=$1
  export RESTIC_MONITOR_SPOOL_DIR="$TEST_DIR/spool-$name"
  rm -rf -- "$RESTIC_MONITOR_SPOOL_DIR"
  mkdir -p -- "$RESTIC_MONITOR_SPOOL_DIR"
  export RESTIC_MONITOR_SPOOL_MAX_EVENTS=4096
  export RESTIC_MONITOR_SPOOL_MAX_BYTES=268435456
  export RESTIC_MONITOR_SPOOL_MAX_AGE_SECONDS=2592000
  export RESTIC_MONITOR_RETRY_BASE_SECONDS=0
  export RESTIC_MONITOR_RETRY_MAX_SECONDS=0
  export RESTIC_MONITOR_MAX_ATTEMPTS_PER_FLUSH=2
  export RESTIC_MONITOR_HTTP_TIMEOUT_SECONDS=2
  export RESTIC_MONITOR_CONNECT_TIMEOUT_SECONDS=1
  export RESTIC_MONITOR_API_URL=http://monitor.test
  export RESTIC_MONITOR_TOKEN="$TEST_TOKEN"
  export RESTIC_MONITOR_CURL_BIN="$FAKE_CURL"
  export FAKE_CURL_MODE=success
  export FAKE_CURL_STATE="$TEST_DIR/curl-count-$name"
  export FAKE_REQUEST_DIR="$TEST_DIR/requests-$name"
  mkdir -p -- "$FAKE_REQUEST_DIR"
  printf '0\n' > "$FAKE_CURL_STATE"
}

pending_count() {
  local pending="$RESTIC_MONITOR_SPOOL_DIR/pending" files=()
  shopt -s nullglob
  files=("$pending"/*.json)
  shopt -u nullglob
  printf '%s' "${#files[@]}"
}

quarantine_count() {
  local quarantine="$RESTIC_MONITOR_SPOOL_DIR/quarantine" files=()
  shopt -s nullglob
  files=("$quarantine"/*.bad)
  shopt -u nullglob
  printf '%s' "${#files[@]}"
}

make_event() {
  local output=$1 event_id=$2
  jq -c -n --arg event_id "$event_id" '{
    schema_version:1,event_id:$event_id,run_id:"run-test",event_type:"run.completed",
    occurred_at:"2026-10-11T05:00:03Z",job_key:"daily",repository_key:"repo-a",
    operation:"backup",client:{name:"restic-monitor-bash",version:"0.1.0"},
    result:{exit_code:0,started_at:"2026-10-11T05:00:00Z",finished_at:"2026-10-11T05:00:03Z",duration_ms:3000}
  }' > "$output"
}

cat > "$FAKE_RESTIC" <<'FAKE_RESTIC_EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$@" > "${FAKE_RESTIC_ARGS_CAPTURE:?}"
if [[ ${FAKE_RESTIC_MODE:-normal} == signal ]]; then
  : > "${FAKE_RESTIC_READY_FILE:?}"
  trap 'exit 130' INT TERM
  while :; do read -r -t 1 ignored || true; done
fi
if [[ -n ${FAKE_RESTIC_STDOUT:-} ]]; then cat -- "$FAKE_RESTIC_STDOUT"; fi
if [[ -n ${FAKE_RESTIC_STDERR:-} ]]; then cat -- "$FAKE_RESTIC_STDERR" >&2; fi
exit "${FAKE_RESTIC_EXIT_CODE:-0}"
FAKE_RESTIC_EOF
chmod 700 -- "$FAKE_RESTIC"

cat > "$FAKE_CURL" <<'FAKE_CURL_EOF'
#!/usr/bin/env bash
set -u
response_file=''
headers_file=''
data_arg=''
config_file=''
while (($#)); do
  case $1 in
    --config|--connect-timeout|--max-time|--proto|--request|--header|--data-binary|--dump-header|--output|--write-out)
      (($# >= 2)) || exit 90
      option=$1
      value=$2
      case $option in
        --config) config_file=$value ;;
        --output) response_file=$value ;;
        --dump-header) headers_file=$value ;;
        --data-binary) data_arg=$value ;;
      esac
      shift 2
      ;;
    --silent|--show-error) shift ;;
    *) shift ;;
  esac
done
[[ -n $config_file && $(stat -c %a "$config_file") == 600 ]] || exit 92
grep -Fqx -- "header = \"Authorization: Bearer ${RESTIC_MONITOR_TOKEN:?}\"" "$config_file" || exit 93

count=$(cat -- "${FAKE_CURL_STATE:?}")
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_CURL_STATE"
event_file=${data_arg#@}
event_id=$(jq -r '.event_id' "$event_file")
cp -- "$event_file" "$FAKE_REQUEST_DIR/$(printf '%04d' "$count").json"

mode=${FAKE_CURL_MODE:-success}
case $mode in
  success) code=200; duplicate=false ;;
  duplicate) code=200; duplicate=true ;;
  sequence-429)
    if (( count == 1 )); then code=429; duplicate=false; else code=200; duplicate=false; fi
    ;;
  unauthorized) code=401; duplicate=false ;;
  unavailable) code=503; duplicate=false ;;
  bad-request) code=422; duplicate=false ;;
  network) exit 7 ;;
  wrong-event-id) code=200; duplicate=false; event_id=other-event ;;
  *) exit 91 ;;
esac

printf 'HTTP/1.1 %s test\r\nRetry-After: 0\r\n\r\n' "$code" > "$headers_file"
if (( code == 200 )); then
  jq -c -n --arg event_id "$event_id" --argjson duplicate "$duplicate" \
    '{event_id:$event_id,accepted:true,duplicate:$duplicate,received_at:"2026-10-11T05:00:04Z"}' > "$response_file"
else
  printf '{"error":"test"}\n' > "$response_file"
fi
printf '%s' "$code"
FAKE_CURL_EOF
chmod 700 -- "$FAKE_CURL"

export FAKE_RESTIC_ARGS_CAPTURE="$TEST_DIR/restic-args"
export FAKE_RESTIC_STDOUT="$FIXTURES/backup.success.jsonl"
export FAKE_RESTIC_STDERR="$TEST_DIR/restic-stderr"
printf 'restic diagnostic\n' > "$FAKE_RESTIC_STDERR"

printf 'Testing Bash Reporter...\n'

setup_spool restic-exit-codes
expected_args="$TEST_DIR/expected-args"
printf '%s\n' '--json' 'backup' '--tag' 'daily backup' > "$expected_args"
for code in 0 3 1 10 11 12 130; do
  export FAKE_RESTIC_EXIT_CODE=$code
  export FAKE_RESTIC_MODE=normal
  export FAKE_CURL_MODE=success
  export FAKE_CURL_STATE="$TEST_DIR/curl-count-code-$code"
  export FAKE_REQUEST_DIR="$TEST_DIR/requests-code-$code"
  mkdir -p -- "$FAKE_REQUEST_DIR"
  printf '0\n' > "$FAKE_CURL_STATE"
  set +e
  "$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup --tag 'daily backup' > "$TEST_DIR/out-$code" 2> "$TEST_DIR/err-$code"
  status=$?
  set -e
  assert_eq "$code" "$status" "Restic exit code $code must be preserved"
  assert_file_eq "$FIXTURES/backup.success.jsonl" "$TEST_DIR/out-$code" "Restic stdout must be preserved"
  assert_file_eq "$FAKE_RESTIC_STDERR" "$TEST_DIR/err-$code" "Restic stderr must be preserved"
  assert_file_eq "$expected_args" "$FAKE_RESTIC_ARGS_CAPTURE" "Restic arguments must be unchanged"
  completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
  [[ -n $completed_file ]] || fail "completed event was not sent for exit code $code"
  assert_eq "$code" "$(jq -r '.result.exit_code' "$completed_file")" "completed event must preserve exit code"
  assert_eq 2 "$(cat "$FAKE_CURL_STATE")" "started and completed events should each be sent"
done

setup_spool backup-metrics
export FAKE_RESTIC_EXIT_CODE=0
export FAKE_RESTIC_STDOUT="$FIXTURES/backup.success.jsonl"
export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
: > "$FAKE_RESTIC_STDERR"
export FAKE_CURL_STATE="$TEST_DIR/curl-count-metrics"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-metrics"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
"$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup >/dev/null 2> "$TEST_DIR/metrics-log"
completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
assert_eq 16384 "$(jq -r '.result.metrics.bytes_processed' "$completed_file")" 'total_bytes_processed must map to bytes_processed'
assert_eq 8192 "$(jq -r '.result.metrics.bytes_added' "$completed_file")" 'data_added must map to bytes_added'
assert_eq 4096 "$(jq -r '.result.metrics.bytes_added_packed' "$completed_file")" 'data_added_packed must map to bytes_added_packed'
assert_eq 64 "$(jq -r '.result.metrics.snapshot_id | length' "$completed_file")" 'snapshot ID should be retained'

setup_spool invalid-metadata
export FAKE_RESTIC_EXIT_CODE=0
export FAKE_RESTIC_STDOUT="$FIXTURES/backup.success.jsonl"
export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
export FAKE_CURL_STATE="$TEST_DIR/curl-count-invalid-metadata"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-invalid-metadata"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
RESTIC_MONITOR_WORKFLOW_ID='invalid id' RESTIC_MONITOR_CLIENT_NAME='this client name is intentionally longer than the protocol limit because tests should prove fallback' \
  "$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup >/dev/null 2> "$TEST_DIR/invalid-metadata-log"
completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
assert_eq "$(jq -r '.run_id' "$completed_file")" "$(jq -r '.workflow_id' "$completed_file")" 'invalid workflow id should fall back to the generated run id'
assert_eq 'restic-monitor-bash' "$(jq -r '.client.name' "$completed_file")" 'invalid client metadata should use protocol-safe defaults'

setup_spool error-sanitizing
export FAKE_RESTIC_EXIT_CODE=1
export FAKE_RESTIC_STDOUT="$FIXTURES/backup.malformed.jsonl"
export FAKE_RESTIC_STDERR="$TEST_DIR/sensitive-stderr"
printf 'Fatal: password=supersecret at /var/private/restic/repo using s3://user:pass@example.invalid/repo\n' > "$FAKE_RESTIC_STDERR"
export FAKE_CURL_STATE="$TEST_DIR/curl-count-error-sanitizing"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-error-sanitizing"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
set +e
"$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup > "$TEST_DIR/sensitive-out" 2> "$TEST_DIR/sensitive-err"
status=$?
set -e
assert_eq 1 "$status" 'sanitized failure reporting must preserve Restic exit status'
assert_file_eq "$FAKE_RESTIC_STDERR" "$TEST_DIR/sensitive-err" 'stderr contents must remain unchanged after error sanitization'
completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
error_summary=$(jq -r '.result.error_summary' "$completed_file")
for sensitive in supersecret /var/private/restic/repo s3:// user:pass; do
  [[ $error_summary != *"$sensitive"* ]] || fail "sensitive error summary content was transmitted: $sensitive"
done
assert_contains '[REDACTED]' "$completed_file"
assert_contains '[URL]' "$completed_file"

for fixture in backup.no-snapshot.jsonl backup.oversized-counter.jsonl backup.malformed.jsonl; do
  setup_spool "fixture-${fixture//[^A-Za-z0-9]/-}"
  export FAKE_RESTIC_EXIT_CODE=0
  export FAKE_RESTIC_STDOUT="$FIXTURES/$fixture"
  export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
  export FAKE_CURL_STATE="$TEST_DIR/curl-count-${fixture//[^A-Za-z0-9]/-}"
  export FAKE_REQUEST_DIR="$TEST_DIR/requests-${fixture//[^A-Za-z0-9]/-}"
  mkdir -p -- "$FAKE_REQUEST_DIR"
  printf '0\n' > "$FAKE_CURL_STATE"
  parser_output="$TEST_DIR/parser-${fixture}.out"
  "$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup > "$parser_output" 2> "$TEST_DIR/parser-log"
  assert_file_eq "$FIXTURES/$fixture" "$parser_output" 'malformed or unusual JSON must not change stdout'
  completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
  case $fixture in
    backup.no-snapshot.jsonl)
      jq -e 'has("snapshot_id") | not' "$completed_file" >/dev/null || fail 'missing snapshot_id must stay missing'
      ;;
    backup.oversized-counter.jsonl)
      jq -e '.result.metrics | has("bytes_processed") | not' "$completed_file" >/dev/null || fail 'unsafe uint64 must be omitted, not rounded'
      ;;
    backup.malformed.jsonl)
      jq -e '.result | has("metrics") | not' "$completed_file" >/dev/null || fail 'malformed JSON must not produce metrics'
      ;;
  esac
done

for case_name in 'forget:forget.json:forget --json' 'stats:stats.json:stats --mode restore-size --json' 'prune:prune.txt:prune' 'forget_prune:forget-prune.mixed:forget --prune --json'; do
  IFS=: read -r operation fixture restic_command <<< "$case_name"
  setup_spool "operation-$operation"
  export FAKE_RESTIC_EXIT_CODE=0
  export FAKE_RESTIC_STDOUT="$FIXTURES/$fixture"
  export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
  export FAKE_CURL_STATE="$TEST_DIR/curl-count-operation-$operation"
  export FAKE_REQUEST_DIR="$TEST_DIR/requests-operation-$operation"
  mkdir -p -- "$FAKE_REQUEST_DIR"
  printf '0\n' > "$FAKE_CURL_STATE"
  # Keep each Restic argument distinct while preserving the original command shape.
  read -r -a restic_args <<< "$restic_command"
  "$REPORTER" run --job daily --repository repo-a --operation "$operation" --restic-bin "$FAKE_RESTIC" -- "${restic_args[@]}" >/dev/null 2> "$TEST_DIR/operation-log"
  completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
  jq -e '.result | has("metrics") | not' "$completed_file" >/dev/null || fail "$operation must not send backup-only metrics"
  if [[ $operation == stats ]]; then
    jq -e '.result.repository_stats.mode == "restore-size" and .result.repository_stats.value_bytes == 8192 and .result.repository_stats.total_file_count == 4' "$completed_file" >/dev/null || fail 'stats mode and total_size must become typed repository measurement'
  else
    jq -e '.result | has("repository_stats") | not' "$completed_file" >/dev/null || fail "$operation must not send repository statistics"
  fi
  if [[ $operation == forget ]]; then
    ! grep -q 'private/path' "$completed_file" || fail 'forget snapshot paths must not be sent'
  fi
done

setup_spool stats-raw-data
export FAKE_RESTIC_EXIT_CODE=0
export FAKE_RESTIC_STDOUT="$FIXTURES/stats.json"
export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
export FAKE_CURL_STATE="$TEST_DIR/curl-count-stats-raw-data"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-stats-raw-data"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
"$REPORTER" run --job daily --repository repo-a --operation stats --restic-bin "$FAKE_RESTIC" -- stats --mode=raw-data --json >/dev/null 2> "$TEST_DIR/stats-raw-log"
completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
jq -e '.result.repository_stats.mode == "raw-data" and .result.repository_stats.value_bytes == 8192' "$completed_file" >/dev/null || fail 'raw-data measurement mode must be preserved'

setup_spool stats-without-mode
export FAKE_RESTIC_EXIT_CODE=0
export FAKE_RESTIC_STDOUT="$FIXTURES/stats.json"
export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
export FAKE_CURL_STATE="$TEST_DIR/curl-count-stats-without-mode"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-stats-without-mode"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
"$REPORTER" run --job daily --repository repo-a --operation stats --restic-bin "$FAKE_RESTIC" -- stats --json >/dev/null 2> "$TEST_DIR/stats-without-mode-log"
completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
jq -e '.result | has("repository_stats") | not' "$completed_file" >/dev/null || fail 'stats without an explicit mode must not be measured'

for mode_case in duplicate unsupported; do
  setup_spool "stats-$mode_case-mode"
  export FAKE_RESTIC_EXIT_CODE=0
  export FAKE_RESTIC_STDOUT="$FIXTURES/stats.json"
  export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
  export FAKE_CURL_STATE="$TEST_DIR/curl-count-stats-$mode_case-mode"
  export FAKE_REQUEST_DIR="$TEST_DIR/requests-stats-$mode_case-mode"
  mkdir -p -- "$FAKE_REQUEST_DIR"
  printf '0\n' > "$FAKE_CURL_STATE"
  if [[ $mode_case == duplicate ]]; then
    "$REPORTER" run --job daily --repository repo-a --operation stats --restic-bin "$FAKE_RESTIC" -- stats --mode restore-size --mode raw-data --json >/dev/null 2> "$TEST_DIR/stats-duplicate-mode-log"
  else
    "$REPORTER" run --job daily --repository repo-a --operation stats --restic-bin "$FAKE_RESTIC" -- stats --mode files-by-contents --json >/dev/null 2> "$TEST_DIR/stats-unsupported-mode-log"
  fi
  completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
  jq -e '.result | has("repository_stats") | not' "$completed_file" >/dev/null || fail "$mode_case stats mode must not produce a measurement"
done

for stats_case in malformed oversized; do
  setup_spool "stats-$stats_case"
  export FAKE_RESTIC_EXIT_CODE=0
  export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
  export FAKE_CURL_STATE="$TEST_DIR/curl-count-stats-$stats_case"
  export FAKE_REQUEST_DIR="$TEST_DIR/requests-stats-$stats_case"
  mkdir -p -- "$FAKE_REQUEST_DIR"
  printf '0\n' > "$FAKE_CURL_STATE"
  if [[ $stats_case == malformed ]]; then
    printf '{not-json\n' > "$TEST_DIR/stats-$stats_case.json"
  else
    printf '{"total_size":9007199254740992}\n' > "$TEST_DIR/stats-$stats_case.json"
  fi
  export FAKE_RESTIC_STDOUT="$TEST_DIR/stats-$stats_case.json"
  "$REPORTER" run --job daily --repository repo-a --operation stats --restic-bin "$FAKE_RESTIC" -- stats --mode restore-size --json >/dev/null 2> "$TEST_DIR/stats-$stats_case-log"
  completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
  jq -e '.result | has("repository_stats") | not' "$completed_file" >/dev/null || fail "$stats_case stats output must not produce a measurement"
done

setup_spool stats-failed
status=0
export FAKE_RESTIC_EXIT_CODE=1
export FAKE_RESTIC_STDOUT="$FIXTURES/stats.json"
export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
export FAKE_CURL_STATE="$TEST_DIR/curl-count-stats-failed"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-stats-failed"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
"$REPORTER" run --job daily --repository repo-a --operation stats --restic-bin "$FAKE_RESTIC" -- stats --mode restore-size --json >/dev/null 2> "$TEST_DIR/stats-failed-log" || status=$?
assert_eq 1 "${status:-0}" 'stats reporting must preserve the Restic exit status'
completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
jq -e '.result | has("repository_stats") | not' "$completed_file" >/dev/null || fail 'failed stats commands must not produce a measurement'

setup_spool no-api
export FAKE_RESTIC_EXIT_CODE=3
export FAKE_RESTIC_STDOUT="$FIXTURES/backup.partial.jsonl"
export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
env -u RESTIC_MONITOR_API_URL -u RESTIC_MONITOR_TOKEN \
  RESTIC_MONITOR_SPOOL_DIR="$RESTIC_MONITOR_SPOOL_DIR" \
  "$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup > "$TEST_DIR/no-api-out" 2> "$TEST_DIR/no-api-err" || status=$?
assert_eq 3 "${status:-0}" 'API outage/configuration must not replace Restic exit status'
assert_file_eq "$FIXTURES/backup.partial.jsonl" "$TEST_DIR/no-api-out" 'stdout must remain available when reporting is disabled'
assert_eq 2 "$(pending_count)" 'events should remain in the durable spool without API credentials'

setup_spool capacity
export RESTIC_MONITOR_SPOOL_MAX_EVENTS=1
export FAKE_RESTIC_EXIT_CODE=0
export FAKE_RESTIC_STDOUT="$FIXTURES/backup.success.jsonl"
export FAKE_RESTIC_STDERR="$TEST_DIR/empty-stderr"
env -u RESTIC_MONITOR_API_URL -u RESTIC_MONITOR_TOKEN \
  RESTIC_MONITOR_SPOOL_DIR="$RESTIC_MONITOR_SPOOL_DIR" \
  RESTIC_MONITOR_SPOOL_MAX_EVENTS=1 \
  "$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup > "$TEST_DIR/capacity-out" 2> "$TEST_DIR/capacity-err"
assert_eq 1 "$(pending_count)" 'queue cap should retain the first event in pending'
assert_eq 1 "$(quarantine_count)" 'queue cap should preserve rejected event in quarantine'
grep -q 'spool_capacity_reached' "$RESTIC_MONITOR_SPOOL_DIR/quarantine/"*.reason || fail 'capacity overflow reason should be recorded'

setup_spool retry-429
event_file="$TEST_DIR/retry-event.json"
make_event "$event_file" event-retry-429
export RESTIC_MONITOR_API_URL='http://monitor.test'
export RESTIC_MONITOR_TOKEN="$TEST_TOKEN"
export FAKE_CURL_MODE=sequence-429
export FAKE_CURL_STATE="$TEST_DIR/curl-count-retry-429"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-retry-429"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-429-log"
assert_eq 1 "$(pending_count)" '429 should leave event queued for retry'
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-429-log"
assert_eq 0 "$(pending_count)" 'flush should retry after Retry-After and remove only after acceptance'
assert_eq 2 "$(cat "$FAKE_CURL_STATE")" '429 retry should make exactly two attempts'

setup_spool retry-503
event_file="$TEST_DIR/retry-503-event.json"
make_event "$event_file" event-retry-503
unset RESTIC_MONITOR_API_URL RESTIC_MONITOR_TOKEN
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-503-log"
export RESTIC_MONITOR_API_URL='http://monitor.test'
export RESTIC_MONITOR_TOKEN="$TEST_TOKEN"
export FAKE_CURL_MODE=unavailable
export FAKE_CURL_STATE="$TEST_DIR/curl-count-retry-503"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-retry-503"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
export RESTIC_MONITOR_MAX_ATTEMPTS_PER_FLUSH=1
set +e
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-503-log"
status=$?
set -e
assert_eq 1 "$status" '5xx should report pending delivery'
assert_eq 1 "$(pending_count)" '5xx event must remain pending'
[[ -f "$RESTIC_MONITOR_SPOOL_DIR/pending/event-retry-503.state" ]] || fail 'retry state must persist between flushes'
export FAKE_CURL_MODE=success
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-503-retry-log"
assert_eq 0 "$(pending_count)" 'later successful retry should remove the event'

setup_spool auth-rejected
event_file="$TEST_DIR/auth-rejected-event.json"
make_event "$event_file" event-auth-rejected
unset RESTIC_MONITOR_API_URL RESTIC_MONITOR_TOKEN
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-auth-rejected-log"
export RESTIC_MONITOR_API_URL='http://monitor.test'
export RESTIC_MONITOR_TOKEN="$TEST_TOKEN"
export FAKE_CURL_MODE=unauthorized
export FAKE_CURL_STATE="$TEST_DIR/curl-count-auth-rejected"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-auth-rejected"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
export RESTIC_MONITOR_MAX_ATTEMPTS_PER_FLUSH=1
set +e
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-auth-rejected-log"
status=$?
set -e
assert_eq 1 "$status" 'authentication rejection should be reported as pending delivery'
assert_eq 1 "$(pending_count)" '401 must preserve the event for credential recovery'
[[ -f "$RESTIC_MONITOR_SPOOL_DIR/pending/event-auth-rejected.state" ]] || fail '401 retry state should persist'
export FAKE_CURL_MODE=success
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-auth-recovered-log"
assert_eq 0 "$(pending_count)" 'restored credentials should deliver previously rejected event'

setup_spool retry-network
event_file="$TEST_DIR/network-event.json"
make_event "$event_file" event-network
unset RESTIC_MONITOR_API_URL RESTIC_MONITOR_TOKEN
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-network-log"
export RESTIC_MONITOR_API_URL='http://monitor.test'
export RESTIC_MONITOR_TOKEN="$TEST_TOKEN"
export FAKE_CURL_MODE=network
export FAKE_CURL_STATE="$TEST_DIR/curl-count-network"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-network"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
set +e
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-network-log"
status=$?
set -e
assert_eq 1 "$status" 'network errors should leave event for retry'
assert_eq 1 "$(pending_count)" 'network failure must not delete event'

setup_spool permanent-4xx
event_file="$TEST_DIR/permanent-event.json"
make_event "$event_file" event-permanent
unset RESTIC_MONITOR_API_URL RESTIC_MONITOR_TOKEN
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-permanent-log"
export RESTIC_MONITOR_API_URL='http://monitor.test'
export RESTIC_MONITOR_TOKEN="$TEST_TOKEN"
export FAKE_CURL_MODE=bad-request
export FAKE_CURL_STATE="$TEST_DIR/curl-count-permanent"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-permanent"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
set +e
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-permanent-log"
status=$?
set -e
assert_eq 1 "$status" '4xx should be reported as a permanent delivery error'
assert_eq 0 "$(pending_count)" 'permanent 4xx event should leave pending queue'
assert_eq 1 "$(quarantine_count)" 'permanent 4xx event should be quarantined'

setup_spool duplicate-local
event_file="$TEST_DIR/duplicate-local.json"
make_event "$event_file" event-local-duplicate
unset RESTIC_MONITOR_API_URL RESTIC_MONITOR_TOKEN
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-local-first"
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-local-second"
assert_eq 1 "$(pending_count)" 'identical local event should queue once'
changed_event="$TEST_DIR/duplicate-local-changed.json"
jq -c '.result.exit_code = 1' "$event_file" > "$changed_event"
set +e
"$REPORTER" report "$changed_event" >/dev/null 2> "$TEST_DIR/report-local-conflict"
status=$?
set -e
assert_eq 1 "$status" 'different local payload with same event ID should be rejected'
assert_eq 1 "$(pending_count)" 'original payload should remain queued'
assert_eq 1 "$(quarantine_count)" 'changed payload should be quarantined'

setup_spool duplicate-server
event_file="$TEST_DIR/duplicate-server.json"
make_event "$event_file" event-server-duplicate
export FAKE_CURL_MODE=duplicate
export FAKE_CURL_STATE="$TEST_DIR/curl-count-duplicate-server"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-duplicate-server"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
"$REPORTER" report "$event_file" >/dev/null 2> "$TEST_DIR/report-server-duplicate"
assert_eq 0 "$(pending_count)" 'server duplicate acceptance should remove the local event'

setup_spool corrupt
mkdir -p "$RESTIC_MONITOR_SPOOL_DIR/pending"
printf 'not-json\n' > "$RESTIC_MONITOR_SPOOL_DIR/pending/corrupt.json"
export FAKE_CURL_MODE=success
export FAKE_CURL_STATE="$TEST_DIR/curl-count-corrupt"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-corrupt"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
set +e
"$REPORTER" flush >/dev/null 2> "$TEST_DIR/flush-corrupt-log"
status=$?
set -e
assert_eq 1 "$status" 'corrupt queue entry should be reported'
assert_eq 0 "$(pending_count)" 'corrupt entry must not be retried'
assert_eq 1 "$(quarantine_count)" 'corrupt entry must be quarantined'

setup_spool sigterm
export FAKE_RESTIC_MODE=signal
export FAKE_RESTIC_READY_FILE="$TEST_DIR/restic-ready"
rm -f -- "$FAKE_RESTIC_READY_FILE"
export FAKE_CURL_MODE=success
export FAKE_CURL_STATE="$TEST_DIR/curl-count-sigterm"
export FAKE_REQUEST_DIR="$TEST_DIR/requests-sigterm"
mkdir -p -- "$FAKE_REQUEST_DIR"
printf '0\n' > "$FAKE_CURL_STATE"
"$REPORTER" run --job daily --repository repo-a --operation backup --restic-bin "$FAKE_RESTIC" -- --json backup > "$TEST_DIR/sigterm-out" 2> "$TEST_DIR/sigterm-err" &
reporter_pid=$!
for _ in {1..100}; do
  [[ -e $FAKE_RESTIC_READY_FILE ]] && break
  sleep 0.05
done
[[ -e $FAKE_RESTIC_READY_FILE ]] || fail 'fake Restic did not start before SIGTERM test'
kill -TERM "$reporter_pid"
set +e
wait "$reporter_pid"
status=$?
set -e
assert_eq 130 "$status" 'SIGTERM cancellation should preserve Restic cancelled exit code'
completed_file=$(find "$FAKE_REQUEST_DIR" -type f -name '*.json' -exec grep -l 'run.completed' {} \; | head -1)
[[ -n $completed_file ]] || fail 'SIGTERM should still create a completed event'
assert_eq 130 "$(jq -r '.result.exit_code' "$completed_file")" 'cancelled event must carry exit code 130'

printf 'Bash Reporter tests passed.\n'
