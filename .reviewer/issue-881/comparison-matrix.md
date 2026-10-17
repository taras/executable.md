# Proposed finite comparison matrix

**Superseded for implementation acceptance** by
[final-gallery-matrix.md](final-gallery-matrix.md), frozen with the PR 2 and PR 3
implementation handoffs. This earlier proposal remains a planning history record.

**Complete-story proposal; not frozen.** PR 1 instead uses the approved,
self-contained [handoff](pr1-handoff.md) and its
[35-pair subset](pr1-gallery-manifest.json). This matrix gives the Architect and Product Owner a
concrete review target. It preserves #881's outcome and the current product.
The Architect refines product verification before the Planner freezes these
scenarios and their lower-level evidence.

All numbered scenes use 160×36, 120×30 and 72×20. At narrow, the scene shows its
existing routed outlet and admitted drawer; absent transcript/bindings panes are
absent from descriptions, focus traversal, frame targets and pointer maps.
Reference frames are visual analogues; no identical pixel geometry is claimed.

| ID | Production scene and action | Original reference comparison | Recognition required | Incomplete implementation caught |
| --- | --- | --- | --- | --- |
| M1 | Empty REPL, then multiline Evaluate/Plan draft | Agent Sessions empty; TUI input | Headings, pane surfaces/edges, ready guidance, single-row persistent draft and reachable History | Styling only the submitted transcript |
| M2 | Submit Evaluate/Plan; hold the scripted Agent turn before completion; show Sessions | Time Travel nested Plan; Agent Sessions progress | Known source token colours, nested source rails, full lifecycle glyph/word in the shared right-aligned status column and streaming turn hierarchy | One coloured summary, or every imported component labelled active |
| M3 | Plan review waits; explicitly activate Answer, inspect source, reach decision controls | Question/preview hierarchy; Time Travel XMD | Tokenized source, grouped read-only preview and choices, explicit activation | A working but undifferentiated form; automatic opening |
| M4 | Approve Plan; generated fragment admitted; inspect the generating source position | Time Travel generated replacement in original JSX | Admitted XMD replaces paired Evaluate's inner producer content; Evaluate's enclosure remains visible; source and rendered output remain distinct | Source appended as unrelated output or muted event metadata |
| M5 | Open project details; submit empty values; enter Northstar and its description; review README | Agent Sessions question and confirmation | Label/hint/value/validation hierarchy, input focus and choices; preview remains readable through window controls | Decorative fields that hide validation or cannot reach decisions |
| M6 | Approve README; inspect settled entry; submit a separate failing entry | Agent Sessions settled; original lifecycle glyph definitions | Entry Output precedes Source; actual rendered result and identifying success/failure words/glyphs, with subordinate metadata | Green/red alone, wrong output ownership, or settled output buried under effect chatter |
| M7 | Submit JSON fixture; select tokens; activate the binding inspector; move keyboard focus away from selection | Time Travel bindings and selected reading | JSON token roles; selection persists independently; focus does not flatten syntax colours | Importing the production palette into expected assertions; focus overwriting all roles |
| M8 | Agent permission waits in Sessions; activate the pending request; inspect choices and duration; Decline | Original Agent Sessions surface and drawer hierarchy | Waiting turn, provider option labels, duration and explicit activation; recorded request later has no live authority | Automatically opened drawer; historically actionable request |
| M9 | Pause the real expansion; inspect an earlier checkpoint; close History; return live | Time Travel and Journal Scrubber rail studies | Accepted five-row ordinal rail, entry/minor hierarchy, grouped marks with exact drawer selection, distinct head/selection, truthful expansion-paused/settling/settled wording, prefix-only inspected panes | A label list; one marker used for both head and selection; future binding/output leakage |
| M10 | Cold-open the settled exit location and navigate retained content | Settled and historical reference analogues | Same retained styling/content and persistent URL draft; provider log and Journal bytes unchanged | Reconstructing the view by executing the document or materializing a provider |

M4's paired replacement behavior is accepted in
[pr2-source-presentation.md](pr2-source-presentation.md); its full visual evidence
is not frozen. The [PR 2 main verification journey](pr2-product-verification.md)
and all five presentation decisions are accepted. Canonical static source
inspection is accepted, and pr2-planner-handoff.md is ready for the Planner.
M9's interface and presentation contracts are accepted in
[pr3-history-contract.md](pr3-history-contract.md). Its proposed
[verification journey](pr3-product-verification.md) is accepted. The ready
[PR 3 handoff](pr3-planner-handoff.md) carries the contracts before the Planner
freezes complete-story evidence. Terminal adaptations cannot
silently reduce the lifecycle or generated-source acceptance.

## One resize journey

Use a pending permission drawer with the unsubmitted draft
`<Json value="next" />`. Move through 160×36 → 120×30 → 72×20 → 60×15 → 160×36.
Record normalized input, actual sizes and original ANSI. Observe the fixed
action row, five History rows and draft row; drawer placement remains above
them. The undersized screen shows the refusal and returns to the same route,
selection, focus target and exact draft when enlarged. A separate form journey
already exercises the same supported-size sequence with edited field values.

This is one representative geometry boundary, not a new exhaustive size grid.

## Reference-derived style evidence

Use literal expected values derived from the verified archive, with file/hash
provenance. A test must not import REPL_PALETTE or the implementation's role map
to decide which colour should appear. Sample committed cells in the actual
frame's rectangles, and assert characters and attributes together.

| Content role | Reference colour |
| --- | --- |
| XMD delimiters | #4e8b9c |
| Tags | #7fd3e8 |
| Attributes / JSON keys | #8fa7b8 |
| XMD strings | #d6b477 |
| Reference braces / booleans | #9b8ed0 |
| References | #b7aee0 |
| Numbers | #d69a6a |
| Prose | #c8d2d9 |
| Punctuation | #7c868d |
| JSON strings | #9ec49a |
| JSON null | #8b959c |

Lifecycle expectations come from the original L map: ▶ ENTER #5aa87c,
● ACTIVE #7fd3e8, ● WAITING #c99a3f, ◀ EXIT #c2766e,
✓ SETTLED #4f8468, × FAILED #d24b3f. Middleware observes the complete live
invocation and actual pending waits; the session owns the live snapshot. The
Journal supplies retained history separately. The complete-invocation seam and
outcome details are accepted in pr2-invocation-contract.md; import resolution alone
cannot end the live occurrence.

The source-role fixture covers one representative tag with attribute/string,
reference, ordinary prose, escaped text and an incomplete draft. Concatenating
runs reproduces the original source exactly. The JSON fixture covers keys,
escaped strings, number, boolean, null and punctuation. A nested execution
fixture includes a generated fragment and two siblings so guessed attribution
cannot pass unnoticed. Lifecycle evidence covers a body held after import
resolution, overlapping waits, failure/cancellation and slow or failed teardown.
Observe the same run with and without middleware to verify unchanged execution
outcomes and Journal bytes. During inspection, live observations advance only
offscreen; the historical panes stay prefix-only, and returning live uses the
latest snapshot. Cold history cannot manufacture ACTIVE/WAITING from admissions.

## Four independent visual break controls

After an unmodified feedback revision passes, apply each control alone in an
isolated checkout, capture its first failure, restore the exact revision and
verify restoration before the next control. Never mutate the shared prepared
worktree's dependencies or generated files.

1. Collapse token roles to ordinary source colour: the XMD/JSON committed-cell
   assertions fail at their named token positions.
2. Remove nesting rails/indentation: the nested-source geometry assertions fail,
   even though the document still runs.
3. Remove lifecycle glyphs/words: the state-specific frame assertions fail,
   independently of any colour.
4. Replace History's rail/head/selection with a label list: entry/minor tick and
   distinct marker assertions fail, while exact drawer navigation may still work.

Keep the restored positive result and all four failing outputs. Product
acceptance also requires a reviewer to open every final production/reference
pair and classify each difference as approved adaptation or unmet criterion.
Passing tests cannot substitute for this review.

## Delivery artifacts

The implementation PR links an externally accessible gallery and original
artifacts, with exact feedback SHA, reference checksum, scene IDs, actual terminal
dimensions, runtime, font/theme and capture method. Local-only links do not meet
#881's delivery condition. Publication is part of the later authorized
implementation PR work, not this local preparation.

Freeze the final scene mapping, adaptations, ownership rulings and evidence
commands together. Add a scenario afterward only for an unmet existing criterion
or a distinct structural consequence requiring an explicit amendment.
