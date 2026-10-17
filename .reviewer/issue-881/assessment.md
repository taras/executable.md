# Fresh gap assessment

The current REPL has the accepted measured composition and useful semantic row
styles. It does not yet resemble the original reference's execution reading.
The largest difference is information hierarchy: the reference lets a person
follow source, nested work and result; production often shows many muted effect
summaries before the useful content.

This assessment uses the freshly captured revision in README.md. All 71 pairs
were inspected through the indexed contact sheets; the full History, question
and settled reference images were also opened. The inherited V1–V6 assessment
and its definitions were not found in this checkout or the referenced former
checkout. Those historical IDs remain **unassessed**. G1–G6 below are fresh
findings, not invented replacements for their definitions.

| Gap | Baseline observation | Required correction | Evidence |
| --- | --- | --- | --- |
| G1: colours within content | JSON keys, strings, numbers, booleans, null and punctuation share one foreground. The Plan review's XMD is a plain source block. Focus recolours the entire draft or control cyan. | Preserve token roles within XMD and JSON, including generated source and read-only previews. Focus adds a visible cue without erasing those roles. | [JSON wide](pairs/json-bindings-160x36.png), [binding drawer medium](pairs/binding-drawer-120x30.png), [Plan review wide](pairs/plan-review-160x36.png) |
| G2: source and execution structure | The nested Plan becomes `Plan-1 Plan`, interspersed with `import_component ok` and other effect summaries. Generated admission is recorded, but its source is beyond the initial visible transcript. The settled README is also below the initial effect list. | Present the known source with nested indentation and rails; place generated source at its recorded producing expression; distinguish source, progress, rendered output and subordinate metadata. Preserve readable access to long content. | [running wide](pairs/nested-running-160x36.png), [generated medium](pairs/generated-inline-120x30.png), [settled wide](pairs/settled-160x36.png) |
| G3: lifecycle | Entry outcomes and waiting guidance exist, but nested occurrences do not show the reference's ENTER, ACTIVE, WAITING, EXIT, SETTLED and FAILED glyphs/labels. Imports are not proof that a component body entered or exited. | Middleware observes the complete invocation and its actual waits, failure and cancellation. A session-owned live view carries those observations; the Journal supplies the separate retained reading. | [running medium](pairs/nested-running-120x30.png), [failed wide](pairs/failed-160x36.png), [paused wide](pairs/paused-head-160x36.png) |
| G4: coordinated panes and drawers | Pane colours and edges are present. Drawers begin directly over cut background headings; titles such as `SessiBinding` visually run together. Field/action stripes and the blank preview area make the drawer's boundary hard to read. Original drawers have a clear boundary, subordinate state line and grouped preview/actions. | Make each admitted drawer rectangle read as a distinct surface with a clear edge/title hierarchy and grouped labels, hints, values, validation and actions. Retain the measured placement and modal ownership. | [binding narrow](pairs/binding-drawer-72x20.png), [details wide](pairs/completed-details-160x36.png), [permission narrow](pairs/permission-drawer-72x20.png) |
| G5: History | Five rows wrap gold checkpoint labels. There is no horizontal rail, major/minor tick hierarchy or distinct head and selection marks. Inspecting `tokens` projects the prefix and removes later checkpoints from this reading; the footer does not show its relationship to the known head. | Draw the reference's rail relationships in the existing five rows using recorded order, subject to approval. Keep exact checkpoint selection in History's existing drawer. Decide how its head reading coexists with prefix-only inspected panes. | [History wide](pairs/history-drawer-160x36.png), [selected medium](pairs/historical-selection-120x30.png), [historical closed narrow](pairs/historical-closed-72x20.png) |
| G6: terminal adaptation and focus | Selection has a background and `*`; keyboard focus has `>`/weight. Narrow actually omits transcript and bindings. Resized drawers retain their route and draft, but long read-only lines are hard to read within a short window. | Preserve selection/focus separation, absent-pane targeting and window controls while adding token colours. Approve cell-based emphasis/rails and readable source/preview layout explicitly. | [draft narrow](pairs/draft-72x20.png), [README narrow](pairs/readme-preview-72x20.png), [recovered drawer](pairs/resize-recovered-160x36.png) |

## Findings that do not justify another layout rewrite

The fixed footer survives the drawer journey at all three supported sizes.
The 60×15 screen refuses with the actual dimensions and a recovery instruction;
enlarging restores the permission drawer and the exact unsubmitted draft.
Those captures reproduce no claim that modal ownership or resize destroyed the
route. G4 is a visual separation problem, not evidence that #876/#877 failed.

Narrow absence is an intentional existing product adaptation. There is no
transcript or bindings pane at 72×20, and this plan adds neither. The draft is
one row with a line-count summary for multiline input. The live location stays
absent from the screen, as already settled in #878.

The baseline fixture reached real Plan review, generated project details,
validation failure, README confirmation and a real completed write in the
review's temporary working directory. Its source differs from the mockup only
to use the accepted declarative generated-XMD grammar. Inspection and cold
reopen contact no provider and add no Journal records.

## Architectural finding

The captured Journal has 45 Yield and five Close records, all with coroutine ID
`root`. The closes belong to the five entries. Component imports retain useful
source positions, but they do not supply separate component closing events.
ReplScope models admitted source regions, not every executable element's
lifetime. ReplCheckpoint has marker/kind/label, with no timestamp or owner depth.

The Product Owner has settled that live lifecycle comes from execution
middleware, not these records. The missing piece is a complete-invocation
observation seam: resolution, accepted body, pending waits, ordered teardown and
final semantic outcome, including failure and cancellation. Add that boundary
without persistence. The [revised proposal](architecture-review.md) maps the
states and separates the session-owned live view from inspected retained panes.
Applying the root's status to every imported component or adding a presentation
Journal would not satisfy #881.

## Capture qualifications

Some main-scenes deliberately keep an earlier selected entry while a later
entry runs. That is supported behavior, and the captions identify the state;
their contents are not presented as exact reference scene matches. Source and
rendered output currently hidden below the initial transcript window are
assessed from both the capture and the application/model code, not imagined as
visible in those frames.

An early provider fixture failed to match a prompt with leading whitespace;
another permission capture outlived the fixture's 180-second timeout. Diagnostic
files and traffic are retained separately. Corrected captures replace those
scenes. These are capture-fixture errors, not intermittent product test failures.

The selected Decline choice is retained correctly in provider traffic, but the
Sessions audit row says `granted: … — Decline`. This adjacent wording discrepancy
is recorded for the Architect's scope decision; it is not permission to broaden
permission semantics in this visual Story.
