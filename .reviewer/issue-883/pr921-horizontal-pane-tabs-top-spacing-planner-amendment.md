# Put the pane tabs beside each other and space the column headings

**Implemented and accepted at 27da762b, 2026-10-16.**
The [review](pr921-ui-headers-planner-review-27da762b.md) closes this amendment
with P=1 and the guidance-protected route drawer. All three focused selections
pass independently. The earlier continuation directions below are completed;
other UI slices remain separate.

The [UI plan](pr921-ui-headers-planner-handoff-7613cddf.md) continues against
accepted replacement PR2 at 7613cddf with P=1 recorded. Preserve its existing
uncommitted work and use the [guidance amendment](pr921-ui-headers-guidance-planner-amendment-7613cddf.md):
route drawers leave the full measured guidance visible, and the two smaller-
window J1 rows may scroll. The [continuation prompt](pr921-ui-headers-continuation-prompt-7613cddf.md)
releases this bounded exception; other pending UI slices stay separate.

The Product Owner requests horizontal Bindings/Sidekick tabs, one occurrence of
each name in the right-panel header, and space between the top of the screen
and the headings of all three columns. Keep this as a
separate UI increment after the active replacement-PR integration, rather than
changing replacement PR1's Core-only assignment.

## Request and working interpretation

Original request: “Bindings/Sidebar should be horizontal tabs and there should
be padding between the heading and top of the page for all 3 vertical sections.”

The follow-up on 2026-10-16 settles the right-panel header: remove the word
“selected” and stop showing Sidekick twice when it is active. The existing
Bindings and Sidekick tabs name the panel once; remove the separate repeated
pane title. Mark the active tab with its visual styling while preserving its
semantic selection and independent focus state. Apply this consistently when
Bindings is active too.

“Sidebar” in the earlier request is understood as Sidekick. Top padding is now
one blank terminal row in each of the left sidebar, Transcript and right-hand
columns, recorded for the released continuation.

```text
|                      |                         |                              |
| Sessions             | Transcript              | Bindings  Sidekick           |
| ...                  | ----------------------- | ---------------------------- |
```

The diagram shows relative arrangement only. Existing column widths, colours,
header edges and body contents retain their governing contracts.

## Current implementation

Read-only inspection of accepted C, d4b0e326, and replacement PR2 at 5a3d32bd:

- application.ts describes tab:bindings and tab:sidekick as independent rows.
  In the wide/medium inspection header each becomes a full-width rowBox, so
  the two tabs are stacked.
- The active tab appends the literal text `[selected]`, and the right column
  also draws its pane title. That repeats Sidekick when it is the active pane.
- Transcript and the right pane use measured header bands. The left sidebar
  starts directly with its Sessions heading and contains an Entries group
  below it.
- Narrow layouts have one routed outlet rather than three columns, and use
  their existing surface controls instead of these two pane tabs.

## Intended bounded change

Place the two existing pane-tab controls in one horizontal header row in the
wide/medium layouts. These tabs also serve as the right column's heading;
remove its separate repeated pane title and the literal `[selected]` suffix.
Preserve each tab's key, action, active styling, question announcement, keyboard
focus and pointer target. Active selection and keyboard focus remain distinct.
Do not combine the tabs into one control or make a label-only imitation of tabs.
This Product Owner amendment supersedes the earlier requirement to retain the
text selection indicator for these two tabs.

Add the chosen top space inside each of the three columns, above its first
heading. Both passes account for it through the actual layout, so viewport
capacity is measured after padding. Do not add a focus stop or selectable blank
row. The lower Entries heading is not the top of another column.

Preserve equal main-pane shares, the Sidekick-only body inset, header edges,
six-line composer, seven-row footer, drawers and route behavior. The request
names the three-column layout; any extension to the narrow outlet must be
explicit rather than silently spending another scarce body row there. The
separate 72x20 pending-question conflict remains open under Task D.

## Evidence for the later assignment

Reuse presentation-style and mounted presentation fixtures. Observe horizontal
tab positions and independent activation by pointer and keyboard, active-tab
styling and the hidden-pane question notice. Under both tabs, the right header
contains one Bindings label and one Sidekick label, with no repeated pane title
or literal `[selected]` text. Scope these counts to the right header, since
messages and the other columns may legitimately name Sidekick. At wide and
medium sizes, all three first headings have the chosen top gap and measured windows fit above the
unchanged footer. Preserve composer/draft text, drawer rectangles and resizing;
the narrow surface controls remain usable.

Expected implementation boundary: application.ts's column/header composition
and layout.ts's measured props, with focused style/presentation tests and
matching REPL/architecture prose. No Core, agent, storage or identity change.
Freeze exact tests and commands against the accepted replacement PR2 SHA when
this increment is released; do not add it to the active Core integration matrix.

## Continuity

Produced: this amendment in the root reviewer packet. No implementation,
branch, integration assignment, specification or saved history changed.
Settled: Bindings/Sidekick are the two horizontal tabs; each name appears once
in the right header, without the word selected or a repeated pane title.
P=1 is recorded. Replacement PR2 integration is accepted at 7613cddf; its header
work is uncommitted and preserved. The continuation is released with the bounded
guidance/drawer amendment and UH5. Next Implementor action: complete that
continuation and return one signed feedback successor with all three selections.
