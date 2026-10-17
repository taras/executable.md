# Handback at 940249af — Task A complete

Task A is implemented with its A1–A3 evidence. B, C and D are untouched: their
product questions are open, and nothing here chooses one.

## Revision

- SHA: `940249af47159a3bbd960b8ca8df3f10bb53811c`.
- Parent: `ff0e52c643c21ad7dde34908a18a112add6312c7`, preserved, as are all
  ancestors. No reset, rebase or import of unrelated main changes.
- Branch `agent/issue-883-pr2`; signature G, tarasm@gmail.com; worktree clean
  before and after.
- Four files: `packages/cli/src/repl/fitting.ts`,
  `packages/cli/tests/repl-source-reading.test.ts`,
  `packages/cli/tests/repl-presentation-style.test.ts`, `architecture.md`.
- **Not pushed.** This handoff grants no push or GitHub write, so PR #921 still
  names `ff0e52c6`. The commit is here waiting for that authorization.

## What was wrong, and what the fix is

`fitGeometry` flattened every fitted reading row and sent them to the engine in
one render. An engine takes a bounded number of elements and a finished reading
is as long as the entry that produced it, so a long enough entry killed the
command inside `prepareFrame` before any frame existed.

`widths()` now asks in batches of a thousand texts, reads each batch's answers
before the next render invalidates them, and returns one answer per candidate in
the order it was asked for, empty candidates included. The bound is on the
request, not on the document: nothing is truncated, no row or grapheme cut
changes, and the existing refusal, cancellation and unchanged-reading reuse are
untouched. `renderer.ts` is not touched at all, so `UNBALANCED_OPEN_CLOSE` keeps
its classification as a structural refusal.

### One finding worth the Architect's attention

Batching alone was not enough, and the way it failed is the interesting part.
With elements numbered globally across batches, the 4,096-row arm came back
`the engine measured no width for "retained text"` — **index 1023 of the fourth
batch, with the first 1,023 answered**. The measuring instance accumulates state
per *distinct element id* across renders, and it reports no error when it runs
out: it simply returns no bounds. A silently wrong width is worse than a crash.

Each batch therefore reuses the same ids, numbering from zero, which keeps the
distinct set no larger than one batch. This is recorded in `architecture.md`
beside the existing two-engine rules, because it constrains anyone who measures
in more than one pass.

### Measured afterwards

| Rows | Before | After |
| --- | --- | --- |
| 4,000 | prepares | prepares |
| 4,096 | `UNBALANCED_OPEN_CLOSE` | prepares |
| 8,192 / 20,000 / 60,000 | — | all prepare whole |

## Evidence

**A1 — S6 in `repl-source-reading.test.ts`.** The promoted pair, through the
real fitter and a real engine: 900 lines as the control, 5,000 past the old
ceiling. Each asserts every logical line is present, its text exact (blank lines
included), the lines in written order, and each row's runs concatenating to
exactly its own text — not merely an `ok` result. Order is asserted because
returning batched answers out of order is precisely what this change could have
broken.

**A2 — Tier AR in `repl-presentation-style.test.ts`.** The real presenter over a
1,400-line retained entry: the frame commits, the measured reading window has
more rows than one render carries and more than the pane holds, the window moves
with `scroll-reading` against each frame's own admission, the total does not
shrink, the draft survives, and History still opens over the reading and closes
on one `close-drawer`. It builds its entry from the existing `runEntry` and
projector and installs the temp-file compiler in its own `beforeAll`.

**A3 — existing rows.** Command 2 below carries the grapheme, whitespace, status,
reuse, layout-admission and presentation-geometry rows unchanged.

**Break-it controls.** Restoring the unbounded batch fails both new rows and
nothing else: S6's 5,000 arm while its 900 control still passes, and Tier AR with
the exact `UNBALANCED_OPEN_CLOSE` from the report. Both were restored and re-run
green.

## Commands

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr921-large-retained-reading-probe-ff0e52c6.test.ts
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

| Command | Result |
| --- | --- |
| 1 — the released probe, unchanged | exit 0, 1 passed (2 steps); both 4,000 and 4,096 arms green |
| 2 — source reading, layout admission, presentation style | exit 0, 26 passed (106 steps), 0 failed |

`deno task check` exits 0. `deno task lint` adds no warning in either new tier
or in `fitting.ts` — the warnings those files carry are the pre-existing
`no-shadow` ones.

**The raw engine diagnostic is unedited and still fails**, as the handoff
requires: its six smaller batches pass and its deliberate oversized single call
refuses. Bounding the caller did not make an oversized raw engine call valid.

No dependency, cache, lock or discovery change; no assertion weakened; no vendor
patch; no terminal size increased. No push, GitHub write, PR-description edit,
CI inspection or capture.

## B, C and D are untouched

- **B — History self-stacking:** the decoder and dismissal semantics are
  unchanged, as instructed. Tier AR's History arm deliberately opens *once* and
  closes once, so it asserts today's behavior and will not conflict with either
  ruling.
- **C — conversation labels:** `sessionRows()` is unchanged.
- **D — 72x20 question layout:** `Math.max(1, capacity)` is still in place. The
  concrete return in `pr921-implementor-handback-ff0e52c6.md` stands, and the
  recommended one-row announcement is not implemented.

## Continuity

Base: `ff0e52c6`. Produced: `940249af` and this handback. Settled: A's bounded
measurement and A1–A3. Unresolved and unstarted here: B's dismissal policy, C's
label policy, D's narrow-screen amendment. E–H remain separate boundaries.
Next action: review this commit, and authorize the push if PR #921 should show it.
