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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$ROOT/.bench"
POINTER="$BENCH/current"

# A capture must say what it is, not exit 0 having written nothing.
die() { printf 'repl-bench: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
repl-bench <command>

  start [--size WxH] [--real-home] [-- <repl args>]
                     allocate a terminal and launch the REPL in it
  attach             attach this terminal to the run, to drive it by hand
  look [label]       capture the screen now, with colour, into the frame tape
  tape               print the frame tape
  journal            copy this run's journal next to the frames
  send <key>...      press named keys (Tab, BTab, Enter, Escape, Backspace)
  type <text>        type literal text, through the paste path
  resize <WxH>       resize the window, which is a real SIGWINCH
  status             print the current run directory and what is in it
  stop               kill this run's private tmux server

Sizes that matter (specs/repl-spec.md): 160x36, 120x30, 72x20, and a refusal
below 72x20. Default 160x36.
USAGE
}

need_tmux() {
  command -v tmux >/dev/null 2>&1 || die "tmux is not installed; it is the terminal this harness needs"
}

# Every command after `start` reads the run it left behind, so a missing pointer
# is a clear message rather than an unbound variable.
load_run() {
  [ -f "$POINTER" ] || die "no run yet — start one with: scripts/repl-bench.sh start"
  RUN_ID="$(cat "$POINTER")"
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
  id="$(date +%y%m%d-%H%M%S)"
  run="$BENCH/$id"
  [ -e "$run" ] && die "run $id already exists"
  mkdir -p "$run/frames"

  # A unix socket path is capped near 104 bytes and the worktree path is long,
  # so the server's socket lives in TMPDIR rather than beside the frames.
  local socket="${TMPDIR:-/tmp}/xmd-bench-$id.sock"
  local session="xmd-bench-$id"

  # DENO_DIR is passed explicitly because an isolated HOME would otherwise point
  # Deno at an empty cache and make every start a cold download.
  local deno_dir="${DENO_DIR:-$HOME/Library/Caches/deno}"
  local home journal_root
  if [ "$real_home" = "yes" ]; then
    home="$HOME"
  else
    home="$run/home"
    mkdir -p "$home"
  fi
  # On darwin the data root is a fixed ~/Library/Application Support and ignores
  # XDG_DATA_HOME (packages/cli/src/repl-assembly.ts), so HOME is the only lever.
  journal_root="$home/Library/Application Support/xmd/repl"

  # In real-home mode the directory already holds every past run, so record what
  # was there before launch; mtime in a directory of 88 files is not evidence.
  if [ "$real_home" = "yes" ] && [ -d "$journal_root" ]; then
    ls -1 "$journal_root" > "$run/journals-before.txt" 2>/dev/null || true
  else
    : > "$run/journals-before.txt"
  fi

  # Every value is quoted: the darwin journal root contains "Application
  # Support", and an unquoted assignment makes sourcing this file fail on the
  # space rather than on anything the caller did.
  cat > "$run/meta.env" <<META
RUN_ID="$id"
SESSION="$session"
SOCKET="$socket"
COLUMNS_="$cols"
ROWS_="$rows"
HOME_MODE="$real_home"
RUN_HOME="$home"
JOURNAL_ROOT="$journal_root"
REPL_ARGS="${args[*]}"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
META

  # The command is written to a file rather than inlined into `new-session`, so
  # quoting passes through one layer instead of three.
  cat > "$run/launch.sh" <<LAUNCH
#!/usr/bin/env bash
cd "$ROOT"
export HOME="$home"
export DENO_DIR="$deno_dir"
stty rows $rows cols $cols 2>/dev/null || true
deno run --allow-all "$ROOT/packages/cli/src/deno.ts" repl ${args[*]}
printf 'XMD-BENCH-EXIT=%s\n' "\$?"
exec sleep 86400
LAUNCH
  chmod +x "$run/launch.sh"

  tmux -S "$socket" -f /dev/null new-session -d -s "$session" -x "$cols" -y "$rows" \
    -c "$ROOT" "exec bash $run/launch.sh" \
    || die "tmux could not allocate a ${cols}x${rows} session"

  printf '%s\n' "$id" > "$POINTER"

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
  load_run
  [ -d "$JOURNAL_ROOT" ] || die "no journal directory at $JOURNAL_ROOT; the REPL has not created its history file"

  local -a names=()
  while IFS= read -r line; do [ -n "$line" ] && names+=("$line"); done < <(
    if [ "$HOME_MODE" = "yes" ]; then
      ls -1 "$JOURNAL_ROOT" | grep -vxF -f "$RUN/journals-before.txt" || true
    else
      ls -1 "$JOURNAL_ROOT" || true
    fi
  )

  [ ${#names[@]} -gt 0 ] || die "no journal appeared for this run under $JOURNAL_ROOT"
  if [ ${#names[@]} -gt 1 ]; then
    die "expected one journal for this run, found ${#names[@]}: ${names[*]}"
  fi

  cp "$JOURNAL_ROOT/${names[0]}" "$RUN/journal.jsonl"
  printf '%s\n' "${names[0]%.jsonl}" > "$RUN/execution.txt"
  printf 'journal   %s\nexecution %s\nrecords   %s\n' \
    "$RUN/journal.jsonl" "${names[0]%.jsonl}" "$(wc -l < "$RUN/journal.jsonl" | tr -d ' ')"
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
  printf 'stopped %s; artifacts kept in %s\n' "$RUN_ID" "$RUN"
}

mkdir -p "$BENCH"
case "${1:-}" in
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
