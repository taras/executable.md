# Clean up the REPL's column headers

**Completed: [PASS at 27da762b](pr921-ui-headers-planner-review-27da762b.md),
2026-10-16.** UH1–UH5 and all three frozen selections pass independently
(143 tests / 464 steps). The assignment below is retained as its acceptance
contract; it does not assign another implementation run. Hold the clean accepted
head for the next separate assignment.

Put Bindings and Sidekick beside each other in the right-panel header, with each
name shown once. Distinguish the active tab visually instead of appending the
word selected. Add space above the headings of the three shared columns.

**Continuation released against accepted replacement PR2
7613cddf4f8478b905d6a56d67fb0aa9a2588d25, with P=1 recorded.** Preserve the
existing uncommitted header work. The
[guidance amendment](pr921-ui-headers-guidance-planner-amendment-7613cddf.md)
supersedes the fixed route-drawer rectangle and no-scroll journey assumptions:
the route drawer keeps the whole measured guidance visible, and the two J1
capacity rows may scroll to their same retained output. Follow the
[continuation prompt](pr921-ui-headers-continuation-prompt-7613cddf.md).
All other scope limits remain. There is no remaining integration correction.

## Applies to

This changes the wide and medium three-column REPL presentation. It applies
while reading either Bindings or Sidekick, including an older read-only chat.
The narrow outlet keeps its existing surface controls and gains no top padding
or shared-column header. Core, providers, sessions, histories and agent behavior
are unchanged.

Read the [accepted UI amendment](pr921-horizontal-pane-tabs-top-spacing-planner-amendment.md)
and the repository's Planner/Implementor instructions. This plan uses committed
implementation/specification files from the PR2 worktree; unrelated root-checkout
edits are not source for the implementation.

## Base and ownership

- Worktree: .claude/worktrees/issue-883-pr2.
- Branch: agent/issue-883-pr2-main-integration.
- Required HEAD/base: 7613cddf4f8478b905d6a56d67fb0aa9a2588d25, signed G.
  The existing header work is now uncommitted in this owner's worktree; preserve it.
- Accepted PR1 remains 85da74b9; original branches and preservation refs remain.
- The session that reported verification of 7613cddf is the designated
  Implementor. The Product Owner confirms the other agent no longer works on
  this assignment, so the earlier writer overlap is resolved. Do not start another
  writer on it. If HEAD or files unexpectedly change, preserve the state and
  return the coordination conflict instead of resetting or rebasing.

No dependency input changes are assigned, so no setup repeat is needed. No push,
GitHub write, CI inspection, merge, history repair or cleanup of another session
is released by the later implementation assignment.

## Settled presentation

The horizontal tab row is itself the right panel's header. Remove the separate
inspection:heading description and its title box in wide/medium frames. Keep
transcript:heading and the sidebar's existing Sessions and Entries headings.
The right header contains one Bindings tab and one Sidekick tab, in that order.
Neither label contains `[selected]`, and no separate Sidekick or Bindings title
repeats the active tab. Scope this requirement to the right header: the chat's
input label and the sidebar's Sidekick section may still name their subject.

Both tabs remain separate real controls, using their existing keys and
select-pane actions. Keep their description/traversal order, independent target
boxes and pointer/keyboard behavior. Changing the arrangement does not select
a tab, move focus or edit either composer. Explicit activation retains its
existing focus behavior.

Retain the existing active/inactive semantic styling and focused-control marker.
Active selection and keyboard focus remain distinct; focus on an inactive tab
does not select it until activated. No new palette or selection phrase is
assigned. Preserve the hidden Sidekick tab's `(question)` notice and the existing
arrival-without-focus-theft behavior.

The shared tab row occupies one text row above the existing single measured
header edge. The band still fills the right column's full inner width. Each
tab's hit box must fit its own label and remain within that column; do not give
both horizontal children the old full-column row width.

P is the recorded one-row top gap. Add P inside each of the
three shared columns, above its first heading/header row. Use actual layout
padding or inert layout space measured in both passes. It creates no node,
focus stop, action or pointer target. The lower Entries heading is not a fourth
column and receives no second top-of-screen gap. The space inherits its column's
existing background; no palette refinement is assigned.

The engine's measured remainder decides viewport capacity after the padding
and shorter right header. Do not compensate with guessed offsets, extra footer
space, rounding, clipping away content or a stored second geometry answer.
Keep current sidebar/main-pane widths, the Sidekick body inset, six-line
composer cap, seven-row footer and header/divider colors. Route drawers follow
the guidance-protected envelope in the continuation amendment; pane-local
question/Configure rectangles keep their existing calculation.

## Current implementation and expected edit boundary

application.ts currently describes inspection:heading, then separate tab rows
whose labels append `[selected]`. presentationFor() puts all three rows in one
vertical headerBand. rowBox() assigns each a full region width, which cannot be
reused unchanged for two horizontal tab children.

layout.ts owns headerRowProps/headerBandProps and column/pane constraints. The
header edge is a real engine row. Keep that ownership when grouping the tabs
and adding top space. Reuse existing box primitives and detached descriptions;
no second tree, focus store, target map or post-render painting.

Expected production edits: application.ts and layout.ts, plus program.ts's frame
preparation for the continuation's measured rectangle. Change style code only
if needed to preserve the existing active/inactive/focus distinction. Align the
affected paragraphs in specs/repl-spec.md and architecture.md with horizontal
tabs, the removed duplicate title/word and chosen top gap. Do not import unrelated
root documentation or rewrite other guides.

## Ordered work and finite evidence

| Row | Required observation | Existing destination |
| --- | --- | --- |
| UH1 — one horizontal header | At 160x36 and 120x30, under both active panes, Bindings and Sidekick occupy the same header row in that order with disjoint in-column target boxes. Each header label occurs once, `[selected]` is absent, inspection:heading is absent from descriptions/mounted keys, and the band/one edge cover the full inner column width. Active style remains distinct and keyboard focus is independently represented. | repl-presentation-style.test.ts; presenter geometry/cells/targets |
| UH2 — real tab controls | Through the mounted program, pointer and keyboard each activate both tabs. The selected body and activation focus change as before, while Draft and Message text survive. The hidden Sidekick's real pending question keeps its notice without changing selection or stealing focus. Use existing mounted/question fixtures, not a second terminal host. | repl-sidekick-presentation.test.ts and existing MQ rows |
| UH3 — top gap and measured room | At the wide and medium profiles, the sidebar's first heading, Transcript heading and right tab row are P rows below the top of their columns. Padded space has no target or Tab stop. A populated reading remains within its measured windows above the unchanged seven-row footer; existing header-edge, composer, chat-following and drawer geometry assertions continue to hold. | repl-presentation-style.test.ts and existing layout/presentation rows |
| UH4 — resize and consumers | Resize wide/medium/narrow and back with both composer values preserved. The narrow outlet keeps its existing surface controls with no new wide-header nodes or top gap. Existing question/Configure form ownership and ordinary entry journeys stay intact. Adapt assertions that formerly used `[selected]` to observe actual selection rather than an always-visible label. | mounted presentation; configuration/lifecycle; agent journey/forms |

One row may establish several observations. Reuse the existing reference colors,
layout bounds, presenter and mounted fixtures. No mutation battery or expanded
agent/runtime matrix is assigned. Preserve first failure output, fix assigned
failures and rerun affected selections before feedback.

The known 72x20 current-chat/pending-question zero-viewport conflict remains
Task D. Do not repair it, increase the minimum, remove its controls or silently
spend top-padding rows in the narrow outlet during this increment.

## Required fixture adaptations

The removed title and selection word intentionally change existing presentation
assertions. Update those claims where this assignment changes them, retaining
their original interaction or geometry purpose. TE4's header-color/edge checks
now observe the shared tab band rather than a deleted inspection title.

The `[selected]` audit at 7613cddf finds references in presentation-style,
Sidekick presentation/configuration/lifecycle and repl-agent-journey tests.
answeredUnder() in the agent journey uses the marker as a pane-selection test.
Adapt that observation too; do not make it skip selecting Bindings merely because
the new tab label exists.

A replacement such as shows("Bindings") is not selection evidence: both labels
are always drawn. Use committed active styling or the selected pane's actual
body/focus through existing fixture data. Await the current frame's evidence,
not text left on the reconstructed screen from a previous pane. Report every
adaptation, including any shared helper changes.

## Focused feedback commands

These selections remain frozen for the released P=1 continuation:

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

No full lint/check/JSR/runtime suite, CI or capture packet is a feedback
prerequisite. EH1/UI10's recorded baseline failures remain a separate repair;
these commands do not claim to run or close them. If an actual change reaches
another known integration consumer, identify and run that affected test rather
than silently broadening or claiming an unrun selection.

After focused evidence passes, promptly return one signed successor with
SHA/parent/tree/signature, exact results, UH1–UH4 mapping, fixture adaptations
and first failures. Preserve 7613cddf and stop for review before publication.
Do not repeatedly stop for permission between the finite rows.

## Continuity

Released artifact: this plan with its guidance continuation amendment. Exact
base: accepted 7613cddf; current uncommitted header work is preserved. Settled:
horizontal separate tabs, one label each, no literal selected suffix or duplicate
right title, existing visual/focus distinction, shared-column-only top spacing.
P=1 is recorded and continuation is released through the guidance amendment,
with UH5 added and the two J1 scrolling adaptations allowed. Other UI decisions,
teaching, captures, delivery and publication remain separate. The same designated
Implementor continues the existing work; no new session is needed.
