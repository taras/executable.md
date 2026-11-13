#!/usr/bin/env bash
#
# repl-bench — run `xmd repl` in a real terminal and keep what it drew.
#
# The REPL's journal records what a document did and never what the screen
# showed: no keystroke, focus move, drawer, resize or rendered frame reaches it
# (specs/repl-spec.md "Who owns what"). So the only record of the interface is a
# terminal, and this allocates one.
#
# Nothing here runs through XMD, on purpose. `Process.join()` may settle before
# the stdout pumps do, so output a child writes as it exits may never be
# received (effectionx #244) — and a frame lost that way would read as a REPL
# defect. Every capture therefore lands in a file by shell redirection, and the
# workbench document reads the file rather than a pipe.
#
# The tmux mechanism is the one `packages/cli/tests/repl-exit-pty.test.ts`
# already proves: a private server, a pinned pane size, `capture-pane` reads.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BENCH="$ROOT/.bench"


# A capture must say what it is, not exit 0 having written nothing.
die() { printf 'repl-bench: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
repl-bench <command>

  start [--size WxH] [--real-home] [-- <repl args>]
                     allocate a terminal and launch the REPL in it
  attach <run>       attach this terminal to the run, to drive it by hand
  look <run> [label]       capture the screen now, with colour, into the frame tape
  tape <run>         print the frame tape
  journal <run>      copy this run's journal next to the frames
  send <run> <key>...      press named keys (Tab, BTab, Enter, Escape, Backspace)
  type <run> <text>        type literal text, through the paste path
  resize <run> <WxH>       resize the window, which is a real SIGWINCH
  status <run>       print the current run directory and what is in it
  stop <run>         kill this run's private tmux server

Sizes that matter (specs/repl-spec.md): 160x36, 120x30, 72x20, and a refusal
below 72x20. Default 160x36.
USAGE
}

need_tmux() {
  command -v tmux >/dev/null 2>&1 || die "tmux is not installed; it is the terminal this harness needs"
}

load_run() {
  [[ "${RUN_ID:-}" =~ ^tmux\.[a-zA-Z0-9]+$ ]] || die "specify a tmux run ID"
  RUN="$BENCH/$RUN_ID"
  [ -f "$RUN/meta.env" ] || die "run $RUN_ID has no meta.env; it did not start cleanly"
  # shellcheck disable=SC1091
  . "$RUN/meta.env"
}

tm() { tmux -S "$SOCKET" "$@"; }

alive() { tm has-session -t "$SESSION" 2>/dev/null; }

cmd_start() {
  need_tmux
  local size="160x36" real_home="no" args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --size) [ $# -ge 2 ] || die "--size needs WxH"; size="$2"; shift 2 ;;
      --real-home) real_home="yes"; shift ;;
      --) shift; args=("$@"); break ;;
      *) die "unknown option for start: $1" ;;
    esac
  done
  [ ${#args[@]} -gt 0 ] || args=(--deny-all)

  [[ "$size" =~ ^([0-9]+)x([0-9]+)$ ]] || die "size must be WxH, got: $size"
  local cols="${BASH_REMATCH[1]}" rows="${BASH_REMATCH[2]}"

  local id run
  run="$(mktemp -d "$BENCH/tmux.XXXXXXXX")"
  id="${run##*/}"
  mkdir "$run/frames"

  # A unix socket path is capped near 104 bytes and the worktree path is long,
  # so the server's socket lives in TMPDIR rather than beside the frames.
  local socket_dir
  socket_dir="$(mktemp -d /tmp/xmd-bench.XXXXXXXX)"
  local socket="$socket_dir/control"
  local session="xmd-bench-${id#tmux.}"

  # DENO_DIR is passed explicitly because an isolated HOME would otherwise point
  # Deno at an empty cache and make every start a cold download.
  local deno_dir
  deno_dir="$(cd "$ROOT" && deno info --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).denoDir)')"
  local home journal_root
  if [ "$real_home" = "yes" ]; then
    home="$HOME"
  else
    home="$run/home"
    mkdir -p "$home"
  fi
  # On darwin the data root is a fixed ~/Library/Application Support and ignores
  # XDG_DATA_HOME (packages/cli/src/repl-assembly.ts), so HOME is the only lever.
  if [ "$(uname -s)" = Darwin ]; then
    journal_root="$home/Library/Application Support/xmd/repl"
  elif [ "$real_home" = yes ]; then
    journal_root="${XDG_DATA_HOME:-$home/.local/share}/xmd/repl"
  else
    journal_root="$home/.local/share/xmd/repl"
  fi

  # Every value is quoted: the darwin journal root contains "Application
  # Support", and an unquoted assignment makes sourcing this file fail on the
  # space rather than on anything the caller did.
  local revision dirty=no
  revision="$(git -C "$ROOT" rev-parse HEAD)"
  [ -z "$(git --no-optional-locks -C "$ROOT" status --porcelain)" ] || dirty=yes
  {
    printf 'RUN_ID=%q\nSESSION=%q\nSOCKET=%q\n' "$id" "$session" "$socket"
    printf 'COLUMNS_=%q\nROWS_=%q\nHOME_MODE=%q\nRUN_HOME=%q\n' "$cols" "$rows" "$real_home" "$home"
    printf 'JOURNAL_ROOT=%q\nREPL_ARGS=%q\n' "$journal_root" "${args[*]}"
    printf 'REVISION=%q\nDIRTY=%q\nWORKTREE=%q\nREPL_CWD=%q\n' "$revision" "$dirty" "$ROOT" "$PWD"
  } > "$run/meta.env"

  {
    printf 'export HOME=%q DENO_DIR=%q\n' "$home" "$deno_dir"
    if [ "$real_home" = no ]; then
      printf 'export XDG_DATA_HOME=%q XDG_CONFIG_HOME=%q XDG_STATE_HOME=%q XDG_CACHE_HOME=%q\n' \
        "$home/.local/share" "$home/.config" "$home/.local/state" "$home/.cache"
    fi
    printf '%q ' deno run --allow-all --cached-only --frozen --node-modules-dir=none \
      --config "$ROOT/deno.json" "$ROOT/packages/cli/src/deno.ts" repl "${args[@]}"
    printf '\n'
    cat <<'LAUNCH'
printf 'XMD-BENCH-EXIT=%s\n' "$?"
LAUNCH
  } > "$run/launch.sh"
  local launch_command
  printf -v launch_command 'exec bash %q' "$run/launch.sh"
  tmux -S "$socket" -f /dev/null new-session -d -s "$session" -x "$cols" -y "$rows" \
    -c "$PWD" 'exec sleep 86400' &&
    tmux -S "$socket" set-option -t "$session" remain-on-exit on &&
    tmux -S "$socket" respawn-pane -k -t "$session" "$launch_command" || {
      tmux -S "$socket" kill-server 2>/dev/null || true
      rm -f "$socket"
      rmdir "$socket_dir"
      die "tmux could not allocate a ${cols}x${rows} session"
    }

  cat <<DONE
run       $id
session   $session
size      ${cols}x${rows}
repl      ${args[*]}
home      $home ($([ "$real_home" = yes ] && echo "real" || echo "isolated"))
journal   $journal_root
frames    $run/frames

Attach with:  tmux -S $socket attach -t $session
DONE
}

# The socket lives in TMPDIR and its path is long, so attaching is a subcommand
# rather than a line to copy. Interactive by definition: this one replaces the
# shell that called it.
cmd_attach() {
  need_tmux; load_run
  alive || die "session $SESSION is gone; start a new run"
  exec tmux -S "$SOCKET" attach -t "$SESSION"
}

cmd_look() {
  need_tmux; load_run
  local label="${1:-}"
  [[ -z "$label" || "$label" =~ ^[a-zA-Z0-9_-]+$ ]] || die "invalid frame label"
  alive || die "session $SESSION is gone; its frames are in $RUN/frames"

  local n next frame
  n="$(find "$RUN/frames" -name '*.ansi' | wc -l | tr -d ' ')"
  next="$(printf '%03d' "$((n + 1))")"
  frame="$RUN/frames/$next${label:+-$label}.ansi"

  # -e keeps the SGR sequences, which is the whole point once every row carries
  # a 24-bit foreground; -N keeps trailing spaces so a blank footer reads blank
  # rather than short. A pane that cannot be captured fails here instead of
  # writing an empty frame that would read as a blank screen.
  tm capture-pane -p -e -N -t "$SESSION" > "$frame" \
    || die "capture-pane failed for $SESSION"
  [ -s "$frame" ] || die "captured zero bytes from $SESSION; the pane drew nothing"

  local bytes
  bytes="$(wc -c < "$frame" | tr -d ' ')"
  {
    printf '=== frame %s %s %s bytes%s ===\n' \
      "$next" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$bytes" "${label:+ $label}"
    cat "$frame"
    printf '\n'
  } >> "$RUN/tape.ansi"

  # A stable name beside the numbered frames, so the workbench document can read
  # "the frame as it is now" without being told an index.
  cp "$frame" "$RUN/latest.ansi"

  printf 'frame %s  %s bytes  %s\n' "$next" "$bytes" "$frame"
}

cmd_tape() {
  load_run
  [ -f "$RUN/tape.ansi" ] || die "no frames captured yet in $RUN_ID"
  cat "$RUN/tape.ansi"
}

cmd_journal() {
  need_tmux; load_run
  local execution journal
  execution="$(tm capture-pane -p -t "$SESSION" | sed -nE 's/.*XMD REPL  session ([0-9a-f]+).*/\1/p' | head -n 1)"
  if [ -z "$execution" ] && [ -f "$RUN/execution.txt" ]; then
    execution="$(cat "$RUN/execution.txt")"
  fi
  [[ "$execution" =~ ^[a-f0-9]{32}$ ]] || die "the terminal has no visible execution ID; capture the REPL before exiting"
  journal="$JOURNAL_ROOT/v1/$execution/entries.jsonl"
  [ -f "$journal" ] || die "no entry journal for this run under $JOURNAL_ROOT"
  cp "$journal" "$RUN/journal.jsonl"
  printf '%s\n' "$execution" > "$RUN/execution.txt"
  printf 'journal   %s\nexecution %s\nrecords   %s\n' \
    "$RUN/journal.jsonl" "$execution" "$(wc -l < "$RUN/journal.jsonl" | tr -d ' ')"
}

cmd_send() {
  need_tmux; load_run
  [ $# -gt 0 ] || die "send needs at least one key name"
  alive || die "session $SESSION is gone"
  tm send-keys -t "$SESSION" "$@" || die "send-keys failed"
  printf 'sent %s\n' "$*"
}

cmd_type() {
  need_tmux; load_run
  [ $# -gt 0 ] || die "type needs text"
  alive || die "session $SESSION is gone"
  # The paste path, not send-keys: tmux's parser eats a trailing `;` even from a
  # literal argument, and -r sends raw LF, which the decoder maps to the one
  # chord that is text instead of submitting every line.
  local text="$*"
  printf '%s' "$text" | tm load-buffer - || die "load-buffer failed"
  tm paste-buffer -r -t "$SESSION" || die "paste-buffer failed"
  printf 'typed %s bytes\n' "${#text}"
}

cmd_resize() {
  need_tmux; load_run
  [ $# -eq 1 ] || die "resize needs WxH"
  [[ "$1" =~ ^([0-9]+)x([0-9]+)$ ]] || die "size must be WxH, got: $1"
  alive || die "session $SESSION is gone"
  tm resize-window -t "$SESSION" -x "${BASH_REMATCH[1]}" -y "${BASH_REMATCH[2]}" \
    || die "resize-window failed"
  printf 'resized to %s\n' "$1"
}

cmd_status() {
  load_run
  printf 'run       %s\nsize      %sx%s\nhome      %s\n' \
    "$RUN_ID" "$COLUMNS_" "$ROWS_" "$([ "$HOME_MODE" = yes ] && echo real || echo isolated)"
  printf 'session   %s\n' "$(alive && echo "$SESSION (alive)" || echo "$SESSION (gone)")"
  printf 'frames    %s\n' "$(find "$RUN/frames" -name '*.ansi' | wc -l | tr -d ' ')"
  printf 'directory %s\n' "$RUN"
}

cmd_stop() {
  need_tmux; load_run
  if alive; then
    tm kill-server 2>/dev/null || true
    # Teardown is not complete until the server is actually gone.
    local i
    for i in $(seq 1 100); do alive || break; sleep 0.05; done
    alive && die "tmux server for $SESSION did not exit"
  fi
  rmdir "${SOCKET%/*}" 2>/dev/null || true
  printf 'stopped %s; artifacts kept in %s\n' "$RUN_ID" "$RUN"
}

mkdir -p "$BENCH"
command="${1:-}"
if [ "$command" != start ] && [ "$#" -ge 2 ]; then
  RUN_ID="$2"
  shift
fi
case "$command" in
  start) shift; cmd_start "$@" ;;
  attach) shift; cmd_attach "$@" ;;
  look) shift; cmd_look "$@" ;;
  tape) shift; cmd_tape "$@" ;;
  journal) shift; cmd_journal "$@" ;;
  send) shift; cmd_send "$@" ;;
  type) shift; cmd_type "$@" ;;
  resize) shift; cmd_resize "$@" ;;
  status) shift; cmd_status "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command: $1" ;;
esac
