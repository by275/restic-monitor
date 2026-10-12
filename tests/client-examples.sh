#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMP_DIR=$(mktemp -d)
trap 'rm -rf -- "$TEMP_DIR"' EXIT
mkdir -p "$TEMP_DIR/bin" "$TEMP_DIR/captures"

cat >"$TEMP_DIR/bin/uuidgen" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_RUN_ID:?}"
EOF

cat >"$TEMP_DIR/bin/restic" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == version ]]; then
  printf 'restic 0.19.1 compiled with go1.25.1\n'
  exit 0
fi
if [[ ${1:-} == backup && ${2:-} != --json ]]; then exit 96; fi
if [[ ${1:-} == stats && ${2:-} != --json ]]; then exit 97; fi
cat "${FAKE_RESTIC_FIXTURE:?}"
exit "${FAKE_RESTIC_EXIT_CODE:-0}"
EOF

cat >"$TEMP_DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
body_file=
url=${!#}
while (($#)); do
  if [[ $1 == --data-binary ]]; then
    shift
    body_file=${1#@}
  fi
  shift
done
counter_file=$FAKE_CAPTURE_DIR/curl-count
count=0
[[ -f $counter_file ]] && count=$(cat "$counter_file")
count=$((count + 1))
printf '%s' "$count" > "$counter_file"
if [[ $url == */complete ]]; then
  printf '%s\n' "$url" >> "$FAKE_CAPTURE_DIR/completion-urls"
  if [[ -n $body_file ]]; then cp "$body_file" "$FAKE_CAPTURE_DIR/body-$count.json"; fi
  if [[ ${FAKE_RETRY_COMPLETION_ONCE:-0} == 1 && ! -e $FAKE_CAPTURE_DIR/retried ]]; then
    touch "$FAKE_CAPTURE_DIR/retried"
    printf '503'
    exit 0
  fi
else
  printf '%s\n' "$url" >> "$FAKE_CAPTURE_DIR/start-urls"
fi
printf '200'
EOF
chmod +x "$TEMP_DIR/bin/uuidgen" "$TEMP_DIR/bin/restic" "$TEMP_DIR/bin/curl"

export PATH="$TEMP_DIR/bin:$PATH"
export RESTIC_MONITOR_PING_URL="https://monitor.example/api/v1/ping/rmp1_test-capability"
export FAKE_RUN_ID="019a9f34-8ac0-7a00-a004-123456789abc"
export FAKE_CAPTURE_DIR="$TEMP_DIR/captures"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

export FAKE_RESTIC_FIXTURE="$ROOT/tests/fixtures/restic/0.19.1/backup.success.jsonl"
export FAKE_RESTIC_EXIT_CODE=0
export FAKE_RETRY_COMPLETION_ONCE=1
"$ROOT/examples/restic-monitor-bash.sh" backup /synthetic/source >"$TEMP_DIR/backup.out" 2>"$TEMP_DIR/backup.err"
[[ $(cat "$TEMP_DIR/captures/start-urls") == *"/runs/$FAKE_RUN_ID/start" ]] || fail 'backup start URL must include the generated run ID'
[[ $(tail -n 1 "$TEMP_DIR/captures/completion-urls") == *"/runs/$FAKE_RUN_ID/complete" ]] || fail 'backup completion retry must reuse the generated run ID'
jq -e '.exit_code == 0 and .restic_version == "0.19.1" and .metrics.bytes_processed == 16384 and .metrics.bytes_added == 8192 and .metrics.snapshot_id == "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"' "$TEMP_DIR/captures/body-2.json" >/dev/null || fail 'backup JSON Lines summary should map to the v1 metrics body'
cmp -s "$TEMP_DIR/captures/body-2.json" "$TEMP_DIR/captures/body-3.json" || fail 'completion retry must reuse an identical body'

rm -f "$TEMP_DIR/captures/curl-count" "$TEMP_DIR/captures/start-urls" "$TEMP_DIR/captures/completion-urls" "$TEMP_DIR/captures/retried" "$TEMP_DIR/captures"/body-*.json
export FAKE_RETRY_COMPLETION_ONCE=0
export FAKE_RESTIC_FIXTURE="$ROOT/tests/fixtures/restic/0.19.1/stats.json"
export RESTIC_MONITOR_STATS_MODE=restore-size
"$ROOT/examples/restic-monitor-bash.sh" stats synthetic-repository >"$TEMP_DIR/stats.out" 2>"$TEMP_DIR/stats.err"
jq -e '.exit_code == 0 and .repository_stats.mode == "restore-size" and .repository_stats.value_bytes == 8192 and .repository_stats.snapshots_count == 2' "$TEMP_DIR/captures/body-2.json" >/dev/null || fail 'stats JSON should include the selected mode and safe measurement'

rm -f "$TEMP_DIR/captures/curl-count" "$TEMP_DIR/captures/start-urls" "$TEMP_DIR/captures/completion-urls" "$TEMP_DIR/captures"/body-*.json
export FAKE_RESTIC_FIXTURE="$ROOT/tests/fixtures/restic/0.19.1/backup.partial.jsonl"
export FAKE_RESTIC_EXIT_CODE=3
if "$ROOT/examples/restic-monitor-bash.sh" backup /synthetic/source >"$TEMP_DIR/partial.out" 2>"$TEMP_DIR/partial.err"; then
  exit_code=0
else
  exit_code=$?
fi
[[ $exit_code == 3 ]] || fail 'Restic exit code 3 must be returned unchanged'
jq -e '.exit_code == 3 and .metrics.files_new == 1' "$TEMP_DIR/captures/body-2.json" >/dev/null || fail 'partial backup summary should preserve exit code and metrics'

rm -f "$TEMP_DIR/captures/curl-count" "$TEMP_DIR/captures/start-urls" "$TEMP_DIR/captures/completion-urls" "$TEMP_DIR/captures"/body-*.json
export FAKE_RESTIC_FIXTURE="$ROOT/tests/fixtures/restic/0.19.1/backup.success.jsonl"
export FAKE_RESTIC_EXIT_CODE=130
if "$ROOT/examples/restic-monitor-bash.sh" backup /synthetic/source >"$TEMP_DIR/cancelled.out" 2>"$TEMP_DIR/cancelled.err"; then
  exit_code=0
else
  exit_code=$?
fi
[[ $exit_code == 130 ]] || fail 'Restic exit code 130 must be returned unchanged'
jq -e '.exit_code == 130' "$TEMP_DIR/captures/body-2.json" >/dev/null || fail 'cancellation exit code must be sent to the API'

rm -f "$TEMP_DIR/captures/curl-count" "$TEMP_DIR/captures/start-urls" "$TEMP_DIR/captures/completion-urls" "$TEMP_DIR/captures"/body-*.json
export FAKE_RESTIC_EXIT_CODE=42
if "$ROOT/examples/restic-monitor-bash.sh" backup /synthetic/source >"$TEMP_DIR/unknown.out" 2>"$TEMP_DIR/unknown.err"; then
  exit_code=0
else
  exit_code=$?
fi
[[ $exit_code == 42 ]] || fail 'unrecognized Restic exit code must be returned unchanged'
jq -e '.exit_code == 42' "$TEMP_DIR/captures/body-2.json" >/dev/null || fail 'unrecognized exit code must be sent without remapping'

rm -f "$TEMP_DIR/captures/curl-count" "$TEMP_DIR/captures/start-urls" "$TEMP_DIR/captures/completion-urls" "$TEMP_DIR/captures"/body-*.json
export FAKE_RESTIC_FIXTURE="$ROOT/tests/fixtures/restic/0.19.1/backup.malformed.jsonl"
export FAKE_RESTIC_EXIT_CODE=0
"$ROOT/examples/restic-monitor-bash.sh" backup /synthetic/source >"$TEMP_DIR/malformed.out" 2>"$TEMP_DIR/malformed.err"
jq -e '.exit_code == 0 and (has("metrics") | not)' "$TEMP_DIR/captures/body-2.json" >/dev/null || fail 'malformed JSON output should still report the command exit code'

printf 'Client example tests passed (synthetic Restic fixtures; no network or repository used).\n'
