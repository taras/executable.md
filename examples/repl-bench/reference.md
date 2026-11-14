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
[REPL specification](../../specs/repl-spec.md).

For a narrow Sidekick composer exercise at the assigned revision, run:

```sh
bun --no-install ./examples/repl-bench/bench.ts preflight --size 72x20
```

Preflight opens the Sidekick composer, types an unsent marker, checks the
composer, clears it with Ctrl+C, and presses Ctrl+C again. Expect exit `0` and
a complete `xmd://repl/…?view=sidekick&right=sidekick` location. Return the run
ID, revision, terminal size, exit status, and reopen location, with links to
`run.json`, `screen.txt`, and `terminal.ansi` under the reported evidence path.
Record the feature-specific commands and screen observations alongside them.
For before-and-after evidence, follow the
[visual verification guide](README.md).

## Step through a feature

```sh
run=$(bun --no-install ./examples/repl-bench/bench.ts start --size 160x36)
bun --no-install ./examples/repl-bench/bench.ts focus "$run"
bun --no-install ./examples/repl-bench/bench.ts type "$run" 'unsent text;'
bun --no-install ./examples/repl-bench/bench.ts wait "$run" 'unsent text;'
bun --no-install ./examples/repl-bench/bench.ts look "$run"
bun --no-install ./examples/repl-bench/bench.ts resize "$run" 72x20
bun --no-install ./examples/repl-bench/bench.ts wait "$run" 'Entries    * Sidekick'
bun --no-install ./examples/repl-bench/bench.ts look "$run"
bun --no-install ./examples/repl-bench/bench.ts screenshot "$run" narrow-sidekick
bun --no-install ./examples/repl-bench/bench.ts stop "$run"
```

Use `send` for named keys such as `Tab`, `Shift+Tab`, `Enter`, or `Ctrl+C`.
Use `type` for literal text. Each run owns a terminal, a test home, and
`.bench/<run>/`. `status <run>` prints the launch details. `look` records a
readable screen, and `terminal.ansi` holds the raw PTY output. A failed action
closes its driver and keeps the available evidence. To capture a normal exit,
send the exit key and call `exit <run>` to collect the status and reopen location.
Use `screenshot <run> <name>` after waiting for the expected state. It prints the
path to `.bench/<run>/<name>.svg`, an image of the visible viewport with its
terminal colors and styling. Use distinct names for before and after captures.

Use `./examples/repl-bench/tmux.sh start` when a person needs to attach to the terminal. Pass its
printed `tmux.…` ID to `attach`, `look`, `tape`, `journal`, and `stop`. Use
the [workbench document](workbench.md) to read a captured tmux frame and the copied journal
from that run. The journal gives document execution evidence. Screen cells,
focus, and resize evidence come from the terminal capture.

## Markdown tests

```sh
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts test examples/repl-bench/journeys
```

Run one document by passing its `*.test.md` path. Both forms use the plugin
declared in `examples/repl-bench/xmd.json`. Run from the worktree root so the scripted
scenarios resolve from that working directory.

Use a composer region for a field-value
check. A viewport match can also find the same text in the Draft or Transcript.
Use `<Terminal.Screenshot name="narrow-sidekick" as="image" />` inside an active
bench to save the visible viewport and bind the image path. The bench CI jobs
include saved screenshots in their failure artifacts.

Run [repl-shared-terminal.test.md](journeys/repl-shared-terminal.test.md) to check these launch transitions in one
test. Start at `120x30`, submit the marker entry, and resize to `72x20` with
Sidekick visible. A nested `160x36` Terminal opens an empty REPL. After the
nested launch exits, the outer screen still shows its narrow Sidekick view.
Exit that REPL and reopen it in the outer Terminal. Expect the same narrow
view and the saved marker in Entry 1. The next fresh launch uses `72x20` and
shows an empty history. Resize the idle Terminal to `120x30` and reopen the
retained session again to verify that the current viewport supplies the size.

## Plugin components

| Component | Contract |
| --- | --- |
| `Terminal` | A paired invocation establishes a viewport with the supplied `columns` and `rows`. Its body uses that viewport for sequential launches. A nested Terminal has its own viewport and launch. |
| `XMD.Repl` | A paired invocation runs its body once after the REPL is usable. The child starts in the invocation's contextual cwd and uses the nearest Terminal's current dimensions. Without an enclosing `XMD.Build`, it uses the current XMD host's command. A standalone bench supplies its own Terminal, with optional `columns` and `rows`. |
| `XMD.Repl.SidekickPrompt` | Sends `text` over ACP and waits until the exchange joins, including any automatic entry feedback. On completion, `as` binds the exchange with `ending.joined`, `ending.outcome` and `output`. A failed or cancelled exchange fails this step. |
| `XMD.Repl.SidekickStatus` | Binds the attachment status with `as`, including its submitted `messages` and `canonical` conversation counts. |
| `XMD.Repl.EntryOutput` | Reads the final window of a submitted entry's output over ACP. `entry` is the one-based entry number and `as` binds the page, including its `status` and `text`. |
| `Terminal.Focus` | `target="sidekick-composer"` focuses the composer through visible controls and waits for its focus marker. |
| `Terminal.Type` | `text` is pasted into the focused field, preserving punctuation and line breaks. |
| `Terminal.Key` | `key` sends a named key to the current focus. |
| `Terminal.Click` | Sends a primary-button press at the viewport cell supplied as `at={{ row, column }}`. |
| `Terminal.Resize` | `columns` and `rows` resize the viewport. During a launch this resizes both the PTY and its emulator. Between launches it sets the size of the next launch. |
| `Terminal.Screenshot` | Saves the full visible viewport with its terminal colors and styling to `<name>.svg` in the active launch's evidence directory. Set `format="png"` to render a PNG with `rsvg-convert` and bind its path instead. `as` binds the absolute path. The name starts with a letter or digit and may contain letters, digits, hyphens, and underscores, up to 64 characters. Reusing a name replaces that image. |
| `Terminal.Region` | The paired `name="sidekick-composer"`, `name="transcript"`, or `name="history"` selects a visible region for its body. Nested regions override the selection for their body. Focus and pane selection stay where they were. |
| `Terminal.WaitForText` | Waits for `text` in the nearest region or viewport. Optional `row` limits the match to a zero-based viewport row. Optional `at={{ row, column }}` matches its starting cell using zero-based coordinates. Optional `bold` matches the starting cell’s rendered bold attribute. `as` binds the unique positive match. Use `count` to wait for an exact number of matches. It cannot be combined with `as` or `present`. Zero matches or `present={false}` require the selected region to be visible. A `timeout` duration overrides the enclosing bench's wait duration. |
| `Terminal.Scroll` | `delta` is the signed number of wheel steps over the nearest region. Zero does nothing. Nonzero steps require a visible scroll target. Optional `at={{ row, column }}` targets a cell inside the selected region or viewport. |

The terminal controls use the nearest Terminal without a handle. Input and
screen inspection require an active launch. The acceptance journeys also use
`ReplBench` and `ReplBench.*`. Set initial dimensions on the enclosing
`Terminal`.

`waitTimeout` sets the default `WaitForText` duration for an `<XMD.Repl>` body,
including nested regions. It defaults to five seconds. Each bench supplies its
own duration, including when it uses `resume`. The enclosing `<Test>` deadline
can end a wait earlier.

Set `scenario` on a fresh bench to resolve a Markdown Test Agent behavior file
from the invocation's contextual cwd. The child starts a private scripted
Sidekick and the bench waits for its ACP attachment before running the body.
The scenario starts with the attachment initialization prompt and progresses
through each user prompt and the resulting entry feedback. ACP actions use
the enclosing bench's attachment. Each scripted bench starts its own
scenario and session. A scenario cannot be supplied with `resume`.

The optional `include` and `mount` arrays pass repeated `--include` and
`--mount` values in order. Each mount value uses the CLI's `SOURCE:TARGET`
syntax. `allowAbsolute={true}` passes `--allow-absolute`. These options belong
to each launch, so a resumed bench supplies the options its new command uses.

Each Terminal hosts one active launch. The bench owns its driver, REPL
process, attached Sidekick, and output capture. Its cleanup joins the child
and drains its output before another bench can use that Terminal. Each launch
starts with a fresh PTY screen. Failure or cancellation retains that launch's
captures. The enclosing test or development Terminal owns the private home.

With `expectExit={true}`, the body triggers a normal exit and `as` binds
`{ exitCode, location, resume }` after PTY output drains. `location` is `null`
when no reopen command is printed. `resume` is an opaque reference available
after a clean exit with a location. Pass it to a later launch in the same
test or development Terminal to reuse the session and home. An explicit Terminal supplies its current
dimensions for both fresh and resumed launches. A standalone bench defaults
to the last size of the resumed launch and otherwise to `160x36`. Each launch
supplies its own contextual cwd. A bench stopped by teardown has null exit
fields.

With `entryPermissionFixture={true}`, the child loads the permission-wheel
fixture provider for the entry to select as `wheel-permission-fixture`. The
fixture answers no live agent requests and presents a synthetic permission
request through the REPL's normal entry permission UI.
