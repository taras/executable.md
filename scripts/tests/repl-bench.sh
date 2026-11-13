#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"
bench=./scripts/repl-bench.sh

first_file="$(mktemp)"
second_file="$(mktemp)"
log="$(mktemp)"
workers="$(mktemp)"
cleanup() {
  local file run
  for file in "$first_file" "$second_file"; do
    run="$(cat "$file")"
    if [ -n "$run" ] && [ -f ".bench/$run/endpoint" ]; then
      "$bench" stop "$run" || true
    fi
  done
  rm -f "$first_file" "$second_file" "$log" "$workers"
}
trap cleanup EXIT

"$bench" start > "$first_file" & first_start=$!
"$bench" start > "$second_file" & second_start=$!
wait "$first_start"
wait "$second_start"
first="$(cat "$first_file")"
second="$(cat "$second_file")"
[ "$first" != "$second" ]

"$bench" focus "$first"
"$bench" focus "$second"
"$bench" type "$first" 'bench-first;'
"$bench" type "$second" 'bench-second;'
"$bench" wait "$first" 'bench-first;'
"$bench" wait "$second" 'bench-second;'
"$bench" look "$first" | grep -F 'bench-first;'
"$bench" look "$second" | grep -F 'bench-second;'
if grep -F 'bench-second;' ".bench/$first/screen.txt" || grep -F 'bench-first;' ".bench/$second/screen.txt"; then
  exit 1
fi

if "$bench" wait "$first" 'missing-on-purpose' > "$log" 2>&1; then
  echo 'Expected the wait to fail' >&2
  exit 1
fi
cat "$log"
grep -F 'Timed out waiting for "missing-on-purpose"' "$log"
grep -F 'bench-first;' ".bench/$first/screen.txt"
test -s ".bench/$first/terminal.ansi"
test -f ".bench/$first/closed.json"
test ! -e ".bench/$first/endpoint"
! kill -0 "$(cat ".bench/$first/pid")" 2>/dev/null

"$bench" type "$second" 'still-open;'
"$bench" wait "$second" 'bench-second;still-open;'
"$bench" stop "$second"
test -f ".bench/$second/closed.json"
test ! -e ".bench/$second/endpoint"
! kill -0 "$(cat ".bench/$second/pid")" 2>/dev/null

deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts test --plugin ./scripts/repl-bench-plugin.ts \
  scripts/tests/repl-bench-timeout.md > "$log" 2>&1 &
suite_pid=$!
while kill -0 "$suite_pid" 2>/dev/null; do
  ps -ww -axo pid=,ppid=,command= | awk -v cli="$root/packages/cli/src/deno.ts" '
    $3 ~ /(^|\/)deno$/ && $4 == "run" && index($0, cli " test-agent --connect ") { print $1, $2 }
  ' >> "$workers"
  sleep .2
done
if wait "$suite_pid"; then
  echo 'Expected the Markdown failure controls to fail' >&2
  exit 1
fi
grep -F 'test timed out after 8 seconds' "$log"
grep -F 'Timed out waiting for "only-in-draft-1248" in sidekick-composer' "$log"
grep -F 'Timed out waiting for "false-history-drawer" in history' "$log"

grep -F 'Scripted Sidekick prompt "Unexpected prompt.": prompt did not match the active stage.' "$log"
check_failed_run_closed() {
  local reason="$1" directory repl_pid worker_pids worker_pid
  directory="$(awk -v reason="$reason" '
    index($0, reason) { failed = 1 }
    failed && /^Evidence: / { print substr($0, length("Evidence: ") + 1); exit }
  ' "$log")"
  test -n "$directory"
  test -s "$directory/screen.txt"
  test -s "$directory/terminal.ansi"
  test -f "$directory/closed.json"
  repl_pid="$(cat "$directory/pid")"
  if kill -0 "$repl_pid" 2>/dev/null; then
    echo "REPL $repl_pid survived the failure" >&2
    exit 1
  fi
  worker_pids="$(awk -v owner="$repl_pid" '$2 == owner { print $1 }' "$workers" | sort -u)"
  test -n "$worker_pids"
  for worker_pid in $worker_pids; do
    if kill -0 "$worker_pid" 2>/dev/null; then
      echo "Scripted worker $worker_pid survived the REPL failure" >&2
      exit 1
    fi
  done
}
check_failed_run_closed 'Scripted Sidekick prompt "Unexpected prompt.":'
grep -F 'Timed out waiting for "fail-with-a-pending-acp-question" in viewport' "$log"
check_failed_run_closed 'Timed out waiting for "fail-with-a-pending-acp-question" in viewport'
