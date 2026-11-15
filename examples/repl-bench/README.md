# ReplBench

Use the ReplBench plugin to verify what a person sees in the REPL. Start from
a tooling checkout prepared with `deno task setup`. The bench uses Bun with
PTY support to drive the REPL.

[Visual comparison](#compare-repl-builds-with-screenshots) · [UI handoff](#ui-handoff) · [Tests](#run-the-tests) · [Plugin components](#plugin-components)

## Compare REPL builds with screenshots

Use this guide to run one keyboard journey on two revisions, keep its
screenshots with the requesting REPL session, and show the evidence in a pull
request.

### Capture the same checkpoint in both builds

Use the task's starting commit as the baseline and the implementation commit
you intend to publish as the candidate. Prepare both worktrees with
`deno task setup`. Run the same journey on the same host with the same viewport,
fixture, launch arguments, and keys. Start each build in a fresh bench run.
Wait for a visible result before capturing a checkpoint. Choose waits that
can complete on either version, then assert the new behavior on the candidate.

The [executable XMD example](visual-check.md) focuses the
Sidekick composer, types an unsent marker, waits for it inside the composer,
and captures the `72×20` viewport. Run it from the root of the prepared tooling
checkout to check that the bench can capture that checkpoint.

```text
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts test examples/repl-bench/visual-check.md
```

Each run emits JSON with the checkpoint, recorded revision, viewport size,
and screenshot path. The screenshot sits beside the other
[run evidence](#read-the-evidence). Use the pinned comparison below to verify
the revisions and clean state for a PR. To extend
the journey, add a `<Terminal.Screenshot />` after the wait at each checkpoint
and give each capture its own name.

### Submit the comparison from Sidekick

Supply a prepared checkout path and full expected revision for each build.
Use `<Repository>` and `<Worktree>` when selecting or provisioning managed
checkouts. Use their returned paths and record their current HEAD revisions.
Prepare both clean checkouts before running the comparison.

Open the development REPL from the prepared tooling checkout.
Install `rsvg-convert` for PNG capture.

```text
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts repl --plugin ./examples/repl-bench/plugin.ts
```

Replace the example checkout paths and revisions and submit the Sidekick
response. One `<Terminal>` supplies the same viewport to both launches. Each
`<XMD.Build>` selects the implementation for its nested `<XMD.Repl>`. Follow
the receipt’s output-reading instruction to get both captures. For a journey
that reads fixtures, put the builds inside the same `<Dir>` and create the
fixtures there. Add more named checkpoints inside the same pair of launches.

````xmd
<Let as="entry" select="code">
```xmd
<Let as="builds" value={[
  {label: "baseline", checkout: "/absolute/path/to/baseline", revision: "168dd99dc4ac04ecb23c6f3a7419eaa39f808a4b"},
  {label: "candidate", checkout: "/absolute/path/to/candidate", revision: "f1047c25234783c87ee804fc0111a9bb62d97d09"}
]} />
<Terminal columns={72} rows={20}>
  <Each in={builds} let="build">
    <XMD.Build checkout={build.checkout} expectedRevision={build.revision}>
      <XMD.Repl>
        <Terminal.Focus target="sidekick-composer" />
        <Terminal.Type text="visual-bench-marker;" />
        <Terminal.Region name="sidekick-composer">
          <Terminal.WaitForText text="visual-bench-marker;" />
        </Terminal.Region>
        <XMD.Repl.Revision as="revision" />
        <Terminal.Screenshot name={build.label} format="png" as="screenshot" />
        <Output><Json value={{label: build.label, revision, screenshot}} /></Output>
      </XMD.Repl>
    </XMD.Build>
  </Each>
</Terminal>
```
</Let>
<REPL.EntryInput>{entry}</REPL.EntryInput>
<REPL.Submit />
````

### Keep the captures with the requesting session

Use the PNG screenshot paths returned by the entry. In the requesting
session, request each import as a separate Sidekick response. Replace the
sample source path with the returned path and choose a new comparison name.
The user approves each copy.

```xmd
<REPL.ImportAsset source="/absolute/path/to/tooling/.bench/baseline-run/baseline.png" destination="assets/repl-bench/composer-check/composer/baseline.png" />
```

```xmd
<REPL.ImportAsset source="/absolute/path/to/tooling/.bench/candidate-run/candidate.png" destination="assets/repl-bench/composer-check/composer/candidate.png" />
```

Use the same relative names after reopening the requesting session. The
existing asset import preserves the image bytes. ReplBench's working captures
stay in its own evidence directory. The session copies are the images to use
for review and publication.

Ask Sidekick to inspect both session assets in one response. Paths here
are relative to the session's assets directory.

```xmd
<REPL.InspectImage path="repl-bench/composer-check/composer/baseline.png" />
<REPL.InspectImage path="repl-bench/composer-check/composer/candidate.png" />
```

Sidekick's next turn receives the two images, in that order, when its agent
supports image prompts. For a check of the delivery itself, use a color-only
change with identical visible text apart from the session ID. Ask Sidekick
to identify the difference without giving it the expected colors.

### Put the reviewed frames in the PR description

Use a **Visual verification** section. For each checkpoint the agent inspected,
embed the exact session images it inspected through GitHub attachments and
identify the two revisions, viewport, and input. Include the visual observation
and the keyboard assertion below the pair. Use the attachment URLs GitHub
returns in place of the example placeholders.

This example uses a disposable candidate that changes only the focus color.

```markdown
## Visual verification

### Focused composer · 72×20

Opened Sidekick and typed `visual-bench-marker;` without submitting.

| Before · `BASELINE_SHA` | After · `CANDIDATE_SHA` |
| --- | --- |
| ![Baseline focused composer](BASELINE_ATTACHMENT_URL) | ![Candidate focused composer](CANDIDATE_ATTACHMENT_URL) |

The candidate shows a pink focus marker where the baseline shows cyan.
Both composers display the same unsent marker.
```

Use GitHub's attachment picker or `gh pr create --attach` / `gh pr edit --attach`
when your installed CLI offers that flag. View the submitted description and
check that each image opens for a reviewer. Rerun affected checkpoints after a
change to the candidate commit and replace their candidate images and findings
together. Keep the reviewed images in the session.

## UI handoff

Give the verifier the absolute worktree, exact revision, starting arguments,
and terminal size. Include the preflight command, the ordered feature actions,
the visible result of each action, and the evidence to return. Use sizes
`160x36`, `120x30`, and `72x20` to exercise the corresponding layouts in the
[REPL specification](../../specs/repl-spec.md).

Run the [preflight journey](journeys/preflight.test.md) from the root of the
prepared worktree:

```text
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts test examples/repl-bench/journeys/preflight.test.md
```

Preflight exercises the Sidekick composer at `160x36` and `72x20`. It types
and clears an unsent marker, checks for exit `0`, and prints the viewport and
reopen location. Return those values with the exact revision, feature steps,
and observed results. Use the [visual comparison](#compare-repl-builds-with-screenshots) to
capture before-and-after evidence. Link to `run.json`, `screen.txt`, and
`terminal.ansi` beside each screenshot.

## Read the evidence

Each launch saves its viewport and terminal output in the tooling checkout’s
`.bench/<run>/`. The readable screen is `screen.txt` and the raw PTY output is
`terminal.ansi`. The launch record in `run.json` includes its ID, revision,
dirty status, working directory, and dimensions. Failed launches keep their
available evidence. `Terminal.Screenshot` saves the visible viewport and
binds its path. Use separate names for the checkpoints you compare.

## Run the tests

```sh
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts test examples/repl-bench/journeys
```

Run one document by passing its `*.test.md` path. Both forms use the plugin
declared in `examples/repl-bench/xmd.json`. Run from the worktree root so the
scripted scenarios resolve there. The [isolation journey](journeys/isolation.test.md)
verifies that one failure leaves the other terminal usable.

Run the [TypeScript tests](tests) to check composer recognition and verify
that the REPL and scripted Sidekick exit after the intentional failures in
[`timeout-controls.md`](journeys/timeout-controls.md).

```text
deno test --allow-all --cached-only --frozen --node-modules-dir=none examples/repl-bench/tests
```

Use a composer region for a field-value
check. A viewport match can also find the same text in the Draft or Transcript.
Use `<Terminal.Screenshot name="narrow-sidekick" as="image" />` inside an active
bench to save the visible viewport and bind the image path.

The required macOS and Linux bench jobs run from a checkout whose path
contains spaces. Their failure artifacts include saved screenshots.

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
| `XMD.Build` | `checkout` selects a prepared source checkout for nested launches. Relative paths resolve from this element’s contextual directory. `expectedRevision` takes a full commit ID. A pinned launch verifies the worktree root, preparation, revision, and clean state before launch and after the child stops. Untracked files count as changes. Evidence goes to the tooling checkout. |
| `XMD.Repl` | A paired invocation runs its body once after the REPL is usable. The child starts in the invocation's contextual cwd and uses the nearest Terminal's current dimensions. Without an enclosing `XMD.Build`, it uses the current XMD host's command. A standalone bench supplies its own Terminal, with optional `columns` and `rows`. |
| `XMD.Repl.Revision` | `as` binds the observed commit, or null when the launch uses the current XMD host’s command. |
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

For builds with numbered focus shortcuts, use the component for the region
that should receive the next input. For example, use `<Repl.Focus.Draft />`
before typing an entry. Each component sends the corresponding shortcut and
follows the [REPL focus rules](../../specs/repl-spec.md#move-between-regions-and-edit-within-them).

| Region | Component |
| --- | --- |
| Sidekick Message | `<Repl.Focus.Message />` |
| Transcript | `<Repl.Focus.Transcript />` |
| Selected work | `<Repl.Focus.SelectedWork />` |
| Draft | `<Repl.Focus.Draft />` |
| Tabs/Configure | `<Repl.Focus.Tabs />` |
| Right reading | `<Repl.Focus.RightReading />` |
| TODO | `<Repl.Focus.Todo />` |
| History | `<Repl.Focus.History />` |
| Narrow surface bar | `<Repl.Focus.SurfaceBar />` |

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
test or development Terminal to reuse the session and home. An explicit
Terminal supplies its current dimensions for both fresh and resumed launches. A standalone bench defaults
to the last size of the resumed launch and otherwise to `160x36`. Each launch
supplies its own contextual cwd. A bench stopped by teardown has null exit
fields.

With `entryPermissionFixture={true}`, the child loads the permission-wheel
fixture provider for the entry to select as `wheel-permission-fixture`. The
fixture answers no live agent requests and presents a synthetic permission
request through the REPL's normal entry permission UI.
