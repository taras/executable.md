# Keep the guidance visible above route drawers

**Completed: [PASS at 27da762b](pr921-ui-headers-planner-review-27da762b.md),
2026-10-16.** UH5 and the original header criteria pass independently. This
amendment remains the accepted contract; its continuation instructions are
historical and assign no further header work.

Continue the header cleanup with one blank row above the three shared-column
headers. When a route drawer opens, the whole contextual guidance block remains
visible above it, including how to close it. A smaller reading window is still
fully readable by scrolling.

**Planner disposition: P = 1 is recorded for this continuation. Implementation
may continue under the amended contract below.** Preserve the current worktree
and its patch; do not restart the increment or recover a clean checkout over it.
HEAD/base remains 7613cddf4f8478b905d6a56d67fb0aa9a2588d25 on
agent/issue-883-pr2-main-integration in .claude/worktrees/issue-883-pr2.

## Why the original plan changes

The [Implementor return](pr921-ui-headers-implementor-conflict-7613cddf.md)
preserves command 3's five failures and the P=0 isolation run. Commands 1 and 2
are green; the horizontal tabs and removed title/word are not the conflict.

The original plan held drawer geometry fixed while adding a top row. That
combination lets the History layer cover the contextual guidance the screen is
required to show. The whole guidance is fitted into multiple rows in
prepareFrame; protecting only its first row would still hide a required part.
This is an existing guidance contract, not permission to weaken UI1/UI15.

One arithmetic correction to the return: adding P to drawerTop is not sufficient
at medium. With body=23, the old top is 2; plus P=1 is 3, which is still the
reported first guidance row. The continuation therefore protects the actual
whole fitted block rather than inferring that a one-row translation solves it.

The medium collision is supported by the source arithmetic. The attempted
120x30 extension of UI1 failed earlier on a width-specific text assertion, so
this ruling does not describe that attempt as a successful runtime reproducer
of the medium occlusion. The new focused evidence below establishes it directly.

## Amended layout contract

This supersedes the original header plan's unchanged-rectangle requirement
**only for route drawers in wide and medium shared-column frames**:

1. Keep the guidance block in its existing transcript/located position and
   preserve its full words, order and current fitting. Do not move it into the
   footer, shorten it, drop Esc closes, or display a second copy.
2. Keep the original route drawer's horizontal bounds and original bottom
   boundary. The seven-row footer remains unchanged and uncovered.
3. Its new top is the later of the old top plus P and the bottom of this frame's
   whole measured guidance block. With half-open bounds, a drawer beginning at
   that bottom does not cover any guidance row. Its height is the retained
   bottom boundary minus that new top, so moving down spends drawer-window
   capacity rather than extending the drawer into the footer.
4. Obtain the guidance extent from the actual fitted rows and engine measurement.
   Do not assume a fixed number of guidance rows, compute cuts with character
   counts, hardcode y=4, or guess the 120x30 case from the wide frame.
5. Carry the resulting detached rectangle through the existing frame preparation
   and presentation context. Measurement, drawer window admission, drawing and
   pointer targets all use that same rectangle. Recompute it for the current
   size/focus/state; do not retain a second geometry store or mutate route state.
   Private context fields and argument threading are ordinary implementation
   mechanics. There is no new public testing or layout API.
6. A bounded measurement after the fitted guidance is available may settle the
   drawer envelope before its window is admitted. No convergence loop or paint-
   then-correct behavior. Preserve the existing separation between measuring
   and drawing engines and retained fitting of unchanged chat lines.

Apply the same envelope rule to route drawers sharing that layer, rather than
making History's targets obey a different rectangle from its peers. The narrow
outlet keeps its current drawer rule; it gains no top padding. Sidekick's
pane-local question and Configure rectangles stay unchanged. Existing modal
precedence, focus containment and close actions also stay unchanged.

The permitted production boundary expands from application.ts/layout.ts to
program.ts's existing frame preparation if needed to carry measured geometry.
No renderer validator, engine/vendor code, tree or input protocol change.

## The journey adaptations are permitted

The two J1 rows may scroll the actual transcript reading window to reach
Decision: approve after the drawer/form is closed. Preserve their assertions
about exact retained output, location-based reconstruction, selection, provider
inactivity and both composers. They are not required to show the last output
row without scrolling after the requested gap reduces capacity.

Do not change the expected output to a truncated substring or merely read it
from history instead of reaching it on screen. Use the existing real window
control/input path; scrolling changes only the viewport and writes nothing.

Keep UI1's visible Esc closes and UI15's distinct guidance-above-drawer claim.
Keep J3's existing prefix/turn assertions; the large-frame drawer moves below
the reported row. This amendment does not promise that every background row of
an arbitrary reading remains uncovered by a modal.

If a terminal helper currently derives the drawer's full rectangle from size
alone, that is no longer authoritative for the new shared-column frame. Use
actual committed geometry in presenter assertions. Terminal-only helpers may
identify the drawn top rule within the unchanged horizontal envelope; they must
not locate a drawer by the word History or reproduce the new guidance-fitting
calculation. Reuse existing fixtures and the rendered cells, without a new
production diagnostic hook. Report any helper adaptation explicitly.

## Finite additional evidence: UH5

Retain UH1–UH4. Add one representative guidance/drawer tier, not a new matrix:

- At 160x36, 120x30 and 200x60, open a real History drawer in a committed frame.
  The whole fitted guidance block is visible, including Esc closes, with the
  drawer top at or below its measured bottom. Assert from drawn cells and
  published geometry, not a copy of the new formula. Include a wrapped guidance
  block so protecting only the first row fails the assertion.
- The route drawer retains its previous horizontal bounds and bottom boundary,
  stays above the seven-row footer, and has a positive measured window with
  reachable window controls/Close. Closing actually closes the drawer once and
  preserves both composers and the selected reading.
- Keep UI15's frozen-position History distinction and marker-list assertions.
  Keep the existing narrow and Sidekick-modal controls as the unchanged-rule
  evidence in the assigned selections.

A pure presenter row may establish geometry while a mounted row establishes
actual visibility and close behavior. Do not force the width-specific UI1
literal sentences to apply at 120x30: compare the fitted block's complete
meaning/content across its rows and observe every drawn row is unoccluded.
No new mutation battery, runtime/provider matrix or capture packet.

## Documentation and verification

Record the one-row gap and guidance-protected route drawer envelope in the
affected REPL specification and architecture paragraphs. Describe implemented
behavior after the change, without importing unrelated root-checkout edits.
The existing plan's selected-pane helper adaptations remain authorized; a plain
Bindings label is still not evidence that Bindings is selected.

Rerun all three original header selections after the geometry/test changes:

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

Preserve the existing first outputs and the P=0 isolation log. Do not discard
the five failures by relabeling them as an accepted baseline. After the assigned
evidence passes, promptly create the one signed feedback successor and hand
back exact SHA/parent/tree/signature, results, UH1–UH5 mapping, helper/test
adaptations and any first failure. No full check/lint/JSR/runtime suite or CI
is added as a feedback prerequisite.

## Continuity

Produced: this amendment and the continuation prompt. It releases continuation
of the existing preserved header work at base 7613cddf, with P=1 and the bounded
route-drawer exception above. The reporting Implementor remains the sole writer.
No implementation file or branch was changed by the Planner. History self-
stacking, conversation labels, Task D, EH1/UI10, Parse #922, teaching, captures,
delivery/publication and user-history repair remain separate.
