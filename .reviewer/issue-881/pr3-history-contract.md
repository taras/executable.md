# PR 3: History rail interview

Status: recorded-order spacing and major/minor hierarchy are accepted by the
Product Owner. Both navigation members, checkpoints and head, are accepted.
Head display wording, five-row rail placement and collision grouping are
accepted, including rail colour treatment and generic History drawer wording.
All interface, presentation and
[verification journey](pr3-product-verification.md) decisions are accepted.
The [PR 3 Planner handoff](pr3-planner-handoff.md) is ready for planning.
PR 2 is ready for planning under
[pr2-planner-handoff.md](pr2-planner-handoff.md).

## Purpose

Show how the selected checkpoint relates to the recorded head. The older
reference distinguishes entry boundaries from smaller marks and shows the
selected position separately from the head. The terminal keeps the existing
History drawer for choosing an exact checkpoint.

The authority is the older corrected archive, SHA-256
86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b.
Its xmd-repl-timetravel.jsx Band draws tall entry boundaries above the rail,
short scope marks below it, an amber selection and a separate head indicator.
Its elapsed-time labels and compressed wait use mock timing cues. The current
ReplCheckpoint has marker, kind and label, with no timestamp.

## Item 1: spacing by recorded order

**Current.** The terminal spreads checkpoint labels through the five History
rows. It has no rail or major/minor tick geometry. The reference spaces marks
by elapsed time, which cannot be reconstructed from the current Journal.

**Intent.** Give the reader the reference's visual relationship between entries,
checkpoints, selection and head using facts the application actually retains.

**Assessment.** Adding timing records conflicts with the accepted persistence
boundary. Recorded-order spacing is a material adaptation of the reference and
needs Product Owner approval. It represents sequence, not duration.

**Accepted.** Label the band `History · recorded order`. Space positions by
their retained checkpoint order. Use tall entry ticks and short minor marks;
draw selection and head as separately identifiable indicators. Do not show
elapsed seconds or compressed-wait duration. Keep all five History rows and
the seven-row footer. The rail is read-only; the existing drawer chooses exact
positions. No new scrubbing, arrow-key navigation or fork control is introduced.

This decision settles the spacing basis and visual hierarchy. The accepted
labels and collision placement follow below. It does not grant permission for
future execution facts to appear in inspected content.

**Decision.** The Product Owner accepts recorded-order spacing, tall entry
ticks, short minor marks and distinct selected/head indicators. Subsequent
decisions settle head wording and collision placement.

## Navigation boundary interview: two members

Trigger: the History band needs later navigation facts while inspected content
remains a selected-prefix reading. This materially changes reachability during
inspection. Pause the main presentation interview and review the proposed
private summary's two members:

1. `checkpoints`: full retained marker order and checkpoint kind.
2. `head`: truthful overall head state, with no work details or capability.

The existing route owns the selected marker; do not duplicate it in this
summary. This is private CLI view data, not a Core API or durable record.
Both member types and their ownership contracts are accepted. Exact display
labels follow the completed boundary interview.

### Member 1 of 2: checkpoints

**Feature.** Keep the entire recorded rail and exact-selection drawer available
when a reader selects an earlier checkpoint.

**Example.** Selecting an early Plan checkpoint leaves later recorded marks
visible in History. The reader can choose a later mark directly. Source and
Output still describe only the selected Plan checkpoint.

**Current.** ReplCheckpoint carries marker, kind and label. Both historyBand
and the History drawer receive view.model.checkpoints, which belongs to the
selected prefix. Some labels contain binding names or recorded Agent outcomes.
Passing these whole checkpoints from the head would expose more than navigation
identity and category.

**Accepted member and documentation.**

```ts
/** All retained checkpoint identities and kinds, in append order. */
readonly checkpoints: readonly Pick<ReplCheckpoint, "marker" | "kind">[];
```

Reuse the existing marker identity and kind union. Freeze a detached list and
each element. Carry no existing label, binding name/value, source, output,
question, permission, Agent turn or lifecycle observation. Entry numbering and
generic checkpoint-category labels are derived from this list; their exact
wording is a later presentation decision. The drawer retains one semantic
selection action for every exact marker, including grouped rail marks.

An empty list means no retained selectable checkpoint. It does not mean the
projection failed or that a process is paused. A corrupt full Journal remains a
projection refusal under the existing contract; History cannot fall back to a
stale summary that appears complete.

The root program drive owns the reading. Derive the full navigation list and
selected-prefix model from one validated retained-event snapshot. Rebuild on
the existing session wake path, including while inspecting an earlier marker.
Keep inspected content fixed at its selected marker as the full list grows.
Do not introduce another durable store, polling loop, host reader or stream API.

The parent-child path is root program composition to the immutable application
view, then to the footer History band and the History drawer through their
existing parent composition. Neither child projects the Journal or reads the
session. Other panes and the contextual action row receive the prefix reading
and the already restricted live view. Later review of the head member determines
the additional state the band alone may show.

This is an explicit History navigation exception to the current specification's
whole-view prefix wording. The content restrictions remain intact. Record that
exception in the implemented REPL specification when this behavior exists.
Root ownership and immutable parent-child flow follow architecture rules 9 and
11; those conforming mechanics need no separate approval.

**Decision.** The Product Owner accepts the full marker identities and kinds in
History during inspection. Other content remains selected-prefix-only. The
accepted shape excludes the existing labels and their future binding names or
Agent outcomes.

### Member 2 of 2: head

**Feature.** Distinguish the current overall execution state from the earlier
checkpoint being read.

**Example.** While Source shows an earlier Plan checkpoint, the head indicator
can change from live to settling to settled as the actual entry finishes. Its
Output and lifecycle statuses do not appear in the inspected content.

**Current.** There is no History head-state member. The root has a session's
process facts, its expansion controller state and a retained model. Existing
readiness distinguishes a recorded result from an entry still releasing
resources. The expansion controller has playing, pausing and paused states;
paused holds the expansion walk, while already-started work can still finish
and advance the Journal.

**Accepted member and documentation.**

```ts
/** Overall head state for the History band, independent of inspected content. */
readonly head:
  | "empty"
  | "live"
  | "pausing"
  | "paused"
  | "settling"
  | "settled"
  | "unfinished";
```

This required value is a state, not a control, marker identity or success result.
Use these meanings and precedence:

| State | Required fact |
| --- | --- |
| settling | The latest entry has a retained root outcome, but its owned task still releases resources. |
| paused | An entry task is active without a retained root outcome, and its real expansion controller reports paused. |
| pausing | An entry task is active without a retained root outcome, and its real controller reports pausing. |
| live | An entry task is active and none of the preceding states applies. |
| empty | No entry has been retained and no entry task is active. |
| settled | No entry task is active and the latest entry has a retained root outcome. |
| unfinished | The latest retained entry has no root outcome and no entry task is active. |

Settled includes successful, failed and cancelled retained outcomes. It does not
claim success. The indicator carries no outcome payload or diagnostics. Display
wording and colour must preserve this neutral meaning; the detailed outcome is
read at its own checkpoint. Unfinished does not mean paused. A cold reader uses
retained empty/settled/unfinished facts unless this process actually owns work;
it never infers live state from an absent terminal record.

The root builds the head value alongside the accepted navigation list, from the
full retained snapshot and authoritative session-owned task/controller facts.
It does not infer it from live component badges, selected-prefix outcomes,
pending drawers or whether a frame has changed. Owned work remains active until
its teardown completes. A body's return or recorded root close is insufficient
evidence that resources are released. The concrete plan must show which owner
proves that boundary and how its changes wake the existing root rebuild; do not
assume the current session.live flag proves every outer attachment has unwound.
No new resource owner or observer stream is required by this contract.

Pass this state down only to the History band. The drawer needs the accepted
checkpoint list, not live state. Inspected Source, Output, Sessions, Bindings,
questions, permissions and the frozen contextual action row keep their existing
prefix restrictions. The summary never provides Pause, Continue or Submit
authority. Returning live resolves the actual current view and capabilities.

**Decision.** The Product Owner accepts the seven head states and their meanings,
including History-band-only visibility during inspection. Settling lasts
through owned teardown; settled does not claim success. Head-state display
wording is a separate presentation item.

### Complete accepted navigation interface

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

The summary name is a private implementation name. Both members are required;
an empty list and the empty state have explicit meanings, so absence need not
carry a second meaning. The route already owns selection. Neither member
duplicates source, output, outcome details, controls or lifecycle observations.
The accepted exception is specific to History navigation and head presentation,
not a reusable permission for future content to enter inspected panes.

## Item 2: head display wording

**Current.** The reference uses LIVE, PAUSED HEAD and COMPLETED. The terminal's
existing action row says running, settling or unfinished. Its frozen action row
says History. The accepted head type adds the distinctions needed to keep the
reference's indicator truthful without importing detailed live work.

**Intent.** Let a reader distinguish what the head is doing from the selected
checkpoint, including during cleanup and cold inspection.

**Assessment.** PAUSED HEAD can imply all work has stopped even though pausing
holds only expansion. COMPLETED with a success checkmark would misrepresent a
settled failure or cancellation. Name expansion explicitly and use neutral
settled wording. Keep these labels in the History band, under its accepted
navigation exception; the frozen action row remains History.

**Accepted wording.**

| Head state | Exact label |
| --- | --- |
| empty | HEAD · EMPTY |
| live | HEAD · LIVE |
| pausing | HEAD · PAUSING EXPANSION |
| paused | HEAD · EXPANSION PAUSED |
| settling | HEAD · SETTLING |
| settled | HEAD · SETTLED |
| unfinished | HEAD · UNFINISHED |

Use the same wording at all three profiles. Reserve engine-measured room for
the largest head label before placing the rail. A head state change must not
move or obscure the selected indicator or consume another footer row. Exact
glyphs and row placement follow below; no success glyph or colour is implied
by SETTLED. Colour treatment is a separate presentation item.

**Decision.** The Product Owner accepts all seven labels, with the same wording
at each supported profile. Reserve the largest engine-measured head-label width;
state changes do not obscure selection or add a footer row.

## Item 3: five-row rail placement

**Current.** The terminal uses the five History rows for checkpoint label lists.
The older reference has entry ticks above the rail, scope marks below it, a
selection diamond above and a separate head bar. Five terminal rows cannot
reproduce its pixel heights, but can preserve the visual hierarchy and keep
selection and head readable at the same horizontal position.

**Intent.** Show entry boundaries, minor checkpoints, selection and head within
the existing footer, with no competing control or extra row.

**Accepted placement.**

| History row | Reading |
| --- | --- |
| 1 | History · recorded order at left; accepted head-state label at right. |
| 2 | Entry-number captions over the rail; selection caption at right. |
| 3 | Tall entry ticks and the selected diamond above the rail. |
| 4 | Horizontal rail, with entry and minor checkpoint junctions. |
| 5 | Short minor stems below the rail and the head marker. |

Reserve one engine-measured right-hand caption region before placing marks.
Its stable width covers the largest accepted head label and the current
selection caption. The rail and its markers occupy the remaining measured
region; captions never overwrite marks. No extra separator row is introduced.

Use `┃` for entry uprisers, `─` for the rail and `┬`/`│` for short minor marks.
The selected position is an amber `◆` above the rail. The head is a `▼` below
the rail, aligned with the rail's end. These symbols are readings, not arrow-key
bindings or controls. Exact junction characters and engine-operation assembly
are conforming local mechanics; preserve the stated hierarchy.

Schematic only, showing selection at checkpoint 3 and a paused head. Spacing
here is illustrative, not a measured frame or a final narrow-profile artifact:

```text
History · recorded order                     HEAD · EXPANSION PAUSED
Entry 1              Entry 2                 ◆ SELECTED · 3
┃       ◆            ┃
╂──┬────╪──┬─────────╂──┬───────────────────┤
   │       │            │                  ▼
```

The selection caption is `◆ SELECTED · N`, where N is the selected marker's
one-based ordinal in the accepted full checkpoint list. This is checkpoint
order, not an entry number or elapsed time. At the live route it reads
`SELECTED · HEAD`, with no earlier-selection diamond. Entry captions are
`Entry N`, derived from retained entry checkpoints in admission order.

When a selected checkpoint and head share a column, keep `◆` in row 3 and `▼`
in row 5. Never replace them with a combined symbol or hide one. If an entry
tick or minor stem shares that column, the distinctive selection/head symbols
take their respective rows; the boundary remains represented on the rail and
in the exact-selection drawer. Detailed collision grouping is the next item.

With no retained checkpoints, show `No recorded checkpoints` in row 2 and draw
no fabricated ticks or selectable position. The accepted head label can still
describe actual work before its first retained checkpoint. There is no selected
ordinal in this case. Empty visual rows remain inside the same five-row band.

All three profiles keep this row organization. The contextual action row and
draft retain their existing positions, making seven footer rows in total.
No horizontal input, scrolling rail, scrubbing or new target is introduced.
Colours and detailed grouping follow in subsequent presentation decisions.

**Decision.** The Product Owner accepts the five-row placement, selected diamond
above the rail and head marker below it. Their separate rows preserve both when
they share a column. Selection captions use the full-list checkpoint ordinal;
live selection reads SELECTED · HEAD.

## Item 4: collisions and grouping

**Current.** Existing History grouping combines labels across a five-row text
budget. The accepted rail instead places recorded-order marks in one measured
horizontal region. Many checkpoints can share a terminal column, and entry
captions can collide even before the marks do.

**Intent.** Preserve the recorded sequence and exact selection at narrow width
without forcing every checkpoint to have its own visible column.

**Accepted.** Place checkpoint ordinals evenly across the available
engine-measured rail columns, with the first at the start and last at the head.
With one checkpoint, place it at the head. Checkpoints assigned the same column
form one visual group, containing consecutive ordinals in retained order.
Grouping changes presentation only: retain every exact marker and its kind.
Do not group by component name, outcome, elapsed duration or source location.

Use a short minor notch for a single minor checkpoint and a heavier notch for
multiple checkpoints in that column: `┬`/`│` versus `┳`/`┃`. A group containing
an entry keeps the tall entry boundary and uses a heavier rail junction for the
group. Exact junction assembly stays local, but a populated group must be
visibly distinguishable from one ordinary minor mark. An entry/minor collision
preserves the tall entry boundary and a below-rail minor stem where the head
marker does not occupy that row.

Entry captions retain Entry N. Merge overlapping adjacent entry captions into
one range, such as `Entry 1–3`, until the measured captions fit their rail
region. A range names actual consecutive entry ordinals, not checkpoint
ordinals. Do not clip a caption into a different number or cover the fixed
right-hand head/selection captions. The Planner supplies the concrete
deterministic placement and grouping method against engine measurements.

Selection keeps its exact ordinal in `◆ SELECTED · N` even when its rail column
contains several checkpoints. Keep its diamond above the rail, with precedence
over the entry upriser in that cell. Keep the head marker below the rail, with
precedence over a minor stem. A shared column never combines head and selection
into one symbol. The group's retained identities and entry caption preserve
the boundary when a distinctive indicator occupies its upriser or stem.

For example, checkpoints 41, 42 and 43 may share a grouped notch. Selecting 42
shows its diamond at that column and the caption ◆ SELECTED · 42. The History
drawer still has three separate rows and actions for those three exact markers.
The rail group itself acquires no input target or selection action.

The History drawer uses the complete accepted marker list, in retained order,
with one independently selectable row per marker. Ordinals distinguish repeated
checkpoint kinds. Its existing measured window and PR 2's ↑ earlier / ↓ later
controls make all rows reachable. Generic category wording is a subsequent
presentation item; future binding names, values and Agent outcomes stay excluded.

Resize rebuilds placement from the same identities and the new measured region.
It preserves the selected marker, drawer focus under established window rules,
draft and route. New recorded checkpoints may change proportional placement;
a head-state-only change does not. Returning to a former size and the same
snapshot reproduces the same groups. No horizontal scrolling or new navigation
mode is introduced.

**Decision.** The Product Owner accepts visual grouping, heavier crowded
notches, tall entry boundaries, merged entry captions and exact selection
ordinals. Every marker remains separately selectable in the History drawer.
Resize recalculates groups while preserving selected marker identity.

## Item 5: rail colour treatment

**Current.** The older reference uses a near-black History surface, bright entry
ticks, cyan minor marks, amber selection and muted later marks. Its live head
is cyan; its settled head is green with a success checkmark. The accepted
terminal head state settled includes failure and cancellation, so its colour
must remain neutral.

**Intent.** Preserve the reference's colour hierarchy and show the selected
prefix against later recorded navigation marks, independently of focus.

**Accepted literal colours.**

| Reading | RGB hex |
| --- | --- |
| History surface | #08090b |
| Horizontal rail | #141a1f |
| History title | #8b959c |
| Entry caption at or before selection, or at live head | #b8c4cc |
| Entry tick at or before selection, or at live head | #e6ecf1 |
| Minor mark at or before selection, or at live head | #7fd3e8 |
| Later entry tick and caption during inspection | #5d666e |
| Later minor mark during inspection | #4e565d |
| Selected diamond, selected rail junction and ordinal caption | #c9a86a |
| Live head marker and HEAD · LIVE label | #7fd3e8 |
| Empty, pausing, paused, settling, settled or unfinished head marker/label | #7b858d |
| SELECTED · HEAD and No recorded checkpoints | #7b858d |

These literals come from the older Band's surface, rail, labels, ticks,
selection and dimmed marks. The neutral settled head is the consequential
adaptation: it carries no green success cue and no checkmark. Pausing and
paused remain muted like the reference's paused head; their accepted wording
states the real expansion behavior. Head state does not recolour the whole
recorded rail or animate progress.

During inspection, later means a checkpoint ordinal after the selected marker,
not an unrecorded future event. Those marks remain navigation only. In a visual
group, colour the entry tick/caption as earlier if any represented entry is at
or before selection; otherwise use the later-entry colour. Apply the equivalent
rule separately to minor marks. A group spanning the boundary does not imply
every represented checkpoint belongs to the prefix. Exact ordinal selection
and the drawer retain that distinction.

Selection takes precedence at its diamond, rail junction and caption. Head
takes its own state colour below the rail; sharing a column never turns its
marker amber or hides it. Entry captions merged across the selected boundary
use the earlier-caption colour, with the exact selected ordinal still stated
at right. Keep existing drawer focus and selected-row cues from PR 1, with no
global focus colour replacing History semantics.

Keep the literal colour expectations independent of production constants in
the Planner's derived evidence. The palette does not create new checkpoints,
timestamps, outcomes, animation state or input targets.

**Decision.** The Product Owner accepts the colour treatment after viewing the
[colour study](visuals/history-colours.html), which shows the exact literals
on the History surface, with illustrative marks and head-state samples. It is
an interview aid, not engine-measured terminal evidence. The accepted colours
include neutral non-live head states, distinct amber selection and dimmed later
recorded marks during inspection.

## Item 6: exact-selection drawer wording

**Current.** History rows use the retained checkpoint label. Those labels can
include component names, binding names or Agent outcomes. The accepted full
navigation list carries only marker and kind, including after the selected
prefix. It cannot supply those original labels.

**Intent.** Let a reader choose an exact checkpoint, including a later one or a
member of a crowded rail group, using its number and recorded category.

**Accepted wording.** Prefix every row with its one-based ordinal in the full
checkpoint list, followed by the category below. The ordinal is the same N as
the rail's SELECTED caption. Entry E counts admitted entries separately.

| Existing checkpoint kind | Exact row wording |
| --- | --- |
| entry | N · Entry E admitted |
| scope | N · Component admitted |
| binding | N · Bindings recorded |
| generated | N · Generated XMD admitted |
| elicit | N · Answer recorded |
| agent | N · Agent turn recorded |
| terminal | N · Entry outcome recorded |

For example, `42 · Bindings recorded` and `43 · Bindings recorded` are separate
rows with separate marker actions, even if they share a grouped rail notch.
Selecting one projects exactly that marker; the root adopts the prefix or
reports the existing navigation refusal. A row names no binding, component,
question, prompt, answer value, rendered output or outcome detail.

Entry outcome recorded names the retained root close. It does not claim the
session-owned task has completed cleanup; the accepted History head remains
SETTLING until that boundary completes. Component admitted likewise describes
the retained admission, not a full invocation finishing. Answer recorded follows
the projector's successful answered-question checkpoint, not a pending live wait.

Use these same category labels at live and historical routes. Do not substitute
the original richer labels at the live route and then change a focused row's
reading during inspection. Preserve marker-based keys, existing selection/focus
cues and the drawer title History. No additional hint or legend row consumes
its measured content window. Earlier/later controls retain the accepted arrow
labels and semantic actions. Exact rows outside the admitted window remain
absent from mounted nodes, frame targets and Tab stops.

**Decision.** The Product Owner accepts all seven numbered, category-only
labels. Checkpoint numbering matches the rail; entry numbering is separate.
Each row retains its own exact marker action, including grouped checkpoints.
Entry outcome recorded describes the retained root close without claiming
that owned cleanup has finished.

## Verification and handoff

The navigation boundary is complete. Resume the main presentation interview.
The REPL specification excludes live status from the frozen action row; the
accepted head member has separate History-band reachability.
Source, bindings, rendered output, questions, permissions, Agent content and
lifecycle overlays stay selected-prefix readings under the accepted PR 2
contract.

Head labels, rail placement, grouping, colour and drawer wording are settled.
Every grouped marker
remains individually selectable in the History drawer. Engine measurements
own terminal placement; a character-count layout must not bypass admission.

The accepted [PR 3 verification journey](pr3-product-verification.md) carries
these contracts into observable behavior. The ready
[Planner handoff](pr3-planner-handoff.md) consolidates the contracts and freezes
the structural review checklist. The Planner owns the finite
gallery, focused tests and controls, including the complete-story comparison.
No production changes, persistence changes, implementation verdict or GitHub
mutation is issued by this record.
