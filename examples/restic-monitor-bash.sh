#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: RESTIC_MONITOR_PING_URL=https://.../api/v1/ping/rmp1_... \
  restic-monitor-bash.sh <operation> [restic arguments...]

Supported JSON summaries: backup and stats. Other operations report exit code only.
For stats, set RESTIC_MONITOR_STATS_MODE to restore-size or raw-data.
EOF
}

PING_URL=${RESTIC_MONITOR_PING_URL:-}
if [[ -z $PING_URL || $# -lt 1 ]]; then
  usage
  exit 64
fi

operation=$1
shift
case $operation in
  backup|forget|prune|forget_prune|copy|stats|check|restore) ;;
  *) usage; exit 64 ;;
esac

if command -v uuidgen >/dev/null 2>&1; then
  run_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
elif [[ -r /proc/sys/kernel/random/uuid ]]; then
  run_id=$(cat /proc/sys/kernel/random/uuid)
else
  printf 'Cannot generate a run UUID (install uuidgen).\n' >&2
  exit 69
fi

base_url=${PING_URL%/}
request_with_retry() {
  local url=$1 body_file=${2:-} attempt status delay=1
  for attempt in 1 2 3 4; do
    if [[ -n $body_file ]]; then
      status=$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' \
        -H 'Content-Type: application/json' --data-binary "@$body_file" "$url" 2>/dev/null) || status=000
    else
      status=$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' \
        -X POST "$url" 2>/dev/null) || status=000
    fi
    if [[ $status == 2?? ]]; then return 0; fi
    case $status in
      000|408|429|5??) ;;
      *) printf 'Restic Monitor rejected a ping (HTTP %s).\n' "$status" >&2; return 1 ;;
    esac
    if (( attempt < 4 )); then sleep "$delay"; delay=$((delay * 2)); fi
  done
  printf 'Restic Monitor ping did not succeed after bounded retries.\n' >&2
  return 1
}

if ! request_with_retry "$base_url/runs/$run_id/start"; then
  printf 'Continuing Restic without a confirmed start ping.\n' >&2
fi

temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT
stdout_file=$temp_dir/stdout
stderr_file=$temp_dir/stderr

case $operation in
  backup)
    if restic backup --json "$@" >"$stdout_file" 2>"$stderr_file"; then exit_code=0; else exit_code=$?; fi
    ;;
  stats)
    stats_mode=${RESTIC_MONITOR_STATS_MODE:-restore-size}
    if [[ $stats_mode != restore-size && $stats_mode != raw-data ]]; then
      printf 'RESTIC_MONITOR_STATS_MODE must be restore-size or raw-data.\n' >&2
      exit_code=64
    elif restic stats --json --mode "$stats_mode" "$@" >"$stdout_file" 2>"$stderr_file"; then
      exit_code=0
    else
      exit_code=$?
    fi
    ;;
  forget_prune)
    if restic forget --prune "$@" >"$stdout_file" 2>"$stderr_file"; then exit_code=0; else exit_code=$?; fi
    ;;
  *)
    if restic "$operation" "$@" >"$stdout_file" 2>"$stderr_file"; then exit_code=0; else exit_code=$?; fi
    ;;
esac

cat -- "$stdout_file"
cat -- "$stderr_file" >&2

restic_version=$(restic version 2>/dev/null | sed -n 's/^restic \([^ ]*\).*/\1/p' | head -n 1 || true)
completion_file=$temp_dir/completion.json

if [[ $operation == backup ]]; then
  summary=$(jq -s -c '[.[] | select(.message_type == "summary")] | last // empty' "$stdout_file" 2>/dev/null || true)
  if [[ -n $summary ]]; then
    jq -c -n --argjson exit_code "$exit_code" --arg version "$restic_version" --argjson s "$summary" '
      def safe($v): if ($v|type) == "number" and $v >= 0 and $v <= 9007199254740991 and ($v|floor) == $v then $v else null end;
      {exit_code:$exit_code}
      + (if $version == "" then {} else {restic_version:$version} end)
      + {metrics:{
          bytes_processed:safe($s.total_bytes_processed),
          bytes_added:safe($s.data_added),
          bytes_added_packed:safe($s.data_added_packed),
          files_new:safe($s.files_new),
          files_changed:safe($s.files_changed),
          files_unmodified:safe($s.files_unmodified),
          snapshot_id:($s.snapshot_id // null)
        } | with_entries(select(.value != null))}' \
      >"$completion_file" 2>/dev/null || :
  fi
elif [[ $operation == stats && $exit_code == 0 ]]; then
  stats=$(jq -c 'select(type == "object")' "$stdout_file" 2>/dev/null | tail -n 1 || true)
  if [[ -n $stats ]]; then
    jq -c -n --argjson exit_code "$exit_code" --arg version "$restic_version" \
      --arg mode "$stats_mode" --argjson s "$stats" '
      def safe($v): if ($v|type) == "number" and $v >= 0 and $v <= 9007199254740991 and ($v|floor) == $v then $v else null end;
      {exit_code:$exit_code}
      + (if $version == "" then {} else {restic_version:$version} end)
      + (if safe($s.total_size) == null then {} else {repository_stats:{
          mode:$mode,
          value_bytes:safe($s.total_size),
          total_file_count:safe($s.total_file_count),
          total_blob_count:safe($s.total_blob_count),
          snapshots_count:safe($s.snapshots_count),
          total_uncompressed_size:safe($s.total_uncompressed_size)
        } | with_entries(select(.value != null))} end)' \
      >"$completion_file" 2>/dev/null || :
  fi
fi

if [[ ! -s $completion_file ]]; then
  jq -c -n --argjson exit_code "$exit_code" --arg version "$restic_version" \
    '{exit_code:$exit_code} + (if $version == "" then {} else {restic_version:$version} end)' \
    >"$completion_file"
fi

if ! request_with_retry "$base_url/runs/$run_id/complete" "$completion_file"; then
  printf 'Restic Monitor did not confirm completion; this example has no local delivery queue.\n' >&2
fi

exit "$exit_code"
