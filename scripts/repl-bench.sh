#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
case "${1:-}" in
  ''|-h|--help|help)
    cat <<'USAGE'
repl-bench preflight [--size WxH]
repl-bench start [--size WxH] [-- <repl args>]  # prints a run ID
repl-bench focus <run>
repl-bench type <run> <text>
repl-bench send <run> <key>...
repl-bench wait <run> <text>
repl-bench resize <run> <WxH>
repl-bench screenshot <run> <name>
repl-bench look|status|exit|stop <run>
repl-bench start --tmux [--size WxH] [--real-home] [-- <repl args>]
repl-bench attach|look|tape|journal|send|type|resize|status|stop <tmux-run> [args]
USAGE
    exit 0 ;;
  start)
    if [ "${2:-}" = --tmux ]; then
      shift 2
      exec "$root/scripts/lib/repl-bench-tmux.sh" start "$@"
    fi ;;
  *)
    if [[ "${2:-}" =~ ^tmux\.[a-zA-Z0-9]+$ ]]; then
      exec "$root/scripts/lib/repl-bench-tmux.sh" "$@"
    fi ;;
esac
command -v bun >/dev/null || { echo 'repl-bench requires Bun with PTY support' >&2; exit 1; }
[ -f "$root/node_modules/.xmd-prepared/deno.lock" ] || { echo 'Run deno task setup in this worktree' >&2; exit 1; }
exec bun --no-install "$root/scripts/repl-bench-bun.ts" "$@"
