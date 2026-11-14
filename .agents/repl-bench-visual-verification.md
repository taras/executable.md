# Compare REPL builds with screenshots

Use this guide to run one keyboard journey on two revisions, keep its
screenshots with the requesting REPL session, and show the evidence in a pull
request.

## Applies to

Sidekick responses that coordinate a UI comparison, the entries that run the
bench, and the agent that publishes the PR description.

## Capture the same checkpoint in both builds

Use the task's starting commit as the baseline and the implementation commit
you intend to publish as the candidate. Prepare both worktrees with
`deno task setup`. Run the same journey on the same host with the same viewport,
fixture, launch arguments, and keys. Start each build in a fresh bench run.
Wait for a visible result before capturing a checkpoint. Choose waits that
can complete on either version, then assert the new behavior on the candidate.

The [executable XMD example](repl-bench-visual-check.md) focuses the
Sidekick composer, types an unsent marker, waits for it inside the composer,
and captures the `72×20` viewport. From the root of each prepared worktree,
invoke that checkout's XMD CLI with the same absolute path to the document.

```text
deno run --allow-all --cached-only --frozen --node-modules-dir=none packages/cli/src/deno.ts test --plugin ./scripts/repl-bench-plugin.ts /absolute/path/to/repl-bench-visual-check.md
```

Each run emits JSON with the checkpoint, recorded revision, viewport size,
and screenshot path. ReplBench records the checkout's dirty status in adjacent
`run.json` and saves `screen.txt` and `terminal.ansi` there. Use the pinned
comparison below to verify the revisions and clean state for a PR. To extend
the journey, add a `<Terminal.Screenshot />` after the wait at each checkpoint
and give each capture its own name.

## Submit the comparison from Sidekick

Supply a prepared checkout path and full expected revision for each build.
Use `<Repository>` and `<Worktree>` when selecting or provisioning managed
checkouts. Use their returned paths and record their current HEAD revisions.
Prepare both clean checkouts before running the comparison.

Open the development REPL from the prepared tooling checkout.
Install `rsvg-convert` for PNG capture.

```text
deno run --allow-all --cached-only --frozen --node-modules-dir=none packages/cli/src/deno.ts repl --plugin ./scripts/repl-bench-plugin.ts
```

Replace the example checkout paths and revisions and submit the Sidekick
response. One `<Terminal>` keeps the viewport and one `<Dir>` supplies the
fixture to both launches. Each `<XMD.Build>` selects the implementation for its
nested `<XMD.Repl>`. Follow the receipt's output-reading instruction to get
the two captures. For a feature journey, add more named checkpoints inside
the same pair of launches.

````xmd
<Let as="entry" select="code">
```xmd
<Let as="builds" value={[
  {label: "baseline", checkout: "/absolute/path/to/baseline", revision: "168dd99dc4ac04ecb23c6f3a7419eaa39f808a4b"},
  {label: "candidate", checkout: "/absolute/path/to/candidate", revision: "f1047c25234783c87ee804fc0111a9bb62d97d09"}
]} />
<TempDir>
  <Terminal columns={72} rows={20}>
    <Dir path="fixtures">
      <File path="bench-fixture.md">shared-bench-fixture</File>
      <Each in={builds} let="build">
        <XMD.Build checkout={build.checkout} expectedRevision={build.revision}>
          <XMD.Repl>
            <Terminal.WaitForText text="DRAFT" as="draft" />
            <Terminal.Click at={{row: draft.row + 1, column: draft.column}} />
            <Terminal.Type text={'<File path="bench-fixture.md" />'} />
            <Terminal.Key key="Enter" />
            <Terminal.WaitForText text="shared-bench-fixture" />
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
    </Dir>
  </Terminal>
</TempDir>
```
</Let>
<REPL.EntryInput>{entry}</REPL.EntryInput>
<REPL.Submit />
````

## Keep the captures with the requesting session

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

## Put the reviewed frames in the PR description

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
