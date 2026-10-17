# PR 2 implementation handoff: follow execution and read its result

**Frozen; ready for implementation.** Show an entry's rendered Output before
its Source. Source carries nested rails and independently observed live phases
in a stable right-hand column. Admitted generated XMD occupies its Evaluate
enclosure. Wrapped content and its tail remain reachable at every supported
profile. This slice does not implement the new History rail.

The Product Owner accepts the contracts consolidated in
[pr2-planner-handoff.md](pr2-planner-handoff.md). This implementation plan freezes
ordinary mechanics and evidence against those decisions. The
[stack and evidence rules](stack-and-evidence.md) and
[44-pair PR 2 gallery](final-gallery-matrix.md) are part of this handoff.
There is no production verdict or completed test claim here.

## Base, scope and ownership

Start PR 2 from accepted PR 1
080b6ec80ca74e614789e8d2252857ac281df7e5 and integrate main
4c0414be1010f69f11bff0d1d634623a5b08f886 as specified in the shared stack record.
Record the resulting base SHA. Preserve PR 1's token runs, independent reference
fixture, focus cue, surfaces and drawer rule. Use the current `entries` route and
owner-level Interrupt behavior. Prepare a new worktree with deno task setup.

Core owns execution, results, binding acceptance and failure precedence. Its
middleware supplies observations. The session owns the live view and its
consumers. The Journal supplies retained source/output/history only. The root
combines immutable readings for the selected route and passes them directly to
children. Typed actions return to the root; Freedom owns focus; one prepared
reading owns visible rows and their mounted targets. Renderer input stays ops.

No Journal format, sidecar, timestamps, general tracing, dependency/vendor
change, extra terminal reader, provider during inspection, automatic drawer,
new schema/editor, fork or newer reference feature belongs here. PR 3 owns full
History navigation and rail geometry. Existing History actions are used for
PR 2's prefix checks. Do not publish PR 3 behavior in this slice's specifications.

## 1. Surround the complete canonical invocation

Add this exact member and types in packages/core/src/component-api.ts. Export
Component and consumer-facing request/phase/Expansion types from
packages/core/api.ts; preserve existing packages/core/mod.ts exports.
Operation, Stream and Result are Effection types.

```ts
interface ComponentApi {
  expand(request: ComponentExpansionRequest): Operation<void>;
}
interface ComponentExpansionRequest {
  readonly expansion: Expansion;
  readonly phases: Stream<ComponentExpansionPhase, void>;
}
type ComponentExpansionPhase =
  | { readonly phase: "enter" }
  | { readonly phase: "active" }
  | { readonly phase: "exit"; readonly reason: "returned" | "failed" | "cancelled" }
  | { readonly phase: "complete"; readonly result: Result<void> }
  | { readonly phase: "cancelled" };
```

Expansion keeps its existing frozen id/name/optional SourcePosition meanings.
It describes a logical source element, not a unique process call or capability.
No process key, parent or rendered value is added to it.

Implement occurrence-specific dispatch in component-api.ts and expand.ts using
the Execution.document/importThroughTerminal pattern. A private terminal closes
over the issued request, a once-only delegation guard and the canonical result.
Only exact next(request) delegates work. Copied, foreign, omitted and repeated
requests refuse; an outside Component.operations.expand call refuses unissued
work. Ignore middleware return values. Reconcile a handler refusal/failure with
the canonical outcome through the existing policy-failure pattern: it may refuse
work or fail success, but cannot rescue canonical failure or replace durability/
Files fatal precedence. Do not trust a replaceable context for that authority.

Place dispatch before expandComponent's cycle/depth, resolution and props
checks, rather than around importComponent alone. Use the equivalent element
dispatch for structural work in expandSegments, expandSwitch, selected Case,
selected Else, All/Spawn and executed declared structural regions. Preserve
their current source/structural path and scopes. Actually executed consumed
regions get one boundary; passive syntax, unselected branches and restored work
get none. Code blocks remain within their containing element. Do not wrap the
same work at both its structural caller and consumed-region implementation.

Use invocation.ts's existing ordered content/body/eval teardown; do not replace
its owner or create resource scopes for structural syntax. In Markdown,
function and value/captured paths, publish ACTIVE where accepted work starts.
Publish EXIT when that work ends, before owned cleanup and return/binding
acceptance. An early preparation refusal has ENTER then EXIT, with no ACTIVE.
Body return alone never supplies SETTLED. A returned EXIT can complete with an
error after validation or cleanup. Recovery of a child failure does not itself
fail the parent.

Publish COMPLETE only after the entire middleware dispatch has unwound and
canonical acceptance is reconciled. This includes middleware cleanup outside
the terminal. Keep the outgoing result/binding candidate private until that
reconciliation; middleware cannot publish or validate it on Core's behalf.
Preserve already-performed effects and existing canonical failure disposition;
this adds no rollback protocol. Success is Ok(undefined); failure is Err of a
detached reporting
Error preserving selected name/message and explanatory Error causes. Keep
canonical error identities and arbitrary resource objects private. Freeze all
published observations. Clean cancellation publishes CANCELLED after unwind;
an actual cleanup failure instead publishes failed COMPLETE. Exactly one
terminal phase is followed by stream closure with void. Preserve printed
semantic failure, body/teardown cause accounting, caller-retained resources and
existing failure/recovery behavior. No minimum phase animation delay exists.

The stream registers each scope-owned subscriber atomically with its latest
phase, then queues ordered updates independently. A late terminal subscriber
gets that terminal observation and completion, without earlier replay. Reading
or cancelling a subscription neither invokes nor cancels work. Absence or
slowness of readers never blocks execution or waits for a frame.

Verification: C1–C4 below discriminate dispatch, phase timing, authority and
subscription behavior with real invocation and cleanup gates.

## 2. Expose static source boundaries without execution

Add a pure packages/core/src/source-inspection.ts helper, exported from Core's
root mod.ts with these exact shapes. Reuse/export existing SourceRange; do not
change document-target coordinates.

```ts
function inspectSource(text: string, kind: "document" | "fragment"):
  Result<readonly SourceElement[]>;
interface SourceElement {
  readonly name: string;
  readonly opening: SourceRange;
  readonly closing?: SourceRange;
}
interface SourceRange { readonly start: number; readonly end: number; }
```

Extend scanner.ts's successful parseComponentTag/parseChildren result collection
where opening and matching closing delimiters are recognized. Commit a nested
collector only if its enclosing parse succeeds, so an incomplete passive tag
cannot leave guessed children. Keep scanComponentSpans's top-level heading
masking behavior equivalent. Preserve scanner handling of quotes, expressions,
fences and inline code; there is no CLI parser or delimiter search after parsing.
Return every recognized nested element in opening order, recursively frozen.
Paired empty content still has closing; exactly self-closing syntax lacks it.
Ranges are half-open UTF-16 slices into the exact input, including a document
header prefix. Name preserves authored dotted spelling and says nothing about
resolution or permission. Passive/incomplete text and empty lists are success;
scanner refusals become Error Results.

Document inspection needs a private lexical envelope boundary beside
definition.ts's parseSource. Match the installed gray-matter envelope extraction
without calling its value parser: account for BOM, leading `---` except `----`,
its first newline closing delimiter, absent closing delimiter, optional header
language and the following CR/LF removal. Preserve the verbatim body suffix and
its original offset. Fragment scanning uses the entire input. Share this body
boundary with definition parsing and assert equivalence to its existing suffix;
execution continues to interpret declarations exactly as before. Do not call
parseMarkdownDefinition, compile schemas, evaluate props or a frontmatter engine
from inspection. C5 covers safe envelope equivalence and an executable-header
sentinel proving no evaluator ran.

## 3. Feed a session-owned live reading

Add a private lifecycle module under packages/cli/src/repl/ and install its
Component middleware in session.ts before the entry can start. Each actual call
gets an entry-owned private occurrence key. Bind the enclosing presentation key
around next(request), following expansion.ts's CurrentWalk composition. Generated
descendants inherit this presentation lineage while their capability environment
remains narrowed. Repeated logical ids never overwrite an occurrence. Context
supplies presentation only, never authorization or durable identity.

Subscribe before starting its consumer. Run consumers under the captured entry
owner as siblings of dispatch, not children whose join blocks handler return.
Core publishes terminal phases after handlers unwind, so waiting for that phase
inside the handler's own destructor would deadlock. Keep consumers until their
terminal observation or entry shutdown. Failure follows their actual Effection
owner. Cancellation joins owned execution/consumers and clears waits; a closed
entry generation rejects late updates rather than reviving removed live data.

WAITING overlays counted reasons: actual Elicitation requests, permissions
attributed through the bridge's actual turn owner, and expansion controller
holds. Each resolves/removes itself. Close/reopen of a drawer changes no wait.
Ordinary suspension, resolution and Prompt activity alone are not waits.
A cleanup wait retains EXIT and WAITING together. Snapshots are detached,
immutable and outside ReplModel. Completed process observations may remain in
the live snapshot until entry removal; cold reads reconstruct none.

In expansion.ts classify Component.expand as a **gate**, not a new walk. Gate
before delegation using the inherited CurrentWalk; retain existing document,
content, tryContent and declared structural walk owners. Update the complete
COMPONENT_BOUNDARIES inventory and its test. Structural work now crosses the
new seam without duplicating invocation observations or releasing holds twice.

Move session.live's final false transition from runEntry's return/catch to the
entry's first-registered, last-running release finalizer in begin(). All work,
output consumers and the Agent attachment release before that transition.
Preserve the settled-only rule for freeing the submission slot: cancelled or
refused work does not become submittable merely because its active task ended.
Publish the completion wake on the existing session changes path even when no
Journal append or input occurs. This existing private liveness fact also supplies
PR 3's head reading. Do not conflate it with a retained root Close or merely the
execution Future returning. Verify attachment/consumer release order in addition
to the held execution-installation cleanup.

In program.ts and application.ts pass the live reading down the existing view
path, and suppress lifecycle, question, permission, Agent and emitted-output
overlays whenever route.at is historical. Observe offscreen work continuously;
return live takes the latest session snapshot. L1–L3 verify ownership and waits.

## 4. Prepare Source and Output as one measured reading

Use a private source-reading helper beside presentation-text.ts. Start from the
selected retained source owner/kind and inspectSource ranges. For a successful
generated admission, match exactly one Evaluate opening at its canonical
recorded position in that known owner. Paired replacement substitutes only
opening.end..closing.start, keeping exact enclosure bytes. A self-closing
Evaluate keeps its row and receives a connected child region underneath. Before
admission the producer remains; refused, missing or ambiguous ownership follows
existing projection refusal, never a name/sibling guess. Keep each generated
region's original identity and offsets. Replacing display text never rewrites
submitted source or Journal records.

Derive nesting from canonical interval containment. Rails continue from opening
through closing, including wrapped rows and generated children. Attach actual
occurrences by entry, lineage and source position. Static elements have rails
without invented phases. Repeated calls receive separate readings in their
owned source group. All lifecycle glyphs/words align at the measured source
pane's right inner edge; only the first visual row carries each badge.
Observed closing EXIT/terminal markers use that same column. Historical rails
remain without live badges.

Start a prepared source segment at each canonical opening/closing tag boundary
as well as each explicit newline. This makes inline nested tags separately
readable in the status column. These display breaks alter no logical source
byte or offset; concatenate segments within each source occurrence to recover
its exact text. A multiline tag's continuation rows still have no second badge.

Use independent original L literals: ▶ ENTER #5aa87c, ● ACTIVE #7fd3e8,
● WAITING #c99a3f, ◀ EXIT #c2766e, ✓ SETTLED #4f8468, × FAILED #d24b3f.
Cancellation keeps existing cancelled wording. Focus adds weight and its cyan
cue without recolouring tokens or these statuses.

For rails, use the original timetravel RAIL literals with the occurrence's actual
reading: active #2f6272, waiting #4a3a1c, exit #5d3c39 and settled #2e3c35.
Static/unobserved source uses pend #252b30; it acquires no phase from retained
syntax. Preserve EXIT's rail during a cleanup wait. Copy these source literals
alongside L in the independent reference fixture and sample them in S1/S2.

An entry reading contains Output then Source within the existing transcript
pane, sharing one vertical window. Running emitted text is `Output · live`.
Retained final root text replaces it once and the label becomes `Output`.
Empty final text reads `No rendered output.` with the actual outcome. A selected
prefix with no entry output reads `No entry output recorded at this checkpoint.`
No later/live text is borrowed. Keep diagnostics/outcomes truthful independently
of words in rendered prose. The first reading position begins with actual
rendered content; newly arriving output does not auto-scroll an existing window.

Nested source may show `Recorded block output` only at its established retained
owner. Entry output is never attributed to an Elicit/File or reconstructed by
concatenating block results. Bound values emitting nothing supply no output;
Agent text remains in its Agent reading. There is no synthesized write receipt
or component rendered value in lifecycle Result<void>.

Apply [the private engine-fit preparation method](planning-measurement.md) in
program.ts's prepareFrame after pane widths are known. Share prepared rows
between application descriptions, layout boxes, row count and admission.
Measure stable rails/status reservations and actual token ops, then wrap all
source, source previews and rendered text at preferred fitting word boundaries,
breaking long tokens at fitting grapheme boundaries. Preserve whitespace,
newlines, blank lines and every character/role. UTF-16 indexes are slice offsets,
not terminal widths. The engine probe already distinguishes wide/combining text.
Do not use PR 1's clipping guard as the new reading's wrapping policy.

Add the main reading to existing process-local windows, keyed by execution,
selected prefix and source/entry reading. Earlier/later controls stay outside
moving content and consume capacity before rows. Clamp after remeasurement on
resize. Windowed-out rows have no node, target or Tab stop. Metadata fitting,
editable fields and the single-row draft retain their existing policy. Change
all Sessions, Entries, drawer and reading control labels to `[↑ earlier]` and
`[↓ later]`, keeping semantic actions and normal activation. No arrow shortcut
or horizontal scroll is introduced. Keep seven footer rows and narrow routing.

S1–S4 and the gallery verify these relationships through committed cells,
normalized actions, source tails and mounted targets.

## Frozen focused evidence

Add component-expansion.test.ts and source-inspection.test.ts in Core tests;
add repl-source-reading.test.ts in CLI tests. Extend named existing regressions
instead of building a second execution/renderer harness.

| ID | Concrete cases and required result | Defect discriminated |
| --- | --- | --- |
| C1 | Markdown, function, value/capture; Switch selected Case, If selected Else, All/Spawn and executed declared region; unselected/restored work absent. Exact request delegates once; counterfeit/copy/repeat/missing/outside refuse. | Incomplete observation, duplicate work or forged execution. |
| C2 | Import returns with body held; body returns with cleanup held; early resolution/props refusal; return validation fails; printed failure; recovered child. Full dispatch middleware cleanup is also held. | Import/body/terminal alone supplies success; parent inherits recovered failure. |
| C3 | Body and teardown failures, clean wait cancellation, cancelled cleanup failure; preserve fatal/cause precedence and reporting detachment. Compare observed/unobserved output, bindings, failure and serialized Journal bytes. | Observation changes execution or exposes canonical mutable errors. |
| C4 | Two readers, slow reader, absent reader, cancelled reader and late terminal reader. Ordered latest registration has no gap, exactly one terminal then void; execution never awaits a frame. | Shared reader, deadlock or lost registration update. |
| C5 | Nested same-name/dotted/empty/self-close tags; quoted `>` and tag-like expressions, fence/inline inert text, CRLF/BOM/non-ASCII/header offsets, passive incomplete tags and canonical refusal. Document versus fragment envelope; executable-header sentinel unchanged. Heading target/execution equivalence. | Second parser, offset drift or inspection execution. |
| L1 | Repeated logical ids and real concurrent siblings; generated descendants keep parent lineage and narrowed capabilities. | Id conflated with process occurrence or generated authority widened. |
| L2 | Concurrent question/permission/hold reasons; resolve one, close/reopen drawer, ordinary Prompt/suspension, EXIT with a cleanup wait. | Session-wide waiting boolean or false waiting. |
| L3 | Entry shutdown/cancellation joins consumers and clears waits; late producer update cannot revive them. Held installation and outer attachment/consumer release precede live=false and ready wake, with no input. | Early readiness, leaked subscriber or dispatch-consumer join deadlock. |
| S1 | Original paired admission, earlier prefix and return live; self-closing Evaluate of a File read; missing/ambiguous admission refuses. | Appended generated text, fabricated pair or wrong owner. |
| S2 | All three profiles: long schema and preview tail, unbroken `x`×160, `界é🙂` and combining accent, explicit blank lines. Concatenated fragments recover logical text and roles; continuations have one owner and no duplicate badge. | Clipping, character-width estimate or colour fallback. |
| S3 | Live/final replacement, empty output, successful prose containing `failed`, bound value emitting nothing and narrower block output. Output first; no auto-window jump. | Fabricated output/outcome or duplicated final result. |
| S4 | Phase-only updates keep source cuts/status width; supported resize and undersized recovery; controls/rows/targets agree; selected-prefix windows and cold start offsets. Journal/provider/source-load counters unchanged in settled cold head and early-prefix opens. | Geometry drift, invisible targets or historical/live leakage. |

Run these exact focused commands from the prepared implementation worktree:

```bash
deno task test packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-journey.test.ts
git diff --check
```

These explicit files cover scanner/generated and owned host boundaries that
import selection alone can miss. Test step counts are reported actual results,
not a guessed acceptance number. Existing assertions stay unless their exact
presentation premise changed; itemize replacements and preserve behavioral
assertions. No full runtime corpus, lint or CI wait precedes the feedback commit.

After the positive feedback revision, run five controls alone: remove rails
(S1/frame geometry fails); remove lifecycle glyph/words (C2/S2 committed reading
fails); append generated source instead of replacing (S1 fails); clip the last
wrapped row (S2 tail fails); rescue a caught canonical failure (C1/C3 fails).
Save each first failure and verify byte restoration. The independent one-bit
palette control returns in the assembled PR 3 evidence, preserving PR 1's own
control record.

## Documentation and handback

Update architecture.md's Component/middleware and private REPL sections,
specs/executable-mdx-spec.md's expansion/invocation contract and specs/repl-spec.md
for implemented observation, output/source, canonical inspection, wrapping and
arrow labels. Use present tense. Preserve recovery, resource ownership and
prefix isolation. State explicitly that observations are ephemeral and static
syntax/retained admission does not prove active execution. Core root versus
/api exports remain distinct. The architecture review uses the seven frozen
checks in pr2-planner-handoff.md; it adds no speculative permutation.

Return the focused commands and their outputs, exact SHA/parent/integrated base,
44 gallery pairs and all review/control/cold evidence under
pr2-evidence/ and pr2-implementation-handback.md. Capture from the unchanged
feedback SHA. Explain any unmet frozen claim instead of declaring complete
#881 parity. Do not push or open a PR without separate authorization.

Continuity: accepted predecessor 080b6ec80ca74e614789e8d2252857ac281df7e5;
main integration input 4c0414be1010f69f11bff0d1d634623a5b08f886. Artifacts:
this handoff, stack-and-evidence.md, planning-measurement.md and the PR 2 portion
of final-gallery-matrix.md. All architecture/product decisions are settled.
**Planning blockers: none.** Next action: prepare and integrate the PR 2 worktree,
then implement the ordered layers above and return focused feedback.
