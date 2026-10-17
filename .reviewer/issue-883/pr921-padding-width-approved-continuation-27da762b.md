# Finish the padding slice, then deliver the stack

**Completed: [PASS at 6ca23952](pr921-padding-planner-review-6ca23952.md).**
All three selections independently pass 146 tests / 469 steps. No more padding
work is assigned. Next is the separate control-only reply correction from that
exact signed successor, before restack/delivery. This continuation is retained
as the accepted padding contract, not an instruction to replay it.

Follow `.agents/implementor.md`. The Product Owner agrees to include the current
padding/color work in final delivery with a **36-column sidebar at both wide
and medium**. The width decision is closed. Continue the existing work in
`.claude/worktrees/issue-883-pr2` on `agent/issue-883-pr2-main-integration`,
verified HEAD `27da762b7078ee8e32b1dbaf90941c4a8a90eaa7` with the uncommitted
padding/color changes preserved. Do not stash them away for exclusion, reset,
recreate the branch or start a second writer.

## The released continuation

1. Apply the accepted width rule in
   [the width amendment](pr921-body-padding-width-planner-amendment-27da762b.md):
   sidebar 36 at both profiles, two-cell body padding, remaining space split
   equally between Transcript and the right pane, odd cell to Transcript.
2. Keep the completed body insets, Transcript title inset, header-colored top
   rows and pane-colored navigation. Preserve the measured body lookup by id
   and the complete guidance-safe drawer envelope. No shorter vocabulary or
   accepted truncated state; the width change is the resolution.
3. Keep drawer scrollers on their existing surfaces. BP5's six visible controls
   are sufficient in the current fitting-catalog fixture. Both points are
   settled in [the disposition](pr921-padding-colors-planner-disposition-27da762b.md).
   No extra color correction or fixture is required.
4. Complete BP4 at wide and medium, preserve BP1–BP3/BP5, and update the
   independent PW table and directly affected width examples. Coordinate and
   scrolling adaptations retain their existing exact-content/ownership claims.
5. Rerun all three frozen padding selections on the final tree. Preserve the
   earlier failure and isolation logs. Fix any remaining affected failures;
   do not describe an unchanged failing set as passing feedback evidence.
6. Once those commands pass, promptly create one signed feedback successor.
   Return exact SHA/parent/tree/signature, all results, BP1–BP5 mapping and
   adaptations for review of that commit. Do not add new UI scope while waiting.

The accepted width table, in zero-based columns:

| Terminal | Sidebar | Transcript | Right | Right starts at |
| --- | ---: | ---: | ---: | ---: |
| 160x36 | 36 | 62 | 62 | 98 |
| 120x30 | 36 | 42 | 42 | 78 |
| 161x36 | 36 | 63 | 62 | 99 |

Headings/borders retain their full **new** inner-column widths; P=1, footer
seven, composer cap six, actual measured wrapping/scrolling and narrow behavior
remain as specified. This changes outer shares only as the width amendment
states. The wider sidebar preserves the existing longest status and filtered
control at medium as well as wide.

## Focused commands

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

These remain the feedback threshold, with BP4 added to the existing tier.
No new mutation battery, runtime matrix or full-suite prerequisite. Existing
first outputs remain immutable. If a distinct accepted contract still cannot
be met, return that concrete conflict instead of silently changing it.

## Delivery follows this successor

The Product Owner has since assigned
[a separate control-only reply correction](pr921-control-only-replies-implementor-handoff.md).
Finish and review the padding commit first. That correction then gets its own
signed successor and review before restacking; do not mix it into this increment.
Both successors are included in delivery. #928–#931 remain separate.

After the signed UI successor passes review, use
[the updated delivery handoff](pr890-pr921-final-delivery-implementor-handoff-27da762b.md).
Its delivery source is now that successor, including these corrections, rather
than the old 27da762b cut. Preserve all accepted refs. Rebase PR1 first onto
rechecked current main, then carry all PR2 commits through the UI successor onto
PR1. Complete delivery checks, the EH1/UI10 obligation and protected publication
through #890/#921 as that handoff states. No further UI feature is assigned.

Current main was verified at 4702890c when the delivery handoff was prepared;
recheck before restacking. PR1 remains accepted at 85da74b9. History stacking,
conversation labels, the narrow pending-question follow-up, Parse #922,
teaching and captures remain outside this delivery scope.

Produced: this released continuation and the updated width/delivery records.
No product question remains for the padding slice. The same designated
Implementor finishes and hands back its signed successor before restacking;
the Planner has changed no implementation or ref.
