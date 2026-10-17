# PR 3 Planner handoff: recorded History rail and exact checkpoint selection

**Ready for planning.** The Product Owner accepts the complete History
navigation boundary, six presentation decisions and main verification journey.
Prepare a self-contained implementation handoff for the final slice of
[Story #881](https://github.com/taras/executable.md/issues/881). Product behavior,
member types, labels, colours, grouping and prefix isolation are settled.

This is an architecture/design handoff. It reports no PR 2 or PR 3 implementation
verdict, production test run, feedback commit, completed visual parity or
delivery approval. The Planner freezes concrete sites, fixtures, focused commands,
finite visual evidence and negative controls before implementation.

## Outcome and smallest example

History shows the complete recorded sequence while a person reads an earlier
checkpoint. Tall entry ticks and short minor marks establish hierarchy. An
amber diamond above the rail identifies selection; a separate head marker
below the rail describes the current overall state. Both stay visible at the
same column. The History drawer selects every exact marker, including those
sharing a crowded rail mark. Inspected content remains the selected prefix.

For example, checkpoints 41–43 can share a grouped notch. Selecting drawer row
`42 · Bindings recorded` keeps `◆ SELECTED · 42` at right and reads exactly that
prefix. It does not reveal checkpoint 43's bindings. Later recorded marks stay
available in navigation with dimmer colours.

## Stack and authority

- PR 1 Planner feedback is PASS at
  **080b6ec80ca74e614789e8d2252857ac281df7e5**, parent
  f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa, recorded base
  e68f128121cd802623ab7797a016b0c66ce91176. Preserve its
  [acceptance record](pr1-planner-acceptance.md) and 35-pair evidence unchanged.
- PR 2's [architecture handoff](pr2-planner-handoff.md) is ready for planning.
  Its middleware, source inspection, source/output reading, wrapping and arrow
  labels are accepted contracts. No accepted PR 2 implementation SHA is supplied
  here. PR 3 plans against those contracts and implements on the actual accepted
  preceding slice. Record the exact stack base and refresh overlaps before
  implementation; do not infer production acceptance from design approval.
- Architecture workspace HEAD is
  2d719f78025059158a35023701fdff52b855a65b. This is not a current remote-head or
  CI claim. Merged #876/#877/#878 supply measured layout, reveal retention and
  semantic styling. Reuse installed dependencies and the patched Freedom tree.
- The older corrected reference archive owns visual intent. Its SHA-256 is
  **86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b**;
  retained bytes are [evidence/reference.zip](evidence/reference.zip).
  The newer Downloads archive adds a feature and supplies no requirement.
- Detailed accepted contracts are
  [pr3-history-contract.md](pr3-history-contract.md) and
  [pr3-product-verification.md](pr3-product-verification.md). This handoff
  consolidates their consequential decisions. The
  [colour study](visuals/history-colours.html) is an interview aid, not a measured
  terminal capture. The full-story matrix is a source for the Planner's evidence
  plan, not another frozen oracle.

Read repository AGENTS.md, required Effection instructions, architecture.md,
the affected REPL specification and the accepted PR 2 boundary records. Setup
owns dependency preparation; builds/checks do not reinstall or mutate that state.

## Accepted private navigation interface

```ts
interface ReplHistoryNavigation {
  /** All retained checkpoint identities and kinds, in append order. */
  readonly checkpoints: readonly Pick<ReplCheckpoint, "marker" | "kind">[];
  /** Overall head state for the History band, independent of inspected content. */
  readonly head:
    | "empty"
    | "live"
    | "pausing"
    | "paused"
    | "settling"
    | "settled"
    | "unfinished";
}
```

Reuse ReplCheckpoint's existing marker identity and kind union: entry, scope,
binding, generated, elicit, agent and terminal. The summary name is private
implementation vocabulary, not a Core API or a new package export. Both members
are required. Freeze a detached list and each element. The route already owns
selection; do not duplicate it in the summary.

Carry no original label, component or binding name, source, value, rendered
output, question, permission, Agent turn, outcome detail or lifecycle observation.
An empty list means no retained selectable checkpoint. Grouping never changes
marker identity or creates a durable checkpoint.

The root program drive owns the reading. Derive full navigation and the selected
model from one validated retained-event snapshot; rebuild on the existing session
wake path, including during inspection. A damaged later segment remains a
projection refusal even when the requested marker is earlier. Do not present a
stale or partial navigation summary beside a plausible prefix.

Pass immutable data through the direct parent-child path: root program
composition to application view, then to footer History and the History drawer
through existing parent composition. The band receives both members; the drawer
receives the marker list. Children do not project the Journal or read the
session. Renderer input remains engine operations and the renderer stays
model-blind. No additional host reader, polling loop, observer stream or durable
store is introduced.

This is the accepted History navigation exception to whole-view prefix wording.
Source, Output, Sessions, Bindings, questions, permissions, Agent details and
live lifecycle overlays remain prefix-only during inspection. The frozen action
row still reads History and offers only its existing historical controls.
Navigation does not grant Pause, Continue or Submit authority. Returning live
resolves the actual current view and capabilities.

## Head states, precedence and exact labels

Use this precedence and these facts, from the full retained reading and actual
session-owned entry task/controller state:

| State | Required fact | Exact label |
| --- | --- | --- |
| settling | Latest root outcome is retained; its owned task still releases resources. | HEAD · SETTLING |
| paused | Task is active without a root outcome; real controller reports paused. | HEAD · EXPANSION PAUSED |
| pausing | Task is active without a root outcome; real controller reports pausing. | HEAD · PAUSING EXPANSION |
| live | Task is active and none of the preceding states applies. | HEAD · LIVE |
| empty | No entry is retained and no entry task is active. | HEAD · EMPTY |
| settled | No entry task is active; latest entry has a retained root outcome. | HEAD · SETTLED |
| unfinished | Latest entry has no root outcome and no entry task is active. | HEAD · UNFINISHED |

Paused holds expansion, not already-started background work; that work may still
advance the Journal. Settled includes successful, failed and cancelled outcomes
and carries no success cue or payload. Unfinished does not mean paused. Do not
derive state from a drawer, a component badge, the selected prefix, missing
frames or an absent terminal record alone.

Owned work remains active through its complete teardown. A body return or root
close does not prove release. The plan names the session-owned boundary that
proves cleanup is complete and wakes the existing rebuild; do not assume the
current session.live flag covers every outer attachment. Preserve ownership,
cancellation, failure precedence and submission readiness. No new resource
owner is proposed.

Cold readings use retained facts unless this process actually owns work. This
does not add a mode that disables existing unfinished-run resumption. The
accepted cold-immutability journey opens a settled execution.

## Five rows, marks and grouping

Keep the same layout at 160×36, 120×30 and 72×20:

| History row | Reading |
| --- | --- |
| 1 | History · recorded order at left; head label at right. |
| 2 | Entry captions over the rail; selection caption at right. |
| 3 | Tall entry uprisers and selected diamond above the rail. |
| 4 | Horizontal rail with entry and minor junctions. |
| 5 | Short minor stems and head marker below the rail. |

The contextual action row precedes these rows and the draft follows, for seven
footer rows. Drawers remain above the footer. Narrow shows only its routed
surface and admitted drawer; absent surfaces have no nodes or targets.

Reserve one stable engine-measured right-hand caption region covering the
largest head label and current selection caption. Marks occupy the remaining
measured rail region. A head-state-only change neither moves the selected mark
nor reflows the rail. No extra separator or legend consumes a row.

Use `┃` entry uprisers, `─` rail, `┬`/`│` minor marks, an amber `◆` selection
above and a `▼` head below, aligned with the rail end. These are readings, not
key bindings or controls. Exact junction assembly remains local.

Place checkpoint ordinals evenly across available measured columns: first at
the start, last at the head; a singleton at the head. Consecutive ordinals
sharing a column form one visual group. Use heavier `┳`/`┃` minor marks for
crowded groups. Groups containing entries retain tall entry boundaries and a
heavier rail junction. Entry/minor collisions retain both readings where the
distinctive head/selection markers do not occupy those rows.

Entry captions use Entry N. Merge overlapping adjacent captions into actual
consecutive entry ranges, such as Entry 1–3, until they fit their measured region.
Do not clip into a different number or overwrite right-hand captions. The
Planner supplies the concrete deterministic algorithm against engine bounds;
character-count width estimates do not own admission.

Historical selection reads `◆ SELECTED · N`, where N is the one-based ordinal
in the complete checkpoint list. Live selection reads `SELECTED · HEAD` with no
earlier-selection diamond. If selection and head share a column, retain ◆ in
row 3 and ▼ in row 5, with separate colours. These distinctive marks take
precedence over an entry upriser or minor stem in their own cells; rail/group
identity and entry captions still represent the boundary.

With no checkpoints, show No recorded checkpoints in row 2, with no fabricated
tick, selected ordinal or target. Actual work before its first checkpoint may
still give a live head label. Keep the five-row band.

Resize remeasures and regroups, preserving marker identity, draft and route;
focus follows established window/admission rules. The same snapshot and size
produce the same groups. Appended checkpoints may change proportional placement;
changing only head state does not. No rail input, scrubbing, horizontal scrolling
or new navigation mode is introduced.

## Accepted literal colours

| Reading | RGB hex |
| --- | --- |
| History surface | #08090b |
| Horizontal rail | #141a1f |
| History title | #8b959c |
| Entry caption at/before selection, or at live head | #b8c4cc |
| Entry tick at/before selection, or at live head | #e6ecf1 |
| Minor mark at/before selection, or at live head | #7fd3e8 |
| Later entry tick/caption during inspection | #5d666e |
| Later minor mark during inspection | #4e565d |
| Selected diamond/junction/ordinal caption | #c9a86a |
| Live head marker/label | #7fd3e8 |
| All other head states | #7b858d |
| SELECTED · HEAD and No recorded checkpoints | #7b858d |

Later means recorded after the selected ordinal. For a group, use the earlier
entry colour if any represented entry is at/before selection, otherwise the
later-entry colour; apply the equivalent rule separately to minor marks. Merged
entry captions spanning the boundary use the earlier-caption colour. The exact
selected ordinal and drawer retain the distinction between group members.

Selection wins its diamond, junction and caption colour. Head retains its own
state colour below, including at the same column. Keep PR 1's drawer focus and
selected-row cues. No global focus recolouring, green settled head, success
checkmark or animated progress is implied.

## Exact-selection drawer wording

One row per exact marker, in full retained order, including every grouped mark.
N is the full-list checkpoint ordinal; E is admitted entry order:

| Kind | Exact row wording |
| --- | --- |
| entry | N · Entry E admitted |
| scope | N · Component admitted |
| binding | N · Bindings recorded |
| generated | N · Generated XMD admitted |
| elicit | N · Answer recorded |
| agent | N · Agent turn recorded |
| terminal | N · Entry outcome recorded |

Use the same category-only labels at live and historical routes, not original
richer labels containing later names or outcomes. Component admitted is not a
completed invocation; Entry outcome recorded is not finished cleanup. The
successful answered-question checkpoint is Answer recorded, not a pending wait.

Keep marker-based keys, existing semantic selection actions, title History,
focus/selection cues and measured window. PR 2's `[↑ earlier]` / `[↓ later]`
controls reach every exact row. Rows outside the admitted window have no node,
frame target or Tab stop. No hint/legend row consumes capacity. Selection
projects the exact marker or reports the existing refusal; a visual group never
becomes one combined marker action.

## Frozen structural review checklist

1. **Authoritative retained identity.** Full navigation and selected content come
   from one validated snapshot; full-Journal refusal remains fail-closed. Groups
   preserve exact marker identities and never invent durable positions.
2. **Inspection reachability.** Only full marker identity/kind reaches band and
   drawer; overall head state reaches band alone. Future payloads, richer labels,
   live content and execution capabilities do not enter inspected panes or the
   frozen action row through this exception.
3. **Execution ownership.** The session's actual entry task/controller owns live
   head facts through complete unwind. Body return/root close cannot release
   readiness early; cancellation, failure precedence and actual capabilities
   retain their existing owners.
4. **Persistence and reconstruction.** No Journal/sidecar protocol, timing record,
   replay execution, provider or source load is introduced for settled cold
   inspection. Existing unfinished-run resumption remains its separate policy.
5. **Root and child boundaries.** Rebuildable immutable view data flows down the
   direct parent path; typed marker actions flow up. Only the root resolves
   selection. Children/renderers hold no Journal, session or control authority.
6. **Mounted targets and measurement.** One prepared measured reading supplies
   placement, descriptions and targets. Freedom retains focus; absent narrow
   surfaces and off-window drawer rows have no nodes/targets. Grouping does not
   redirect an exact checkpoint action.
7. **Resource and concurrency boundaries.** Reuse the existing owned wake/input
   paths and rendering lifetimes. Static History introduces no extra host reader,
   competing frame subscription, polling loop or resource owner, and no live
   observation leaks or revives after session teardown.

Architecture review uses this checklist on the exact feedback SHA. A distinct
later structural invariant needs an explicit architecture amendment. Product
appearance and ordinary evidence sufficiency remain Planner feedback; CI,
speculative permutations and incidental diagnostic polish do not expand this
architecture review.

## Planner work, verification and complete-story evidence

Use the accepted six-step journey in pr3-product-verification.md at all three
profiles: original Plan/README and populated entries; real pause and early
inspection; offscreen owned work; grouped exact selection and shared indicators;
resize/return live/held cleanup; settled cold reopen. Derive companion evidence
for empty/singleton states, success/failure/cancellation, unfinished readings,
navigation payload exclusion, damaged later history and mounted target agreement.

The plan names concrete sites in program.ts, application.ts, layout.ts and
presentation-style.ts, and projector/session changes only where needed for the
accepted snapshot/ownership facts. Explain the single-snapshot projection flow,
full teardown signal, existing wake integration, engine-measured caption/rail
allocation, ordinal grouping and exact drawer rows. Do not defer these mechanics
to discovery during implementation. If the concrete plan requires a new public
boundary, return that specific choice to the Architect before adding it.

Candidate focused files are repl-model, repl-execution, repl-journey,
repl-layout-admission, repl-presentation-style and relevant forms regressions.
Choose the smallest discriminating selection, adding known black-box boundaries
explicitly. Name concrete inputs and controlled real operations, not fabricated
head/lifecycle states. Preparation uses setup, never a check that reinstalls.

Freeze PR 3's finite gallery and meaningful isolated break controls. Include
M9/M10 and the complete assembled original journey, mapping each pair to the
older archive source/scene, hash, profile and feedback SHA. Carry all accepted
terminal adaptations. Keep literal expectations independent of production
palette/role maps. A reviewer opens every final pair and classifies differences;
tests alone do not prove parity. Exact gallery counts, commands and control
sufficiency belong to the Planner. Do not automatically inherit PR 1's 35 count
or the provisional 71-pair baseline as a frozen final oracle.

After focused evidence passes, create a stable feedback commit promptly and
return its exact SHA, stack base and every actual focused command. Preserve first
failure output and apply repository flake rules where relevant. Exhaustive CI
and delivery gates keep their authority and are separate from architecture
feedback; do not wait for them to supply the feedback revision.

Update architecture.md and specs/repl-spec.md with implemented behavior in
present tense: the explicit History navigation exception to whole-view prefix
wording; root ownership and thin summary; truthful head/cleanup semantics;
five-row rail, grouping, category drawer and unchanged seven-row footer. Keep
the frozen action row's restrictions. No completed production claim is published
ahead of implementation.

## Exclusions and next action

No new persistence, clocks, elapsed/compressed-wait protocol, general tracing,
dependency/vendor change, Core API, extra reader, fork, scrubbing, multiline
editor, automatic drawer or newer reference feature belongs to this slice.
PR 3 preserves PR 2's session-owned middleware authority and cold/prefix rules.

Next Planner action: freeze conforming PR 2 and PR 3 implementation/evidence
handoffs against their settled contracts, using the actual stack revisions.
The architecture interviews for the original parity slices are complete.
No production change, GitHub mutation, implementation verdict or delivery
approval is issued here.
