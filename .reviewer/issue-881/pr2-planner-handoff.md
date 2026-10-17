# PR 2 Planner handoff: nested execution source and rendered output

**Ready for planning.** The Product Owner accepts the invocation middleware,
static source inspection, five presentation decisions and main verification
journey. Prepare a self-contained implementation handoff for this slice of
[Story #881](https://github.com/taras/executable.md/issues/881). Do not send the
Implementor back to choose public API names, lifecycle semantics, source
replacement, wrapping, arrow labels, status placement or output ownership.

This is an architecture/design handoff, not a review verdict on PR 2 code.
No PR 2 implementation, production test run or feedback commit exists in this
record. The Planner derives and freezes its concrete plan, focused commands,
visual cases and negative controls before implementation.

## Outcome and smallest example

An entry's useful rendered result appears in Output before Source. The execution
source shows nested rails and truthful live statuses in a shared right-aligned
column. After admission, generated XMD replaces paired Evaluate's producer
content while preserving its enclosure. Source and output are different readings.

Abbreviated live source example; ellipses here omit attributes for illustration:

```text
│ <Evaluate …>                  ● ACTIVE
│ │ <Plan>                      ● ACTIVE
│ │ │ <Elicit …>                ● WAITING
```

Source wraps in the measured space to the left of the stable status column.
`[↑ earlier]` and `[↓ later]` reach every row at all supported profiles.
The labels also replace the existing caret/letter labels in Sessions, Entries
and drawer windows, preserving their semantic actions.

## Stack and authority

- PR 1 Planner feedback is PASS at **080b6ec80ca74e614789e8d2252857ac281df7e5**.
  Its parent is f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa and its recorded base is
  e68f128121cd802623ab7797a016b0c66ce91176. See pr1-planner-acceptance.md.
  PR 2 depends on that accepted slice; record the actual stack base and refresh
  overlapping changes before implementation. Do not replace PR 1's evidence
  with a claim that later work was already accepted there.
- The architecture workspace HEAD is
  2d719f78025059158a35023701fdff52b855a65b. No current remote-head or CI verdict is
  asserted by this handoff. Merged #876/#877/#878 are the measured-layout,
  reveal-retention and semantic styling foundations.
- Use the older corrected reference archive, SHA-256
  **86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b**,
  retained at evidence/reference.zip. The newer Downloads archive adds a feature
  and supplies no requirement. The old archive owns visual intent; current
  architecture and specifications own execution and interaction.
- Detailed accepted records are pr2-invocation-contract.md,
  pr2-source-inspection.md, pr2-source-presentation.md and
  pr2-product-verification.md. This handoff consolidates their consequential
  contracts. The old full-story matrix is not an additional frozen PR 2 oracle.

Read repository AGENTS.md, the required Effection instructions, architecture.md
and the affected REPL/executable-MDX sections. Reuse installed dependencies,
Freedom, contextual adapters and the model-blind renderer. Preparation belongs
to deno task setup; verification does not reinstall or mutate dependency state.

## Accepted Core invocation interface

Add this member to the existing Component Api and export it with its consumer
types through **@executablemd/core/api**. Preserve existing root exports.
Operation, Stream and Result are Effection types. Expansion is Core's existing
frozen id/name/optional-position description with its meaning unchanged.

```ts
interface ComponentApi {
  /**
   * Surround one executable element's complete expansion.
   * Core issues the request before resolution or validation.
   * Delegate the exact request once; returned values carry no result authority.
   * Completion includes owned teardown and final result acceptance.
   */
  expand(request: ComponentExpansionRequest): Operation<void>;
}

interface ComponentExpansionRequest {
  /** Core's detached description of the element this call surrounds. */
  readonly expansion: Expansion;
  /**
   * Observe the latest phase, then subsequent changes in order.
   * Independent scope-owned subscriptions end after the terminal observation.
   * Reading or cancelling a subscription does not start or cancel the body.
   */
  readonly phases: Stream<ComponentExpansionPhase, void>;
}

type ComponentExpansionPhase =
  | { readonly phase: "enter" }
  | { readonly phase: "active" }
  | {
      readonly phase: "exit";
      readonly reason: "returned" | "failed" | "cancelled";
    }
  | { readonly phase: "complete"; readonly result: Result<void> }
  | { readonly phase: "cancelled" };
```

Core issues the exact request through an occurrence-specific canonical terminal,
following Execution.document. Delegate next(request) once. Copied, foreign,
missing or repeated delegation cannot fabricate success or run a body twice.
The operation refuses an unissued request outside canonical dispatch.
Core keeps rendered results, bindings and effective outcomes private. Returned
middleware values are ignored; catching canonical failure cannot rescue it.
Middleware faults follow the existing policy-failure reconciliation pattern.

Cover resolution/validation before the body, accepted body and owned nested
work, ordered cleanup, final result acceptance and binding. Include Markdown,
function and value/captured invocations; equivalent structural dispatch paths
and actually executed consumed regions receive the same coverage. Unselected
and restored work that does not execute receives no invented phases. Code blocks
stay work inside their containing element. Add no resource scope to structural
syntax and change no caller-retained resource lifetime.

ENTER precedes preparation; ACTIVE begins accepted work. EXIT reports why work
ended while cleanup/final acceptance remain pending. Early refusal never reports
ACTIVE. Returned EXIT can still become failed completion. Completion publishes
Ok(undefined) or Err(detachedReportingError), preserving the selected existing
diagnostic and explanatory Error causes without exposing canonical mutable
objects or resource handles. Clean cancellation reports cancelled after unwind;
actual cleanup failure follows Core's existing precedence. Publish exactly one
terminal phase and then close with void. Preserve recovery, printed semantic
failure, durability/Files precedence and body/teardown cause accounting.

Independent subscribers receive the latest phase without a registration gap,
then ordered updates. Late attachment receives the terminal phase then ends.
Observation does not replay execution. A missing or slow UI does not delay Core
or wait for a rendered frame. ENTER/EXIT have no minimum animation duration.

## Session ownership and attribution

Install middleware in the owned entry execution lineage. The session allocates
private keys for actual calls and binds private enclosing presentation keys
around delegation, following CurrentWalk. Logical Expansion ids are not process
instance keys. Generated work keeps this lineage while its execution environment
and capabilities remain narrowed. No new ExecutionEnvironment member is needed.
Core never trusts presentation context for authorization or durable reconciliation.

The session owns phase consumers through entry teardown. Do not join a consumer
inside a middleware handler awaiting terminal publication after that handler
unwinds. Session shutdown joins owned execution/consumers, removes subscriptions,
clears the view and prevents late revival. Use generators, scoped cleanup and
the repository's listener-registration rules. Never yield in finally.

WAITING comes from actual unanswered Elicitation, interactive permissions and
owned expansion holds. Count independent reasons and release each on its own
resolution/cancellation. Hiding a drawer answers nothing. An import, ordinary
suspension or in-flight Prompt alone is not WAITING. Agent permission attribution
uses the bridge's actual owning turn. Waiting during cleanup preserves EXIT.
Recovered child failure does not automatically fail its parent.

Live snapshots are immutable session data passed through the root, separate
from ReplModel and Journal history. Historical panes suppress live questions,
permissions, output and component badges while observations continue offscreen.
Return live uses the latest snapshot. Cold reads never reconstruct ephemeral
phases. A retained source region is not an invocation lifetime.

## Accepted static source inspection

Export this **pure helper and types from Core's existing root entrypoint**,
alongside parsing helpers. It is not a contextual runtime operation.
Reuse the existing SourceRange type; existing document-target coordinates stay
unchanged. Returned ranges index the exact inspectSource input string.

```ts
/**
 * Read executable element boundaries from source without executing it.
 * Document input excludes frontmatter; fragment input follows generated
 * expansion's whole-string scanning behavior. Ranges index the exact input.
 */
function inspectSource(
  text: string,
  kind: "document" | "fragment",
): Result<readonly SourceElement[]>;

interface SourceElement {
  /** The authored tag name, exactly as Core's scanner reads it. */
  readonly name: string;
  /** Complete opening or self-closing tag, as a half-open slice of input text. */
  readonly opening: SourceRange;
  /** Complete closing tag for a paired element; absent for a self-closing tag. */
  readonly closing?: SourceRange;
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}
```

Use canonical scanner decisions, not a second CLI parser or delimiter searches.
Return all recognized nested executable elements in opening-source order as a
detached, recursively frozen list. The existing lexical incomplete-tag behavior
stays passive text; scanner refusals become Error Results. An empty list is
successful absence. Read no file, provider, contextual binding or imported
definition; evaluate no frontmatter language or prop expression, compile no
schema, and execute no code block. Document envelope extraction preserves the
execution parser's exact body boundary without interpreting its values.

Ranges are half-open UTF-16 offsets. Opening includes the entire opening or
self-closing tag. Closing exists for every paired element, even empty content,
and is absent exactly for a self-closing element. It has no lifecycle meaning.
For paired source, 0 <= opening.start < opening.end <= closing.start <
closing.end <= text.length. Inner content is the slice opening.end to
closing.start; containment gives static nesting. Name preserves authored spelling
and does not prove resolution, execution or permission.

## Accepted source and output presentation

- Before paired Evaluate admission, show its original producer content. After
  successful admission in the selected prefix, replace only that inner content
  with exact admitted source. Keep opening/closing tags and its enclosure.
  Earlier prefixes still show the producer. Self-closing Evaluate keeps its
  authored row with admitted source directly beneath it as a generated child.
- Match retained admission to the known source owner and exact canonical opening
  position. Require one appropriate Evaluate. Preserve existing missing/ambiguous
  ownership refusals. Do not attach to a guessed sibling or invent successful
  replacement for a refused admission. Original/Journal bytes remain unchanged.
- Static rails connect enclosing paired source and nested regions. Continuations
  carry their enclosure. Actual calls use the right-aligned status column on the
  first visual row; continuations leave it blank. Closing EXIT/terminal markers
  use the same column when observed. Separate actual calls remain distinct even
  when logical source ids repeat. Unselected source receives no execution badge.
- Reserve a stable measured status width for all supported readings, including
  EXIT with a cleanup wait. Source retains token colours and wraps in the remaining
  width. No glyph remains in the left source gutter, and no status word is cut.
- Soft-wrap source, previews and rendered output without changing logical text,
  explicit newlines or blank lines. Long unbroken values continue across rows.
  Use the engine's measured fit, not string length as terminal-cell width.
  Metadata keeps established fitting; fields and the single-row draft retain
  their current behavior. No horizontal scrolling interaction is added.
- The main reading uses the established vertical window pattern. Controls and
  decoration consume capacity before admission and remain outside moving rows.
  Off-window content has no nodes or targets. Positions stay process-local and
  reading-owned; resizing remeasures and clamps through existing admission rules.
- At entry level, Output precedes Source in the existing transcript pane and
  shares its reading window. Output is actual rendered text. Source is the
  authored/generated projection. Output arriving does not automatically move a
  window already being read. There is no additional pane or route.
- Use Output · live while showing session-emitted text. The retained final output
  replaces it once; use Output for that reading. An empty retained result says
  No rendered output. An inspected prefix lacking an entry output record says
  No entry output recorded at this checkpoint. Preserve truthful outcomes and
  existing diagnostics; prose containing "failed" does not decide status.
- Nested source readings show Recorded block output only where it has a known
  retained owner. Do not relabel the entry's whole result as a component result,
  concatenate local block outputs into a fabricated entry result, emit a bound
  value implicitly, or synthesize a write receipt. Agent text stays in Agent
  readings; bindings stay in binding readings.

Lifecycle glyph/word colours come from the older reference:

| State | Glyph | Colour |
| --- | --- | --- |
| ENTER | ▶ | #5aa87c |
| ACTIVE | ● | #7fd3e8 |
| WAITING | ● | #c99a3f |
| EXIT | ◀ | #c2766e |
| SETTLED | ✓ | #4f8468 |
| FAILED | × | #d24b3f |

Cancellation keeps existing cancelled wording. The palette is an independent
expectation, not an import of production constants. Existing source, focus,
selection, surfaces and drawers retain PR 1's accepted roles.

## Frozen structural checklist for architecture feedback

1. Core retains canonical execution, exact once-only delegation, bindings and
   authoritative failure/outcome selection independently of observer reporting.
2. Existing invocation/resource owners and cleanup order remain intact; final
   phases follow unwind and acceptance. Session consumers neither deadlock
   dispatch nor outlive session teardown or revive removed entries.
3. Generated execution retains its narrowed capabilities. Private presentation
   context supplies no permission, durable identity or reconciliation authority.
4. Static inspection uses canonical parsing and evaluates/executes/loads nothing.
   Replacement is anchored in retained ownership and exact source ranges.
5. No persistence change occurs. Conforming observed/unobserved runs retain
   identical canonical output, bindings, failure disposition and Journal bytes.
6. Inspected content stays prefix-only and receives no live overlays; cold
   reads perform no provider activity or source load. Output has its actual owner.
7. Root-owned immutable view data and semantic actions use the existing measured
   admission, mounted tree, focus and frame-target boundary. Absent rows/outlets
   contribute no resources or targets, and inspection owns no execution.

This checklist freezes architecture review. Ordinary visual correctness and
evidence sufficiency belong to the Planner. New structural criteria require an
explicit architecture amendment, not a later implicit review expansion.

## Planner work and evidence

Use the accepted eight-step main journey in pr2-product-verification.md at
160×36, 120×30 and 72×20. Derive companion evidence from the accepted contracts:
self-closing source, unselected branches, actual repeated/concurrent calls,
overlapping waits, held/failing cleanup, early refusal, printed failure,
recovery, cancellation, independent/late subscriptions and cold inspection.
Use real runtime records and owned operations, never fabricated lifetimes.

The plan names exact coverage sites: ordinary/structural dispatch, consumed
regions and generated work; source-range collection and no-evaluation envelope
extraction; session observations/waits; root source/output descriptions and
window admission. Classify Component.expand in the existing REPL expansion
controller boundary inventory and its repl-execution.test.ts regression.

The current renderer exposes measured bounds, not a public line-break map.
Explain the private engine measurement that yields wrapped rows and their
window count before implementation. Width, rail/status reservation, wrapping,
row count and visible targets must use one consistent prepared reading. Keep
renderer input engine operations, preserve measurement/commit isolation, and
register no extra host reader or frame subscriber merely to draw static rails.
If the concrete plan needs another public boundary, return that specific choice
to the Architect before adding it.

Freeze a finite PR 2 gallery for M2/M4/M6 and the necessary narrow, prefix/cold
and wrapping cases. Map older JSX/reference frames with archive hash, scene,
profile and provenance. Freeze focused tests and meaningful isolated break
controls for source rails, canonical lifecycle, source replacement and status/
wrapping/output ownership. Do not silently inherit PR 1's exact 35-pair count
or claim the complete-story gallery. Planner evidence sufficiency is delegated.

Candidate affected tests include Core component-api, invocation-scope,
invocation-failures, invocation-identity, expansion-metadata, scanner,
document-targets and document-target-execution; CLI repl-execution, repl-model,
repl-presentation-style, repl-layout-admission, repl-forms and repl-agent-journey.
Select the smallest discriminating files, add explicit black-box/fixture cases,
and publish every actual focused command. No exhaustive runtime battery is
required for feedback. After focused evidence passes, create the stable feedback
commit promptly and return its exact SHA and stack base. Preserve first failure
output and follow the repository's flake rules where applicable.

Update architecture.md and affected specifications when their corresponding
behavior exists, in present tense. Do not publish completed #881/PR 3 contracts
ahead of their implementation. Required CI and delivery verification retain
their normal authority; neither is architecture feedback evidence.

## Exclusions and next action

No Journal/sidecar/timestamp protocol, general tracing framework, dependency or
vendor change, additional terminal reader, new schema capability, automatic
drawer, multiline editor, fork or newer reference feature belongs to PR 2.
History rail geometry/head-summary presentation belongs to PR 3, whose accepted
contracts are now in pr3-planner-handoff.md. Its full-story gallery remains
Planner work. Existing History selection is used only to prove PR 2's
prefix isolation and return-live behavior.

Next Planner action: freeze the conforming PR 2 implementation plan and evidence
against these accepted contracts, then issue its implementation handoff.
PR 3's architecture interviews are complete under its separate ready handoff.
No GitHub mutation, production change, implementation verdict or delivery
approval is issued here.
