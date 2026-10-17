# Align the Transcript heading and pane navigation surfaces

**Completed: [PASS at 6ca23952](pr921-padding-planner-review-6ca23952.md).**
The title inset, header-colored top space and pane navigation surfaces are
accepted with BP5. No styling correction remains under this addendum.

**Current release: include the corrections in delivery.** The Product Owner
has approved a 36-column sidebar at both profiles. Use the
[approved continuation](pr921-padding-width-approved-continuation-27da762b.md)
to finish the preserved UI work and return one signed successor before
restacking. Earlier park/width-pending instructions below are historical.
Drawer scrollers stay unchanged and BP5's six-control fixture is sufficient.

**Parked by the Product Owner's feature freeze.** The
[final delivery assignment](pr890-pr921-final-delivery-implementor-handoff-27da762b.md)
supersedes this continuation. Preserve its uncommitted work in a recoverable
snapshot; deliver the accepted 27da762b source. The pending product question is
not a delivery blocker and this document authorizes no further UI work during
the restack/delivery assignment.

Follow `.agents/implementor.md`. Preserve the current uncommitted padding work
in `.claude/worktrees/issue-883-pr2`, on `agent/issue-883-pr2-main-integration`
at HEAD `27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`.

This addendum records the Product Owner's further corrections: the Transcript
heading needs horizontal padding; the blank row above Transcript and Sidekick
must match their header backgrounds; and Earlier/Later should read as pane
navigation rather than dark action bars. These corrections are released and may
be implemented in the preserved padding work. The separate sidebar width
choice in the [prepared amendment](pr921-body-padding-width-planner-amendment-27da762b.md)
is still pending. Do not treat this styling release as an answer to it or commit
the combined increment before that conflict is resolved.

## Applies to

The REPL's presentation. No entry source, agent response, journal, provider,
session, route action or input protocol changes. The existing Implementor is
the sole worktree writer.

## Settled corrections

1. In wide/medium, inset the **Transcript title text** two cells from each side
   of its border-free column, aligning it with the Transcript body. Keep the
   header background and bottom rule across the entire inner column. Padding
   the title does not narrow the band. No extra title row, target or focus stop.
   This supersedes the earlier instruction that kept title text flush. The
   existing sidebar heading placement and horizontal tab arrangement otherwise
   stay as assigned.
2. The one blank row above Transcript uses `transcriptHeaderSurface` (`#17212a`);
   the one above the right-pane tabs uses `inspectionHeaderSurface` (`#1b2935`)
   under either tab. Each blank row is visually part of that column's header
   band. Preserve the heading Y, body Y, single border row and overall capacity:
   move ownership of the existing top space, not its size. The sidebar's top
   space retains its existing sidebar surface. No new palette value.
3. Earlier/Later in the Sessions, Entries, Transcript and Sidekick windows
   inherits the background of the pane it navigates. Preserve the existing
   action foreground, focus marker/weight, label, key, target and activation.
   The same role applies when those windows appear in the narrow routed outlet.
   Do not change generic action styling: Send, Stop, Apply, footer actions and
   drawer choices keep their existing surfaces. Do not restyle the History rail.
4. These backgrounds do not depend on focus and do not imply selection. Moving
   focus to or away from a navigation control leaves its pane background intact.
   Existing focus and selection semantics remain independent.

## Source boundary

`application.ts` currently builds `paneTitle()` at the full pane width. The
header band must stay full width while its title child uses the inset width.
Use engine padding and measured geometry, not spaces prefixed to the title or
a second paint-time coordinate calculation.

The top gap currently belongs to the column content's padding, whose inherited
surface is the body. Let the header own that same gap, or use equivalent layout
composition that paints it with the header surface while leaving every existing
vertical coordinate unchanged. A real header box can carry the space without
introducing a described blank row. Do not paint after frame preparation to
correct a wrong background.

`surfaceOf()` in `presentation-style.ts` maps all `action` rows to
`draftSurface`, which is why Earlier/Later has a dark strip. Introduce a semantic
navigation role or an equivalent explicit presentation distinction at the rows
that describe these controls. Keep their existing action foreground and allow
their background to inherit the pane. Do not infer the role from label text or
key prefixes in the renderer, and do not globally remove the action background.

Production scope expands to `presentation-style.ts` alongside the existing
`layout.ts`, `application.ts` and `program.ts` padding scope. No renderer/vendor
or input change. Ordinary private naming and props threading are implementation
choices.

## Finite evidence and adaptations

Extend the existing presenter padding/header tier; no new test matrix:

- At 160x36 and 120x30, assert the Transcript title's text begins at inner X+2
  while its band and border cover the full inner width. The title remains on the
  accepted P=1 row, and has no target.
- Under both right-pane tabs, read cells across the blank top row and assert the
  corresponding existing header color, including cells beyond the label. Keep
  the existing header-row/border/body geometry and seven-row footer checks.
  Update the old test that explicitly expected body color in these two gaps:
  that expectation is superseded. Keep the sidebar's top-surface check.
- With real populated windows, read Earlier/Later background cells in the
  Transcript, Sessions/Entries and Sidekick panes. Assert their pane background
  both with and without focus, while the focused control retains its cue. Keep
  one existing ordinary action as the positive control for its dark surface,
  so changing all actions cannot satisfy this correction.
- The existing mounted window scrolling, tab activation, narrowing/resizing,
  drawer guidance and composer preservation rows remain unchanged except for
  directly superseded color/title-coordinate expectations.

Add these observations as BP5, retaining BP1–BP3 and the prepared BP4 if the
width ruling is selected. Adapt only the directly affected spec/architecture
paragraphs. Run the same three focused commands in the
[padding assignment](pr921-shared-body-padding-planner-handoff-27da762b.md) once
the full continuation is settled. No new mutation battery, full check/suite,
JSR or CI prerequisite.

## Continuity

Base remains 27da762b with uncommitted padding work preserved. Produced: this
released visual correction addendum. The Transcript title inset and header-gap
colors are explicit Product Owner corrections; pane-colored window navigation
is the stated interpretation of the Earlier/Later complaint. The sidebar width
choice remains open and prevents a combined feedback commit. Other queued UI
work, delivery repairs, teaching, captures and publication remain separate.
