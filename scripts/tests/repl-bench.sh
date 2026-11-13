#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"
bench=./scripts/repl-bench.sh

first_file="$(mktemp)"
second_file="$(mktemp)"
log="$(mktemp)"
cleanup() {
  local file run
  for file in "$first_file" "$second_file"; do
    run="$(cat "$file")"
    if [ -n "$run" ] && [ -f ".bench/$run/endpoint" ]; then
      "$bench" stop "$run" || true
    fi
  done
  rm -f "$first_file" "$second_file" "$log"
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
"$bench" look "$first" | rg -F 'bench-first;'
"$bench" look "$second" | rg -F 'bench-second;'
if rg -F 'bench-second;' ".bench/$first/screen.txt" || rg -F 'bench-first;' ".bench/$second/screen.txt"; then
  exit 1
fi

if "$bench" wait "$first" 'missing-on-purpose' > "$log" 2>&1; then
  echo 'Expected the wait to fail' >&2
  exit 1
fi
cat "$log"
rg -F 'Timed out waiting for "missing-on-purpose"' "$log"
rg -F 'bench-first;' ".bench/$first/screen.txt"
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
