# Handback at ff0e52c6 — 921-P2 corrected, 921-P1 returned as a conflict

One of the two reproduced findings is corrected. The other is the
minimum-layout conflict both reviews anticipated, and it is **returned, not
chosen**: every candidate resolution changes an accepted control, the accepted
composer placement, the seven-row footer or the supported minimum size.

## Revision

- SHA: `ff0e52c643c21ad7dde34908a18a112add6312c7`.
- Parent: `d906c6360533aaf894f5424dd4689aceedf08c3b`, preserved.
- Branch `agent/issue-883-pr2`; signature G, tarasm@gmail.com.
- Worktree `.claude/worktrees/issue-883-pr2`, clean before and after.
- Three files: `packages/cli/src/repl/application.ts`,
  `packages/cli/tests/repl-presentation-style.test.ts`, `architecture.md`.
- Pushed; PR #921 names this head, still draft, still based on
  `agent/issue-883-pr1`.

## 921-P2 — corrected

`sidekickBody` wrapped the right column's body unconditionally, so selecting
Bindings inherited the Sidekick's gutter. A frame showing Bindings now
publishes no inset body at all, which is what makes the measured body width
fall back to the pane's own interior — the fallback `widthsOf`'s `body` lookup
already described for "a frame that draws no Sidekick body".

| Frame | Pane interior | Binding row before | Binding row now |
| --- | --- | --- | --- |
| 160x36 | 97 / 63 | 99 / 59 | **97 / 63** |
| 120x30 | 75 / 45 | 77 / 41 | **75 / 45** |

The row's text was already being fitted to `widths.inspection`, the pane's
width, while its box was built to the inset width, so the box and the text had
stopped agreeing about the room. They agree again.

The narrow profile is unchanged: it reaches `sidekickBody` only when the routed
view is `sidekick`, so the condition is always true there. Headers and footer
are untouched.

Evidence:

- The reviewer's probe, unchanged, now passes:
  `deno task test .reviewer/issue-883/pr921-bindings-padding-probe-d906c636.test.ts`
  → `1 passed (2 steps)`.
- **PW1 encoded the mistake** by expecting the inset body under both tabs. It
  now states both accepted layouts from the accepted table — `bindings` the
  pane interior, `sidekick` that interior inset two cells each side — and
  measures a real binding row under Bindings while keeping every outer-width,
  disjointness, header-edge and footer claim for both tabs.
- Adapting it needed one fixture mechanic: **the PW tier never installed
  `useTempFileCompiler`**, so its fixture entry's eval block refused and the
  Bindings pane had nothing in it to measure. The tier now installs it. That
  is why the row could not previously have observed this regression at all.
- Break-it control: reintroducing the unconditional wrapper fails PW1 with the
  inset body published under Bindings at `{x: 99, width: 59}` against the
  expected `undefined`. Restored, it passes.

`specs/repl-spec.md` already said "Bindings keeps its own layout", so the spec
needed no change — the implementation was the thing that disagreed with it.
`architecture.md` now also states that the inset body is published only for
that one reading.

## 921-P1 — returned as a concrete product conflict

**Not fixed, and not papered over.** `Math.max(1, capacity)` is still there;
removing it alone makes the composer zero value rows tall, which is worse, and
nothing else in implementation can create the row.

The reviewer's probe, unchanged, still fails as it should:
`deno task test .reviewer/issue-883/pr921-narrow-question-capacity-probe-d906c636.test.ts`
→ `0 passed (1 step) | 1 failed`, chat viewport `{x: 2, y: 4, width: 68, height: 0}`.

### The exact row budget at 72x20

From that probe's committed frame. `FOOTER_ROWS` is 7, rows 13–19. The body is
rows 1–12, which is **twelve rows**, and the pending arm's fixed rows are
exactly twelve:

| Row | What holds it |
| --- | --- |
| 1 | `Sessions` |
| 2 | `* Entries` |
| 3 | `[↑ earlier]` |
| — | **chat viewport: height 0** |
| 4 | `[↓ later]` |
| 5 | `[Back to current chat]` |
| 6 | `[configure scribe]` |
| 7 | `scribe has a question.` |
| 8 | `[answer sidekick]` |
| 9 | `>> Message Sidekick:` — the composer's label |
| 10 | `next question` — its one value row, the minimum |
| 11 | `scribe is working...` |
| 12 | `[stop]` |

The no-question control is the same twelve less rows 7 and 8, and its chat
viewport is height 2. Twelve minus ten is two: the arithmetic closes, and the
question costs exactly the two rows that were the chat.

### Why this is a conflict and not an implementation choice

To leave the chat one row, exactly one of those twelve must go. Each one is
something already accepted:

1. **Drop the composer's label row at this size.** It is the row this
   increment added, and it is the single row that would restore the chat. But
   label-above-value is the released composer placement, settled so the name
   stays visible during internal scrolling.
2. **Drop `[↑ earlier]` / `[↓ later]` when the chat has no rows.** Both reviews
   forbid removing required controls, and the review notes they are currently
   "both drawn, with no message between them".
3. **Fold the question announcement and its opener into one row.** That changes
   an accepted announcement.
4. **Raise the supported minimum for a current chat with a pending question.**
   Explicitly out of bounds without a settled product decision.
5. **Reduce the seven-row footer here.** Accepted and unchanged throughout.

The released composer addendum says: "Normal drawable states must leave C at
least one. If they cannot, return a concrete layout conflict rather than hiding
controls or changing the minimum drawable profile." The Architect's correction
says the same: "If a correction requires changing the accepted controls or
minimum drawable size, return the concrete product conflict rather than
choosing that change in implementation."

It cannot, so it is returned. **No candidate above is recommended or begun.**
Once one is settled I will implement it and add the representative
current-selector/question case to the small-screen composer evidence, as both
reviews ask.

## Commands at this head

| Selection | Result |
| --- | --- |
| 1 — Sidekick presentation/journey/lifecycle, style | 51 tests / 171 steps, 0 failed |
| 2 — configuration, controls, forms | 24 / 132, 0 failed |
| 3 — ordinary journey, agent interface, execution, lifecycle, layout, source | 73 / 225, 0 failed |

`deno task check` exits 0. Reviewer probes at this head: Bindings passes,
narrow-question fails as the returned conflict.

No dependency, cache, lock or discovery change. No assertion weakened: PW1
gained claims and kept all of its own. No full suite, broad lint/JSR, CI
inspection or capture. The teaching walkthrough, 36-frame packet and delivery
remain separate.

## Continuity

Base: reviewed `d906c636`. Produced: `ff0e52c6` correcting 921-P2, and this
handback returning 921-P1. Next action: the Planner or Product Owner settles
which row the narrow pending-question frame gives up. Prior acceptances stay
closed.
