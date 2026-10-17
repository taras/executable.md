# PR 3 implementation handoff: navigate the recorded History rail

**Frozen; ready for implementation from accepted PR 2.** History shows all retained
checkpoint positions while content reads one selected prefix. Tall entry marks
and shorter semantic marks share a five-row rail. Selection stays amber above
the rail; the truthful head stays below it, including at the same column.
The drawer selects every exact checkpoint, even when rail marks are grouped.

The accepted [architecture handoff](pr3-planner-handoff.md) owns these product
and structural decisions. This plan freezes the concrete algorithm, focused
evidence and [77-pair assembled gallery](final-gallery-matrix.md). The shared
[stack and evidence record](stack-and-evidence.md) supplies exact revisions,
real fixtures and feedback rules. This is planning, not production acceptance.

## Base and boundaries

Implement on accepted PR 2 **acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e**, parent
9163a16b9f5b83e9c042f47e90ac307f4679d239. The [Planner acceptance](pr2-planner-acceptance.md)
records independent structural, visual and live feedback. Its integrated base is
c7d54769d56661bef38cee8549b148f3bf87a904: accepted PR 1
080b6ec80ca74e614789e8d2252857ac281df7e5 plus recorded main
4c0414be1010f69f11bff0d1d634623a5b08f886. Branch from the accepted PR 2 SHA and
refresh overlaps before production edits. PR 3 preserves PR 2's public observation
and static inspection APIs, source/output/wrapping, arrows and live/prefix rules.

No persistence, timing, sidecar, new Core API, dependency/vendor update, provider
during settled inspection, new terminal reader, observer stream, polling,
scrubbing, horizontal scrolling, fork, editor, auto-drawer or newer reference
feature belongs here. The draft and contextual action row retain their product
behavior. This slice supplies complete original visual evidence for #881; its
feedback remains separate from delivery and publication.

## 1. Give navigation and content one retained snapshot

Use this exact private view shape, reusing existing ReplCheckpoint kinds:

```ts
interface ReplHistoryNavigation {
  readonly checkpoints: readonly Pick<ReplCheckpoint, "marker" | "kind">[];
  readonly head: "empty" | "live" | "pausing" | "paused" |
    "settling" | "settled" | "unfinished";
}
```

Detach/freeze the list and each item. Both members are required. Carry no
checkpoint label, source, component/binding name, value, output, question,
permission, Agent detail, outcome detail or lifecycle observation. Selection
already belongs to the root route and is not copied into this summary.

In program.ts, replace the selected-only reproject shortcut with a rebuild from
one readAll result per retained/session wake. Snapshot the acknowledged event
array before projection. Project its full head and requested marker using that
same array and projectRepl's existing full-file validation. Two projections of
one immutable input are sufficient; do not add a second reader or redesign the
projector. Derive the thin list from the full validated model, derive the
inspected model from the requested prefix, and discard the full model from child
reachability. Never derive full navigation by appending to a selected model.

A later malformed segment refuses the whole reading even for an earlier marker.
Use the existing refused view, not stale navigation beside a plausible prefix.
An invalid requested marker retains the existing route refusal semantics; it
never rounds to a grouped mark or head. Initial/cold validation uses this same
flow before a resolved screen is composed. During paint/resize preparation,
reuse that one immutable reading; a new retained append wakes another rebuild.
Do not read the Journal from a description, drawer or renderer.

Pass navigation root → application view → footer band and History drawer through
the direct parent composition. Only the band receives head; the drawer receives
the thin list. Other panes receive the selected model and suppressed historical
live overlay. This is the explicit navigation exception to whole-view prefix
wording, not an exception for content or capabilities. The inspected action row
still reads History and offers only its existing historical controls; it does
not acquire Pause, Continue or Submit from navigation. Returning live resolves
the latest actual session view and capabilities. H1/H2 prove this separation.

## 2. Derive the head from retained facts and owned work

Use the full snapshot's latest entry/root outcome and the session's actual
entry-wide liveness from PR 2. That signal remains true until all entry resources,
including its outer Agent attachment and consumers, release. The first-registered
last-running entry finalizer publishes the existing session wake. Do not set
settled from body return, root Close, component badges, drawers or selected
content. Preserve submission readiness and cancellation/failure ownership.

| Precedence | Required facts | Exact label |
| --- | --- | --- |
| 1 settling | Latest root outcome retained; owned entry task still active. | HEAD · SETTLING |
| 2 paused | Active task, no root outcome; controller actually paused. | HEAD · EXPANSION PAUSED |
| 3 pausing | Active task, no root outcome; controller actually pausing. | HEAD · PAUSING EXPANSION |
| 4 live | Active task; none of the preceding cases. | HEAD · LIVE |
| 5 empty | No retained entry and no owned task. | HEAD · EMPTY |
| 6 settled | No active task; latest entry has a retained root outcome. | HEAD · SETTLED |
| 7 unfinished | Latest entry lacks root outcome; no active task. | HEAD · UNFINISHED |

Paused stops expansion, not already-started background work. A retained success,
failure or cancellation all become neutral SETTLED after owned unwind. Missing
outcome without owned work is UNFINISHED, never an inferred paused state.
Settled cold inspection starts no work. Existing unfinished-run resumption
remains unchanged; if it starts actual work the head describes that work.

Head-only changes publish through the current session/controller wake path,
including while inspecting. Add no stream, timer or competing frame clock for
static History. H3 uses real start, controller holds, retained Close and held
installation cleanup, then checks the completion repaint without input.

## 3. Allocate the five rows with engine measurements

Replace layout.ts's historyBand/groupedMarkers/bandRows label-list presentation.
Application.ts prepares immutable rail data from navigation, route selection and
engine measurements; presentation-style.ts maps its explicit roles to literal
colours. Layout receives inert placement/text data. It receives no Journal,
session, capability, mounted focus or authoritative outcome.

Keep footer rows action, five History rows, draft at every profile:

| History row | Left region | Stable right caption region |
| --- | --- | --- |
| 1 | History · recorded order | Head label |
| 2 | Entry captions, or No recorded checkpoints | Selection caption |
| 3 | Tall entry uprisers and historical selection diamond | Blank |
| 4 | Horizontal rail, entry/minor junctions | Blank |
| 5 | Short minor stems and head marker | Blank |

Use prepareFrame's measurement pass and the private fit probes described in
[planning-measurement.md](planning-measurement.md). Measure the band's inner
width, title, all seven head labels, `SELECTED · HEAD`, current
`◆ SELECTED · N`, and the actual entry captions. Reserve the maximum of head
and selection caption widths at the right, plus an engine-measured separating
space. Use the same reserved width for all head states. The remaining measured
left region owns the rail, and must hold the title and admitted entry captions.
No head-state-only update changes those reservations or source rail placement.
Changing count/selection or size may remeasure. Paint empty areas with the band
surface so a shorter caption cannot leave old cells behind.

These deterministic mechanics are frozen:

1. Let W be the engine-measured available rail columns, K the complete checkpoint
   count and i its zero-based ordinal. For K>1 place i at
   round(i × (W−1)/(K−1)); for K=1 place it at W−1. Empty has no checkpoint marks.
   This is proportional spacing inside measured bounds, not elapsed time.
2. Consecutive ordinals assigned to one column form one visual group. Keep
   every marker/kind in the group's private presentation membership. K and the
   same measured size produce identical groups, independent of head state.
   The head marker is below the rail end; an active empty reading has a head
   label but no invented checkpoint tick or target.
3. Entry marks use `┃` above the rail. Minor marks use `┬` at the rail and `│`
   below; crowded groups use heavier `┳`/`┃`. Groups with entries preserve their
   tall boundary and heavier junction. Assemble entry/minor collisions without
   dropping either category. Junction shape details remain private.
4. An inspected selection uses an amber `◆` in row 3 and amber junction in row 4
   at its group's column. Its right caption is `◆ SELECTED · N` using the exact
   full-list one-based ordinal, never the group ordinal. Live has
   `SELECTED · HEAD` and no earlier-selection diamond. Head uses `▼` in row 5.
   If both share a column, preserve ◆ above and ▼ below with separate colours.
   Those distinctive markers win their cells; other category information remains
   in junctions/captions and exact drawer rows. The rail is not interactive.
5. Number entries by admitted entry order. Start one caption `Entry E` per entry
   at its column, centred on that mark and clamped to the left measured region.
   Its width is the engine's actual fit result. Require one separating cell
   between adjacent captions. For the first overlapping pair from left to right,
   merge its actual consecutive entry span into `Entry A–B`; centre that caption
   between its first/last entry columns, clamp, remeasure, and repeat left to
   right until all captions fit without overlap. Merged captions never include
   a nonexistent entry, clip a number or invade the right region. A measurement
   refusal follows the existing frame refusal, not an ellipsis or overwrite.
6. Express columns/spaces as constrained engine boxes or measured text runs.
   The engine owns final bounds; no parallel screen/pointer coordinate map is
   built. History's static marks/captions mount no controls or targets. Exactly
   one prepared reading feeds placement, descriptions and committed cells.

At 72×20 the title and longest head still fit, with rail columns remaining.
Use the crowded real fixture for caption merges rather than assuming caption
length in characters. Resize remeasures and regroups while preserving exact
marker, route and draft; focus follows existing mounted-window rules. Drawers
remain above seven footer rows, and absent narrow surfaces have no nodes/targets.
H4/H5 verify measured placement and navigation separately.

## Colours and exact drawer rows

These accepted literals are independent expectations, copied with original
source provenance to the test fixture:

| Role | Colour |
| --- | --- |
| Band surface / horizontal rail / title | #08090b / #141a1f / #8b959c |
| Entry caption / tick at or before selection, or live | #b8c4cc / #e6ecf1 |
| Minor mark at or before selection, or live | #7fd3e8 |
| Later entry tick and caption / minor mark | #5d666e / #4e565d |
| Selected diamond, junction and ordinal caption | #c9a86a |
| Live head marker and label | #7fd3e8 |
| All other head states, SELECTED · HEAD, empty message | #7b858d |

Later means ordinal after selection. For each group, entry and minor categories
independently use their earlier colour when any corresponding member is at/before
selection; otherwise later. Merged entry captions spanning selection use the
earlier caption colour. Selected junction/diamond/caption win their cells; head
keeps its own state colour below. No global focus recolouring, green settled
success, checkmark or animation is implied. Preserve PR 1's drawer focus/selection.

Replace drawerRows's use of checkpoint.label with one row per full marker:

| Kind | Exact wording; N is full ordinal, E is entry order |
| --- | --- |
| entry | N · Entry E admitted |
| scope | N · Component admitted |
| binding | N · Bindings recorded |
| generated | N · Generated XMD admitted |
| elicit | N · Answer recorded |
| agent | N · Agent turn recorded |
| terminal | N · Entry outcome recorded |

Count E from entry kinds in the thin list, without looking up future payloads.
Use identical category wording at live and historical routes. A recorded answer
is not a wait; admission is not invocation completion; entry outcome is not
finished cleanup. Keep History title, marker-based key and typed marker action,
selected cue, existing window and `[↑ earlier]`/`[↓ later]` controls. Every group
member keeps a separate drawer action. Off-window rows have no node, pointer
target or Tab stop. Add no legend/hint row that costs capacity. Empty has no
drawer marker action and no fabricated selected ordinal. H1/H5 cover the drawer.

## Frozen focused evidence

Add packages/cli/tests/repl-history.test.ts. Extend the existing projector,
execution, entry, composition, layout and journey regressions using their real
stream/profile/renderer fixtures. Do not fabricate a head state for an acceptance
journey; derived unit tests may take an actual retained unfinished snapshot
without opening/resuming it.

| ID | Concrete inputs and required evidence | Defect discriminated |
| --- | --- | --- |
| H1 | Complete Plan then the corrected HistoryRecord crowd fixture. Pick two same-category component-admission markers sharing one measured column; exact root drawer actions reveal each corresponding prefix, including its distinct admitted component set. Full category rows include all seven kinds and correct N/E. | Group substituted for marker; prefix-only navigation loses later positions. |
| H2 | Select before generated source, bindings, answer and Agent admission. Inspect panes and drawer; only full identity/kind and band head exception cross. Corrupt a later segment and ask for earlier marker: full refused view, no stale navigation. | Future payload/richer label leaks or partial validation. |
| H3 | Actual empty, pre-first-record active task, live, pausing, paused; request Pause against already-started work, inspect during PAUSING, then release it: retained records and full navigation grow, selected content stays fixed, and the controller establishes PAUSED. Held root-outcome teardown reads SETTLING then neutral SETTLED without input. Separate retained success/failure/cancel and unowned unfinished. Readiness/controls remain with real owner. | Root Close proves completion, background work declared stopped, historical execution authority. |
| H4 | Empty, singleton and the crowd fixture's complete checkpoint list at all three engine-measured sizes. First/last positions, deterministic collisions, entry/minor hierarchy, entry caption range merge, longest head fit, independent shared-column ◆/▼; head-only transition leaves groups/caption reservation unchanged. | Character-count admission, overlap, list substitute or hidden marker. |
| H5 | Populated exact History drawer, all rows reached with Unicode controls; visible/focus/pointer target agreement. Resize 160×36→120×30→72×20→60×15→160×36 preserves marker, route, draft and focus under existing admission rules. | Invisible actions, changed identity or extra narrow mounts. |
| H6 | Settled cold head and early prefix, retained draft, same markers/order/grouping at same sizes, category-only labels, no live badges. Journal/provider hashes and component-source-load counters unchanged; process-local offsets initial. | Reconstruction by execution or persistence of presentation. |

Planner fixture correction after review at f509197b: one binding publication can
hold many Json results, so Json count does not establish checkpoint count. Use
200 actual HistoryRecord Markdown invocations for crowding. H1 keeps its exact
prefix requirement and uses two scope checkpoints of the same category. See
[the PR 3 review](pr3-planner-review.md); the frozen gallery remains 77 pairs.

Planner R2 evidence-order correction: establish provider work, request Pause,
inspect while PAUSING, then release the work and observe the retained advance
and actual PAUSED head. Closing History preserves the hold; Continue is checked
after returning live. [The correction](pr3-r2-evidence-correction.md) supersedes
the earlier establish-before-release fixture recipe. The controller is unchanged.

Run these exact focused commands on the actual PR 3 implementation base:

```bash
deno task test packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-model.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-composition.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-agent-journey.test.ts
git diff --check
```

The second command holds the preceding source, drawer and Agent slice through
assembly. Existing tests may update their list/label premise; retain exact action,
prefix, focus and teardown behavior and itemize each changed assertion.
Report actual counts, not an invented required count. Commit promptly after
focused evidence passes; do not wait for exhaustive CI or whole runtime suites.

Run five controls independently on the assembled feedback revision: collapse
token roles (a named XMD/JSON cell fails); remove nesting rails (source geometry
fails); remove lifecycle words/glyphs (real held-call frame fails); replace
History with a label list (H4 shape/shared markers fails); clear the head's
owned-work fact at root Close (H3 fails while held teardown is entered).
The full/selected snapshot and future-payload refusal cases in H1/H2 are direct
negative regressions; they require no additional control mutation. Keep all
patches, first failures and SHA-verified restorations. A one-bit palette drift
is the token control when applied to an independently sampled original role;
it must fail the named committed-cell assertion rather than fixture equality.

## Documentation, gallery and handback

Update architecture.md and specs/repl-spec.md together with implementation.
Describe the explicit full-navigation/head exception, root-owned thin immutable
summary, one validated snapshot, prefix-only other panes, exact checkpoint
actions, entry-wide cleanup truth, category wording, measured five-row rail and
grouping in present tense. Keep the action row's historical restrictions and
fixed seven-row footer. No new executable-MDX or persistence contract is added.
Architecture review uses the seven frozen checks in pr3-planner-handoff.md.

Capture and open all 77 pairs on the exact assembled feedback SHA, using the
frozen matrix and accepted terminal adaptations. Do not substitute the accepted
35 PR 1 pairs or PR 2 captures for fresh assembled captures. Return gallery,
runbook, manifest, image review, cell/target evidence, controls, actual focused
commands and cold hashes under pr3-evidence/ and pr3-implementation-handback.md.
Public artifact links belong to separately authorized delivery work. A local
Planner feedback verdict alone neither publishes a PR nor closes #881.

Continuity: required predecessor is accepted PR 2
acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e on the exact stack recorded above.
Artifacts are this handoff and the shared stack, measurement and final-gallery
records. All original-scope architecture and presentation decisions are settled.
**Planning blockers: none; PR 2 acceptance dependency satisfied.** Next Implementor
action: branch from that exact feedback SHA, prepare the worktree under AGENTS.md,
and implement the snapshot, head and rail layers above. Return the frozen focused
evidence and fresh 77-pair assembled gallery; stop before push or PR creation.
