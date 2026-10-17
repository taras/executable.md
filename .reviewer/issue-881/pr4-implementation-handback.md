# REPL typing and focus responsiveness — implementation handback

**Revision `6f5f150a`** (evidence corrections R1 and R2), superseding
`06080c640d5cae1fe96c355045177a462dcc040a`. Branch
`agent/issue-881-pr4`, worktree `.claude/worktrees/issue-881-pr4`, based on
`05ba70d567cb80be4bfdea67e7ae0267376e2376` (#881 PR 3, accepted). One signed
commit; `git status --porcelain` is empty. PR #887 and the rest of the stack
are untouched. Nothing pushed, no PR opened.

## What is reused, and what invalidates it

**Reading geometry.** `prepareReading` is split in two. `fitGeometry` performs
every engine render and answers where each logical line is cut and how wide
each piece measured; `decorate` builds the rows from the lines as they stand
now. A `ReplFitStore` created in `runReplProgram`'s own scope holds the last
geometry together with the inputs it came from, and is threaded into
`prepareFrame` and `commitReplFrame` as an optional parameter, so the test
fixtures that prepare a frame keep measuring everything.

Reused when the `(text, depth)` sequence of the lines, the available room and
the terminal size are all unchanged. Invalidated by any of: a line's text, a
line's depth, the line count or order, the room, the terminal size. Inputs are
compared element-wise rather than digested.

**Not** part of the geometry, and therefore re-derived every frame: rails,
badges, token roles, selection and `inspected`. A phase settling or a position
being inspected shows immediately over cuts measured once — which is what
keeps live lifecycle and head state fresh without a Journal append.

**Measurement before an action.** `act()` prepared a whole frame before every
dispatched action and read one field of it. The reducer reads that admission
in four branches only, so `readsGeometry` — exported beside `reduceRepl`,
where a fifth reader would be written — now gates the preparation. Typing and
erasing skip the `build()`, the `screen.size()` read and the whole
`prepareFrame`.

**Focus.** A traversal already moved focus in the tree before the loop looked.
`act()` now settles `focused` when the dispatch outcome is a focus move, so
the one frame is composed with the focus that is actually held. The
post-commit correction remains as the safety net, and startup's unconditional
second paint became the same question.

## Before and after

Two boundaries, labelled as such. The first review was right that the original
table measured only one of them.

**Complete frames**, the production commit path — measure, admit, reconcile,
draw — with the **parent revision as the baseline**, both runs from
`pr4-evidence/frame-measure-*.ts` against their own worktrees:

| Selected reading | `05ba70d5` first frame | `05ba70d5` after a keystroke | `6f5f150a` first frame | `6f5f150a` after a keystroke |
| --- | ---: | ---: | ---: | ---: |
| 12-line entry | 127 measures | **127** | 127 measures | **5** |
| 222-line entry | 2247 measures | **2247** | 2247 measures | **5** |

Five is the fixed cost a complete frame always pays — three structural
measuring passes, the rail, and the drawer preview when one is open. It is the
same number for twelve lines and for two hundred and twenty-two, which is the
property RS2 asserts.

**Source fitting alone**, `prepareReading` called directly, the same build with
and without a store (`pr4-evidence/measurements.txt`). Counts are per
keystroke after warmup and every fit is checked before it is counted or timed:

| Reading | Size | Without a store | With one |
| --- | --- | ---: | ---: |
| 1-line entry | 160×36 | 15.0 measures, 0.83 ms | **0, 0.03 ms** |
| 12-line entry | 160×36 | 119.0 measures, 3.71 ms | **0, 0.19 ms** |
| 12-line entry | 72×20 | 128.0 measures, 1.67 ms | **0, 0.06 ms** |
| 222-line entry | 160×36 | 2265.0 measures, 59.69 ms | **0, 1.14 ms** |
| 222-line entry | 72×20 | 2524.0 measures, 29.44 ms | **0, 0.97 ms** |

Through the real command, `pr4-evidence/walk.py` at both sizes with a
200-component entry selected, input-to-present timed from outside by piping
the pane — so it includes the tmux round trip and the frame cadence:

```
160x36  draft keystroke  n=14  median 19.1 ms  worst 26.9 ms
160x36  focus traversal  n=8   median 17.7 ms  worst 21.2 ms
 72x20  draft keystroke  n=14  median 19.9 ms  worst 27.6 ms
 72x20  focus traversal  n=8   median 17.0 ms  worst 22.0 ms
```

## Focused commands and results

```
deno task test packages/cli/tests/repl-source-reading.test.ts \
  packages/cli/tests/repl-presentation-style.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts \
  packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-forms.test.ts
→ ok | 52 passed (218 steps) | 0 failed

deno task test packages/cli/tests/repl-journey.test.ts \
  packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-terminal.test.ts
→ ok | 56 passed (146 steps) | 0 failed

deno task test --changed
→ ok | 140 passed (565 steps) | 0 failed

git diff --check   → exit 0
oxlint packages/cli/src/repl packages/cli/tests → 7 errors, all pre-existing in
  repl-lifecycle.test.ts; none in any file this change touches
```

New test files: none — the regressions join existing suites, so they are
already in all three runtime jobs. Checked anyway, because the counting
renderer is new: `repl-source-reading.test.ts` passes under Node (36 tests)
and Bun (36 pass, 0 fail), and `repl-entries.test.ts` under Node (66 pass).

What each regression proves:

- **RS2** (`repl-presentation-style.test.ts`) — *integrated, complete frame.*
  Two commits through `commitReplFrame` against one real tree and engine pair,
  differing only in the draft. The second costs the same for a 12-line and a
  222-line reading, that cost is above zero (it is a whole frame, not the
  fitter alone), and it is under a tenth of what the first frame paid. This is
  the assertion that fails when production stops threading the store.
- **RS3** (`repl-journey.test.ts`) — *integrated, through the real loop.*
  Typing, erasing, Tab and Backtab beside a selected 12-line and 222-line
  entry each read the terminal size exactly four times: the too-small check,
  the resolution, the frame's measurement and its revalidation. A fifth read
  is an action answered with a frame measured before it ran. This is the
  assertion that fails when the gate is bypassed at its call site.
- **S5** (`repl-source-reading.test.ts`) — *isolated fitter.* A 222-line
  reading costs >100 measures once and **0** for the next three frames, with
  freshly built line objects each time; a phase arriving measures nothing and
  still draws the new badge. Four invalidation cases move **one input each**,
  with the exact inputs warmed immediately before: depth alone, room alone,
  terminal size alone, one line's text alone. Each asserts that measurement
  happened *and* that the result equals a freshly measured fit — rows, widths
  and recovered text — and, where the input changes the shape, that it differs
  from the warmed one.
- **EU2** (`repl-entries.test.ts`) — all 24 action kinds reduced with and
  without a real admission; anything whose answer differs must be a geometry
  action, at least one does, and `type` and `erase` specifically do not read
  geometry.
- **RS1** (`repl-journey.test.ts`) — Tab and Backtab move the cue and the
  focus and present exactly one frame each.

## The mutation controls

`pr4-evidence/.controls.py` against the committed worktree; each restored and
SHA-verified, complete output per control in `.controls-output/`. The runner
requires a control to break **the test it names**, so a suite failing for an
unrelated reason cannot make a mutation look effective.

| Control | Outcome | First failing step |
| --- | --- | --- |
| `KR1-no-reuse` — the store is never consulted | BROKEN | `measures nothing again when only the draft beside it moved` |
| `KR2-measure-everything` — the gate answers yes for a keystroke | BROKEN | `answers every other action identically with and without an admission` |
| `KR3-focus-lags` — focus settles after the paint again | BROKEN | `RS1: Tab moves the cue and the focus, and presents once` |
| `KR4-gate-bypassed` — the gate's own call site always prepares | BROKEN | `RS3: … read the size a fixed number of times` |
| `KR5-store-not-threaded` — `prepareFrame` stops passing the store | BROKEN | `RS2: costs the same whether the selected reading is short or long` |
| `KR6-depth-ignored` — the depth comparison is dropped | BROKEN | `measures again when only the depth changed, and cuts for the new depth` |
| `KR7-size-ignored` — the size comparison is dropped | BROKEN | `measures again when only the terminal size changed` |

KR5 is the one that shows the integrated regression reaches something the
isolated one cannot: with the store unthreaded it fails RS2 while S5's direct
fitter tests still pass (`15 passed (83 steps) | 1 failed`).

## The removed read, and J2's adjusted premise

Gating `act()` removes one `screen.size()` read per non-geometry action. That
shifted `J2: a window dragged while a frame is being prepared keeps the
command`, which arms its drag on an absolute read count.

Confirmed from the call sequence rather than from the test going green. With
the five size-read sites in `program.ts` instrumented, one keystroke now
reads:

```
too-small-check → drawnAt → measurement → revalidation
```

`SIZE act` no longer appears, which is the removed read. The **third** read is
the one the frame is measured against, so a drag armed there answers it with
the old size and leaves the new one for the revalidation to find — the same
boundary the row describes. It was the fourth while every action also measured
a frame before reducing.

Changed in the test: the constant `4` → `3` and its comment, which now states
which read that is and why. **Every assertion is untouched**; the diff for that
file is one constant, the comment, and the new RS1 case.

## Remaining measured cost

The engine work for an unchanged reading is zero, but a keystroke beside a
222-line entry still costs ~1.1 ms, and that part does grow with the entry:
`readingLines(readingOf(view))` rebuilds the whole reading tree every frame,
and `decorate` builds a row object per visual row. Neither touches the engine.

I did not cache either, per requirement 4: the measurements do not justify it
at 1.1 ms, and the reading tree is where live phases come from, so retaining
it is a different and riskier invalidation problem than retaining geometry.
The History rail was left alone for the same reason — `prepareRail` is one
batched render and did not appear in the remaining cost.

Nothing pushed. No PR opened or updated. Delivery verification remains separate.
