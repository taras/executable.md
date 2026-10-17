# Architect review prompt

**Architecture decisions complete.** The accepted interfaces, presentation and
verification journeys are consolidated in the ready
[PR 2](pr2-planner-handoff.md) and [PR 3](pr3-planner-handoff.md) Planner handoffs.
This record does not report an implementation verdict for either slice.

The Planner has now frozen [PR 2 implementation](pr2-implementation-handoff.md),
[PR 3 implementation](pr3-implementation-handoff.md) and the
[final gallery](final-gallery-matrix.md). Those replace the older implementation
proposal and provisional scene mapping as acceptance evidence. The accepted
architecture contracts and structural checklists remain unchanged.

Finalize the later slices of #881's original Terminal Interface parity. PR 1
is approved and start-ready under [pr1-handoff.md](pr1-handoff.md); its private
token types/helpers need no further architecture ruling. The
Planner has produced a fresh [gap inventory](assessment.md),
[71-pair baseline gallery](comparison.html) and
[finite product comparison proposal](comparison-matrix.md). The intended base is
`e68f128121cd802623ab7797a016b0c66ce91176`; the captured production at
`2d719f78025059158a35023701fdff52b855a65b` is byte-identical.

Apply `.agents/architect.md`, architecture-rules.md, product-interface.md and
product-verification.md. Read the complete architecture and governing REPL/XMD
contracts. Draft product verification, interview the Product Owner about the
unresolved behavior one item at a time, and return explicit rulings. Do not ask
the Implementor to discover these choices while coding.

## 1. Middleware observes the complete live invocation

The Product Owner has settled the authority: execution middleware feeds a
session-owned live lifecycle view. The Journal supplies retained history. It
does not decide whether a component is currently ACTIVE or WAITING. Missing
observation boundaries are addressed without adding persistence; original UI
parity remains the scope.

The exact API is now accepted in
[pr2-invocation-contract.md](pr2-invocation-contract.md), which governs this
boundary. Static source inspection and generated-source presentation are also
accepted. [pr2-planner-handoff.md](pr2-planner-handoff.md) consolidates PR 2's
contracts. History is accepted in
[pr3-history-contract.md](pr3-history-contract.md) and consolidated in the ready
[pr3-planner-handoff.md](pr3-planner-handoff.md).

The original reference shows ▶ ENTER, ● ACTIVE, ● WAITING, ◀ EXIT,
✓ SETTLED and × FAILED on nested executable occurrences. Keep this live reading
separate from the projector's admitted entry/component/generated source regions.
Those retained regions help locate source; they are not invocation lifetimes.

### Current observation boundaries

`Component.importComponent` observes resolution. Returning a definition says
that resolution finished, not that its body, projected content, generated work,
result validation, binding or teardown finished. Wrapping a returned definition
also misses failures before the body and is not a complete invocation boundary.

`Execution.document` brackets the document walk. `Component.content` and
`tryContent` bracket requested content, and `Elicitation.elicit` observes an
actual unanswered question. The REPL's Agent bridge observes active Prompts and
pending `Agent.requestPermission` calls. The expansion controller owns real
pause holds. These are useful boundaries, but none alone brackets every
component invocation.

Core's `expandComponent` resolves and validates a named occurrence before
dispatching its Markdown or function body. Both use `withInvocation`, which
joins projected content, then body resources, then persistent resources.
Function failure handling runs after that teardown; Markdown/function result
acceptance and bindings also occur outside the body itself. The new observation
boundary must cover this complete path, including early resolution/validation
failure and cancellation. Observing only the generator body's return is too
short.

Keep `Execution.document` as the outer live execution anchor, not a substitute
for child invocation spans. Engine-handled structural occurrences used by the
original journey, such as `Switch`, bypass `importComponent`/`expandComponent`;
name their equivalent complete expansion boundary and observe it through the
same focused contract. Do not silently omit their children or invent import
events for them.

### Proposed state-to-boundary map

| State | Middleware observation boundary | Completion and recovery |
| --- | --- | --- |
| ▶ ENTER | Core begins a named invocation occurrence, before its resolution and validation. Middleware receives the frozen Expansion description; the REPL owns private call keys and nesting. | Resolution completion advances preparation; it does not close the occurrence. An early refusal is an invocation failure with its actual stage. |
| ● ACTIVE | Core reaches the accepted body and delegates its execution inside the complete invocation boundary. | Remains open through nested content and generated expansion. Resuming a resolved wait returns to ACTIVE only while the invocation still owns ongoing work. |
| ● WAITING | Middleware brackets an actual pending `Elicitation.elicit`, Agent permission request or owned expansion hold, attributed to its invocation. | Closing a drawer is not answering the wait. Release removes that wait reason; the invocation becomes ACTIVE only when no other relevant wait remains. Ordinary generator suspension or an in-flight import/Prompt alone does not mean a human is being asked. |
| ◀ EXIT | Core reports that body work has returned, failed or been cancelled and invocation teardown begins. | Keep EXIT through ordered content/body/persistent teardown and subsequent result acceptance. Carry the exit reason. Do not report SETTLED while a destructor is still running. |
| ✓ SETTLED | The complete invocation boundary reports accepted success after teardown, return validation and any result binding. | Ends this live occurrence once. A later Journal append is not its completion signal. |
| × FAILED | The complete boundary reports canonical invocation failure, including resolution/prop refusal, body failure, failed result validation, unrecovered content failure or teardown failure. | Preserve the failure's stage and canonical cause; report the final badge after unwind completes. Printed failure can return normally, so middleware must observe the canonical semantic outcome, not merely whether `next()` threw. |
| Cancellation | The complete boundary reports cancellation and its unwind: EXIT with reason `cancelled`, then the existing textual cancelled outcome after teardown. | Clear every wait and active occurrence once. Cancellation is not successful SETTLED or FAILED merely because no value returned. A cleanup failure follows Core's actual failure precedence and is reported as such. |

ENTER/EXIT are event-backed phases, not promises of a minimum animation time.
Do not delay execution so a frame can catch them. Subscriptions begin with the
latest phase; the session may retain completed live badges. That snapshot is
process-local and never becomes reconstructed history.

### Session ownership and separation

Install lifecycle middleware before the session starts entry execution, in the
same owned execution lineage as its existing Elicitation, Agent and expansion
adapters. Core supplies the Expansion id/name/position; the REPL allocates
session-local call keys and binds the enclosing presentation key around
delegation. These distinguish repeated or concurrent calls and entries. The observer stores
only presentation observations and publishes detached immutable snapshots to
the root. It owns no invocation, authority, provider, resource or terminal reader.
Core continues to own execution, failure disposition and teardown.

Track wait reasons per occurrence, not one session-wide boolean. Concurrent
waits cannot erase one another. An ancestor can display that it waits on a
particular descendant, while the child keeps its own state; it does not acquire
the child's failure or outcome automatically. Observe child work actually owned
by the invocation, rather than assuming caller-retained resources end when its
body returns.

Live middleware observations are neither Journal records nor `ReplModel` fields.
They may support the current session's completed badges, but a cold reader
cannot reconstruct those observations. It displays only retained source,
admissions, answers and entry outcomes actually available in the Journal.
Absence of a component close record is neither ACTIVE nor WAITING.

During history inspection, source/bindings/output and lifecycle content in the
inspected panes come only from the selected retained prefix. Suppress the live
lifecycle overlay there, including live questions, permissions and active
badges. The running session continues observing offscreen. Returning live uses
its latest snapshot, not the snapshot from when inspection began. Any head
navigation summary remains explicitly separate, as described in section 3.

### Address the missing boundary without persistence

Specify a focused contextual middleware seam around Core's complete invocation
and its ordered phases/outcome. Cover Markdown and function components,
including value/captured invocations and generated descendants. Reuse the
existing invocation machinery and existing wait operations; do not expand this
into a general tracing system. Export any necessary consumer-facing contextual
API/types through Core's `/api`, under the repository's existing API rules.

The seam delegates the canonical continuation without substituting a definition,
overriding a result, swallowing a failure or changing error disposition. Identity,
authorization and final settlement remain Core's closure-owned facts, not
replaceable observer context. Observation adds no durable records, timestamps,
sidecar, replay protocol or provider activity. It must leave Journal bytes and
execution outcomes unchanged with observation installed or absent.

Register observer cleanup before entering the observed operation. Let canonical
teardown finish before publishing the final outcome. Session shutdown joins its
owned execution/observers and leaves no active/waiting entry or late publication.
Never yield in `finally`, infer completion from an import return or use an
unregistered post-acquisition destructor.

Use the accepted seam, phase/outcome types, installation path and parent/wait
attribution in [pr2-invocation-contract.md](pr2-invocation-contract.md).
Freeze the remaining product verification and visual evidence with the source
presentation contract; do not reopen the persistence question.

### Required lifecycle evidence

Use one real nested fixture with two siblings and a generated child. Hold a
component after import resolution to show it remains open; hold an Elicit and
a permission request to show WAITING until their actual resolution. Include
overlapping waits, a recovered child failure and an unrecovered failure so the
observer cannot propagate every child outcome to its parent indiscriminately.

Exercise early resolution/validation refusal, returned printed failure, body
failure, slow teardown, teardown failure and cancellation while waiting. Assert
one terminal outcome after owned cleanup, no active/waiting leak and unchanged
canonical failure precedence. Cancel a session while an observer is installed
to verify its own lifetime.

Inspect a retained prefix while the live execution changes, then return live:
historical panes stay unchanged while the live snapshot advances. Cold inspection
installs no execution observation and makes no provider call. A Journal containing
the same admissions without a live observer cannot manufacture active/waiting
badges. Keep Journal-byte equivalence between observed and unobserved runs.

Output ownership is accepted in pr2-source-presentation.md: the entry-rendered
result stays with the entry; retained block output stays with its recorded source
owner. The lifecycle Result carries no rendered value. Retained output is limited
to the selected prefix. No persistence is required to decide what is active now.

## 2. Generated replacement and readable transcript

`generated_xmd` retains admitted source and the producing source position.
`ReplPosition` distinguishes a path from a generated-source owner. Yet
`application.ts` currently describes generated admission as a transcript row
and selects an entry-wide flat transcript regardless of the nested source
selection. Many effect summaries precede the generated source and final README.

The paired source reading is accepted in
[pr2-source-presentation.md](pr2-source-presentation.md): successful admission
replaces Evaluate's inner producer content while preserving its opening/closing
tags and enclosure. Original source and Journal bytes remain unchanged; an
earlier prefix still shows the producer. The self-closing adaptation is also
accepted: keep its authored row and place admitted source directly beneath it.
Soft wrapping and vertical windows are accepted, with `[↑ earlier]` / `[↓ later]`
labels throughout. Lifecycle glyphs and words use an accepted shared right-aligned
status column, with source rails on the left and source wrapping in the remaining
width. Entry Output precedes Source; nested source readings display only output
with an established narrower owner. These presentation choices are accepted.
A private display
projection may weave retained source together; it may not execute it.

Preserve readable access to every source/output character through soft wrapping
and measured vertical windows. Source previews follow the same policy within
their existing drawer window; metadata keeps its existing fitting rules.
No hand-calculated screen positions or multiline editor are proposed. Refuse
ambiguous ownership instead of attaching source/output to a guessed sibling.

The exact read-only source inspection boundary is accepted in
[pr2-source-inspection.md](pr2-source-inspection.md). Keep it separate from live
middleware; do not introduce a second CLI parser, load component source during
cold inspection or expand the accepted observation request with unrelated
source parsing. The main verification journey is accepted in
[pr2-product-verification.md](pr2-product-verification.md).
The ready [PR 2 Planner handoff](pr2-planner-handoff.md) consolidates these
contracts and freezes the structural checklist. Concrete implementation and
evidence remain the Planner's responsibility.

## 3. History: current head versus inspected prefix

The original reference's rail shows the recorded head and the earlier selected
checkpoint separately. Current `ReplCheckpoint` contains marker/kind/label,
with no timestamp. Inspecting a checkpoint projects a prefix, so its model
cannot describe the later known head. The captured tokens inspection illustrates
this loss of relationship.

Accepted recorded-order adaptation: space marks by retained checkpoint
order, label the band `History · recorded order`, use tall entry boundaries and
short semantic marks, and draw the head and inspected-selection indicators
separately. Do not display invented elapsed time or animation percentages as
retained facts. The existing History drawer remains the exact-selection control;
the rail has no pointer/input targets and adds no scrubbing or fork capability.

Accepted navigation boundary: the root supplies a private immutable summary
with all retained checkpoint identities/kinds and the overall head state.
The marker list reaches only History's band and exact-selection drawer; head
state reaches only the band. Source, bindings, result and Agent content in
inspected panes still come only from the selected prefix. The frozen action
row retains its History reading. Both readings come from one validated retained
snapshot, with actual session-owned task/controller facts for head state.

Five-row placement is accepted: title/head label, entry/selection captions,
entry uprisers and selected diamond, horizontal rail, then minor stems and
the head marker. Keep selection above and head below the rail, including when
they share a column. Collision grouping is accepted: crowded marks use heavier
notches, entry captions merge into ranges, and the selected ordinal stays exact.
Every grouped checkpoint stays separately selectable in the existing drawer.
Resize preserves selected marker identity. The five History rows and seven-row footer
are fixed. Head state distinguishes empty, live, pausing, paused, settling,
settled and unfinished. Settled includes failure and cancellation; a cold
historical reading does not invent a paused execution. The Product Owner accepts
HEAD · EMPTY, HEAD · LIVE, HEAD · PAUSING EXPANSION, HEAD · EXPANSION PAUSED,
HEAD · SETTLING, HEAD · SETTLED and HEAD · UNFINISHED at all three profiles.

The Product Owner accepts recorded-order spacing and the major/minor hierarchy.
The two-member navigation boundary interview is in
[pr3-history-contract.md](pr3-history-contract.md). Both members are accepted;
head wording, five-row placement and generic drawer wording are accepted.
Collision grouping and the reference
colour treatment are accepted, including neutral non-live head states and
dimmed later recorded marks. The colour study is an interview aid, not a
production capture or visual implementation verdict. All PR 3 interface,
presentation and [verification journey](pr3-product-verification.md) decisions
are accepted. The [Planner handoff](pr3-planner-handoff.md) is ready.

## 4. Approved private token-run approach

The installed `@bomb.sh/tty@0.9.0` accepts multiple `text()` operations with
different colours in one element. The [probe](evidence/tty-probe.jsonl) writes
`<Plan as="draft">` contiguously with the original literal colours and no engine
errors. Token colouring does not require extra Freedom nodes, a new renderer or
a dependency upgrade.

Approved ownership: the application supplies immutable structural runs containing
text and semantic role. The private presentation module maps roles to engine
styles. The admitted layout emits the runs in the existing keyed element. Both
measurement and commit use the same builder. The renderer remains model-blind.
Selection stays a surface; focus adds its existing textual marker/weight and
does not overwrite token/lifecycle foregrounds. No ANSI strings or runtime
detection enter shared view data.

A conservative private lexical highlighter preserves every
source character and uses ordinary source style where a partial draft cannot
be classified. It validates nothing, evaluates nothing and does not introduce
another XMD language contract. JSON presentation starts from the model's parsed
JSON value. The Product Owner approves this approach under the existing
architecture rules; exact local types and helpers remain implementation
decisions. PR 1's frozen colours, examples and evidence are in its handoff.

## Product review and return contract

Settle the later-slice scene mapping and adaptations in comparison-matrix.md.
PR 1's surface-only comparisons are frozen separately. Existing
rules already settle narrow routing, footer size, integer drawer placement,
explicit activation, location absence, single-row draft, keyboard/pointer
equivalence and Freedom focus ownership. Do not ask to approve them again.

Accepted adaptations include ordinal History geometry and cell-based rails,
source/output wrapping and windows, right-aligned lifecycle words and the exact
head/drawer captions. The ready handoffs carry these examples and decisions.
Record adjacent `granted: … — Decline` wording separately; no permission-semantics
expansion is implicit.

The ready handoffs return for PRs 2 and 3: approved product verification; each decision and its authority; exact
architecture/spec amendments; the complete-invocation observation seam and
session-owned live view; accepted private run/head-summary boundaries; and the
resulting plan changes. Keep the settled middleware authority and absence of new
persistence explicit. The Planner then freezes their lower-level evidence and
writes their separate Implementor handoffs. No production edit, commit, GitHub mutation, CI dispatch or
weights measurement is requested by this prompt.
