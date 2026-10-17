# Baseline capture provenance and reproduction

Production revision: `2d719f78025059158a35023701fdff52b855a65b`.
Capture date: 2026-10-08, America/Toronto. Action timestamps are Unix seconds in
actions.jsonl. This is a baseline review, not accepted implementation evidence.

## Production path

The unchanged CLI ran through its real Deno entrypoint, real terminal adapter,
input decoder, mounted tree and TTY renderer. No synthetic HTML recreation or
test-only renderer supplied production screens.

```sh
deno run --allow-all --node-modules-dir=manual --cached-only --frozen \
  --config /Users/tarasmankovski/Repositories/taras/executable.md/deno.json \
  /Users/tarasmankovski/Repositories/taras/executable.md/packages/cli/src/deno.ts \
  repl --default-agent /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-881/fixture-agent.py
```

Working directory: `/private/tmp/xmd-881-reference`. No HOME or data-root override
was used. The command created its own normal host histories. The corrected
journey's history is
`~/Library/Application Support/xmd/repl/4e2daca80ac407f6e4e5af24eee7cd83.jsonl`.
Only that review-created file was copied/read for cold evidence. No other
history was modified or deleted.

The PTY used private tmux socket `/private/tmp/xmd-881-review.sock`, session
`issue881`, pane `issue881:0.0`, with a 256-colour terminal. It was isolated from
all user tmux sessions and is stopped. Normal entry/exit and read-only cold
invocations are recorded; a corrected second cold session verifies returning
live after closing the History modal. Focus containment correctly prevents
activating the background `[live]` action while that modal remains open.

## Scenes and input

The initial invocation supplies empty/draft frames. A fresh corrected invocation
runs Plan/README, JSON, failure and local permission entries. The provider gates
Plan completion and permission arrival on files owned by this review directory.
Its complete protocol traffic is provider.jsonl; it makes no external agent
request. Generated XMD is the declarative program in generated-readme.md.
The README write occurs only in the temporary working directory.

The JSON fixture uses a trusted-root TypeScript evaluation to publish a JSON
value, following the existing real-execution test pattern. The Planner reviewed
that fixture choice. Generated source contains no evaluation block.

capture.py drives bracketed paste/text, Tab/Enter/Escape and actual pointer
input. Pointer coordinates are derived from visible labels. `click-body`
excludes the fixed footer when a checkpoint label also appears in that footer.
Each supported profile is an actual PTY resize: 160×36, 120×30, 72×20.
Resize recovery additionally visits 60×15 and returns to 160×36.

Screen originals are `tmux capture-pane -p -e -N`; captures/*.ansi preserves
screen SGR, and corresponding .txt files remove SGR for inspection. Three
*.stream.ansi files preserve raw output from the point pipe-pane was enabled;
they do not claim to include CLI startup bytes. actions.jsonl records every
capture's actual columns/rows. The authoritative gallery is gallery-manifest.json.
Intermediate screens are in diagnostics/ and are not acceptance scenes.

The leading-whitespace prompt mismatch is in diagnostic-fixture-miss/. The
permission fixture originally used a 180-second capture timeout; the final
fixture removes that timeout for repeatable manual review. Its first request
expired while planning continued; the gallery's permission drawer uses a later
actual request, resolved through Decline. These harness corrections do not
change the captured production revision.

## Cold truth

The production exit location retained the selected failed entry and nonempty
draft. evidence/cold-command.txt records the exact reopen command. Cold viewing
also selected the tokens checkpoint, closed History and returned live.

Before/after signatures are evidence/cold-before.json and cold-after.json:

- Journal: 52,930 bytes, 50 records,
  SHA-256 `1780fb0eb042436fe4e6ac3c8a819ec2f9abfa4a93c1e26cb38efc7538e3782a`.
- Provider log: 13,718 bytes, 37 lines,
  SHA-256 `b8a25932cdaa3c47a45561d83540e0f3060390d838d9cd5eeedc8a6a8e92079c`.

Both files are byte-identical after both cold inspection sessions. No provider
protocol call or retained append occurred. The retained Journal copy is
evidence/retained-journal.jsonl.

## Reference provenance

The original corrected archive was downloaded from #827's attachment and freshly
verified against SHA-256
`86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`.
Its exact bytes are evidence/reference.zip. The relevant original sources were
inspected, including their literal palettes, lifecycle definitions and rail.
evidence/reference-style-extract.txt preserves those source constants.

Six PNGs are copied unchanged from
`.claude/worktrees/repl-parity-slice1/.reviewer/repl-parity-final-c2a173ab/references/`.
That gallery's runbook identifies them as unretouched derivatives of the earlier
#870 reference captures. Its copy is evidence/inherited-reference-runbook.md.
They are inherited reference renders, not fresh browser screenshots, and their
historical scene times are reported provenance. Current production captures
were never reused from that gallery.

The empty, question, settled and Time Travel images are visual analogues for
the expanded production state matrix. Wide reference studies supply medium
comparisons; narrow question/empty studies supply those counterparts. Time
Travel is a wide study even when paired with a narrow production route. The
proposed mapping still needs approval. Reference PNG colours and styles are
not treated as an independent executable oracle; source-derived literal
expectations own the proposed regressions.

## Rendering and inspection

- Deno 2.9.7 stable, aarch64-apple-darwin; V8 15.0.245.2-rusty; TypeScript 6.0.3.
- tmux 3.6a; librsvg/rsvg-convert 2.60.0.
- Raster settings: Menlo 15px, 9×18 cell placement, foreground #c8d2d9,
  background #0b0d0f. Production RGB foreground/background/weight SGR is retained.
- render.py rejects unsupported SGR and rows wider than their reported terminal.
  It creates fixed-cell SVG/PNG screens and reference-above-production pairs.
- Paired reference images are fitted without changing aspect ratio. Browser
  pixel sizes, variable fonts and animation times are not terminal dimensions.

review-sheet-index.json maps all 71 pairs to 18 full-resolution contact sheets.
image-review-log.md records inspection of every sheet and the full key reference
images. Original pair PNGs, ANSI and text remain available from comparison.html.
sha256sums.txt hashes the packet artifacts other than itself.

## Baseline verification

`deno task test packages/cli/tests/repl-presentation-style.test.ts` passes
7 tests / 25 steps; evidence/baseline-style-test.log preserves the output.
This does not establish original-reference parity.

The installed TTY probe is evidence/tty-probe.ts with output in
evidence/tty-probe.jsonl. Both same-element runs and flow children draw contiguous
independently coloured tokens without engine errors. Use the same-element
finding to avoid unnecessary focus/node changes; no dependency was installed.

No baseline break controls were run: #881's discriminating token/rail/lifecycle
tests do not yet exist. Four controls are proposed for the later implementation
revision, with the unmodified positive result and restored negatives recorded.
