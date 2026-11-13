# The REPL bench

Use the bench to verify what a person sees in the REPL. Start in the prepared
worktree assigned for verification. Run `deno task setup` there if it still
needs preparation. The bench uses Bun with PTY support and launches that
worktree's Deno entrypoint. It accepts paths containing spaces.

## UI handoff

Give the verifier the absolute worktree, exact revision, starting arguments,
and terminal size. Include the preflight command, the ordered feature actions,
the visible result of each action, and the evidence to return. Use sizes
`160x36`, `120x30`, and `72x20` to exercise the corresponding layouts in the
[REPL specification](../specs/repl-spec.md).

For a narrow Sidekick composer exercise at the assigned revision, run:

```sh
./scripts/repl-bench.sh preflight --size 72x20
```

Preflight opens the Sidekick composer, types an unsent marker, checks the
composer, clears it with Ctrl+C, and presses Ctrl+C again. Expect exit `0` and
a complete `xmd://repl/…?view=sidekick&right=sidekick` location. Return the run
ID, revision, terminal size, exit status, and reopen location, with links to
`run.json`, `screen.txt`, and `terminal.ansi` under the reported evidence path.
Record the feature-specific commands and screen observations alongside them.

## Step through a feature

```sh
run=$(./scripts/repl-bench.sh start --size 160x36)
./scripts/repl-bench.sh focus "$run"
./scripts/repl-bench.sh type "$run" 'unsent text;'
./scripts/repl-bench.sh wait "$run" 'unsent text;'
./scripts/repl-bench.sh look "$run"
./scripts/repl-bench.sh resize "$run" 72x20
./scripts/repl-bench.sh wait "$run" 'Entries    * Sidekick'
./scripts/repl-bench.sh look "$run"
./scripts/repl-bench.sh stop "$run"
```

Use `send` for named keys such as `Tab`, `Shift+Tab`, `Enter`, or `Ctrl+C`.
Use `type` for literal text. Each run owns a terminal, a test home, and
`.bench/<run>/`. `status <run>` prints the launch details. `look` records a
readable screen, and `terminal.ansi` holds the raw PTY output. A failed action
closes its driver and keeps the available evidence. To capture a normal exit,
send the exit key and call `exit <run>` to collect the status and reopen location.

Use `start --tmux` when a person needs to attach to the terminal. Pass its
printed `tmux.…` ID to `attach`, `look`, `tape`, `journal`, and `stop`. Use
`scripts/repl-workbench.md` to read a captured tmux frame and the copied journal
from that run. The journal gives document execution evidence. Screen cells,
focus, and resize evidence come from the terminal capture.

## Markdown tests

```sh
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts test --plugin ./scripts/repl-bench-plugin.ts \
  scripts/tests/repl-bench.md
```

The [testing specification](../specs/testing-spec.md#real-terminal-repl-tests)
describes the plugin and its scope. Use a composer region for a field-value
check. A viewport match can also find the same text in the Draft or Transcript.
