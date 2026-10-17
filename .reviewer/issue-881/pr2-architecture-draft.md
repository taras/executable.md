# PR 2 architecture: observe the complete expansion

**Draft for Product Owner review, not an Implementor handoff.** PR 1 feedback
is complete at `080b6ec80ca74e614789e8d2252857ac281df7e5`, based on
`e68f128121cd802623ab7797a016b0c66ce91176`. This proposal concerns the Core
observation boundary PR 2 needs. It changes no production files or GitHub state.

## Purpose and example

While a Plan is running, the REPL shows the Plan's executable occurrence as
active. When that occurrence asks an Elicit question, the question's occurrence
waits until an accepted answer arrives. After the body returns, its badge remains
EXIT while owned cleanup runs. SETTLED appears only after cleanup and result
acceptance succeed. A failure which Core prints still has a failed occurrence;
printing it does not turn it into a successful invocation.

These are process-local observations. Historical panes use only the selected
retained prefix. Returning live reads the latest session snapshot. Cold inspection
starts no execution, installs no observer and invents no active or waiting state.
No Journal record, timestamp, sidecar or persistence protocol is added.

## Traced boundaries

The production paths inspected are unchanged by PR 1. The current root worktree
is `2d719f78025059158a35023701fdff52b855a65b`; the intended main base changes
only history terminology. The accepted PR 1 patch changes private presentation,
not these Core execution paths.

| Boundary | What it establishes | Why it is insufficient alone |
| --- | --- | --- |
| `Component.importComponent` | Resolves a name to a definition. | Resolution finishes before props, body work, result acceptance and cleanup. Protected and closed imports also do not permit substituting wrappers. |
| `expandComponent` | Resolves and validates a named element, then expands its selected Markdown or function body and accepts its result. | It is private and has no complete invocation middleware operation. Engine structural constructs bypass it. |
| `withInvocation` | Owns content/body/persistent teardown in that order and preserves body and cleanup failures. | It starts after early resolution and prop refusal, and ends before some bindings and function failure disposition. |
| `Execution.document` | Surrounds canonical document expansion with request middleware. | It provides the entry anchor, rather than individual child occurrences. |
| Component dispatch in `expandListSegments` | Establishes an element path before both structural and ordinary component branches. | It needs an observation wrapper around those branches, without changing what dispatch executes. |
| `spawnChild` and installed region producers | Expand region occurrences that their parent consumes rather than dispatching independently. | Observing only ordinary dispatch would omit these real child executions. Unselected regions must not be reported as having run. |
| Generated-XMD `expand` | Starts a narrowed fragment with its own environment under the Evaluate body. | The observation parent must cross this boundary without inheriting or widening execution capabilities. |

Code references: `packages/core/src/expand.ts` (component dispatch,
`expandComponent`, `expandFunctionComponent`, `spawnChild`,
`expandInstalledStructural`), `src/invocation.ts`, `src/document-request.ts`,
`src/execute.ts` and `src/generated-xmd.ts`. Governing contracts include
executable-MDX §§4.4, 5.6 and 6.9. The existing REPL Elicitation and Agent adapters
already publish actual pending questions and permissions; the expansion
controller already owns pause holds.

## System-boundary interview

The interview is required because this adds a public cross-package operation,
request, occurrence identity and observer lifetime. The accepted middleware
direction does not itself approve those members. `.agents/architect.md` requires
reviewing this boundary one member at a time. Local REPL helper names and types
remain delegated.

Revised inventory: **all 5 review items accepted** by the Product Owner.
The consolidated boundary is [pr2-invocation-contract.md](pr2-invocation-contract.md).
Process keys and nesting remain private REPL view data, as described in item 2.
No accepted public member is removed.

1. `ComponentApi.expand`: the complete element expansion operation.
2. `ComponentExpansionRequest.expansion`: the detached occurrence being observed.
3. `ComponentExpansionRequest.phases`: lifecycle stream, initial reading and subscription lifetime.
4. `ComponentExpansionPhase`: ordered body/exit/completion observations.
5. Completion payload: accepted success, semantic failure and cancellation.

Observer-failure behavior and cancellation publication are lifetime decisions
within items 1, 3 and 5. The Product Owner specifies an Effection Stream rather
than a callback registration interface and names it `phases`; its accepted
contract appears in item 3. Parent tracking remains private presentation composition
and changes no identity or permission boundary. No `ExecutionEnvironment` member
is proposed or needed to transport this private reading through inherited
middleware scopes.

## Item 1 of 5: `ComponentApi.expand`

**Feature.** Let middleware surround one complete executable element, so the
REPL can follow its progress without wrapping or replacing its implementation.

**Example.** A `<Plan as="draft">` occurrence enters before resolution. Its
middleware remains attached through prop checks, body execution, projected
content, teardown, accepted return and binding. A nested `<Switch>` uses the
same observation contract through its structural expansion path. A source branch
never selected has no live occurrence.

**Current.** `ComponentApi` exposes import, content, capture, modifiers and
failure operations, but no operation surrounds the whole expansion. The closest
established complete wrapper is:

```ts
interface ExecutionApi {
  document(request: DocumentRequest): Operation<void>;
}
```

**Proposed addition.**

```ts
interface ComponentApi {
  /**
   * Surround one executable element's complete expansion.
   *
   * Canonical Core issues the request before resolution or validation and
   * delegates through this chain once. The request reports the occurrence;
   * it carries no definition, props, resource scope or result authority.
   * Completion includes owned teardown and final result acceptance.
   * Returned values are ignored; Core retains its output, binding and failure
   * decisions independently of what a handler returns or catches.
   */
  expand(request: ComponentExpansionRequest): Operation<void>;
}
```

Add this member to the existing `Component` Api rather than inventing a tracing
namespace. Export the consumer-facing contextual API and its new contracts from
`@executablemd/core/api`, following architecture rule 7. Keep `expandComponent`
and the selected definition private.

Canonical dispatch uses an occurrence-specific terminal, following the
`Execution.document` request pattern. A handler delegates the exact request with
`next(request)`; returning a value is not producing output or an outcome. A
copied request, another occurrence's request, missing delegation and repeated
delegation cannot manufacture a successful expansion or execute its body twice.
Canonical failure remains failure even if a wrapper catches it. These checks
reuse the established request pattern and do not create durable identities.

The wrapper encloses actual structural and component expansion, not only the
generator body. For constructs without a component resource scope, completion
follows their existing join/producer teardown. It does not add component resource
lifetimes to structural syntax. A code block remains work inside its containing
element in this slice; it does not gain a fabricated component invocation.

The observer is installed in the session's entry execution lineage. It does not
own or cancel the invocation and supplies no permission, result or continuation
replacement. The canonical result and failure precedence remain Core's own.
The request is a live observation boundary, never something a cold historical
reader acquires.

**Decision for item 1: accepted.** The Product Owner confirmed that this is the
intended middleware: it observes a component from start through cleanup so the
REPL can show its progress. `Component.expand(request)` supplies that complete
boundary. Core retains execution, bindings and outcomes; no Journal records are
added. This is a feature decision, not a new reusable architecture rule.

## Item 2 of 5: `expansion: Expansion`

**Feature.** Give the REPL one read-only description of the component this
middleware call surrounds, so a progress badge stays beside the right source.

**Example.** A Plan and its nested Elicit need separate badges. Two File calls
also need separate readings even though their tag names match. The observation
reports the executing occurrence rather than asking the REPL to guess from an
import name or the most recent transcript row.

**Current.** `getExpansion()` returns the existing detached `Expansion` snapshot:
deterministic `id`, authored `name` and optional `position`. It exposes no props,
definition, resource scope or authority. A middleware hook before body execution
cannot assume that reading this context describes the new occurrence: the body
publishes its snapshot later. The complete hook therefore receives its own
description directly from Core.

**Proposed request member.**

```ts
interface ComponentExpansionRequest {
  /**
   * The actual occurrence this call surrounds, reported by Core.
   * Read-only presentation information; it grants no execution capability.
   */
  readonly expansion: Expansion;
}
```

Core creates a detached, frozen description before dispatch. Every observer of
this call receives that description, including when resolution fails and no
body starts. It supplies no definition, props, bindings, Scope or permission.
The REPL may keep these plain facts in its process-local view after completion;
keeping the description does not keep the invocation alive. No source bytes are
loaded merely to construct it. Identity and source position remain facts reported
by Core rather than facts an observer assigns back to execution.

**Assessment and proposed type.** Use the existing `Expansion` directly. It
already supplies the deterministic id, authored tag name and optional source
position. Each middleware call has its own request and phases stream, so two
actual executions may carry the same logical id without sharing a stream or a
live badge. The session allocates a private key for each observed call and binds
its enclosing view key around delegation. Repeated executions and concurrent
siblings therefore remain distinct without adding public process keys to Core.

The existing REPL expansion controller establishes the composition pattern:
`bracket` reads the enclosing walk, allocates its local child and binds it around
`next`. Component body/content hosts inherit the execution lineage, and generated
expansion changes its capability environment while retaining that lineage. Agent
permission attribution continues to use the bridge's actual owning turn; it does
not guess from a shared current badge. The private key/parent reading determines
presentation only. Core never trusts it for durable identity, authorization,
result acceptance or resource lifetime.

The deterministic source id is not used as a unique process-instance key, and
the private context is not execution authority. This keeps Core's existing
`Expansion` meaning unchanged. Local REPL view types remain delegated under
architecture rules 2, 9 and 11 and the repository's shared-state rule.

**Decision for item 2: accepted.** The Product Owner accepts
`readonly expansion: Expansion`, reusing the existing Core type and keeping
process keys and nesting in the REPL's live view. Core supplies the frozen
logical id/name/position directly on the request. The member is required;
source position remains optional under its existing contract.

## Item 3 of 5: `phases`

**Feature.** Let the REPL follow this expansion's current progress and completion
with an ordinary scope-owned Effection subscription.

**Example.** A subscriber attaches before delegation and sees ENTER, then ACTIVE.
When the body ends it sees EXIT while cleanup runs. The terminal observation is
delivered after cleanup and result acceptance; the stream then finishes. A view
which attaches later begins at the latest observed phase and receives subsequent
changes. It does not replay or execute the component to discover that phase.

**Current.** The REPL already exposes Effection Streams for live changes, output
and Agent reading. `Stream<T, TDone>` is an operation producing an independent
`Subscription<T, TDone>`, and that subscription belongs to its consumer scope.
The Product Owner requests the same abstraction for phases, rather than a
callback registration/disposer.

**Proposed request member.**

```ts
interface ComponentExpansionRequest {
  /**
   * Observe this expansion's latest phase and subsequent changes.
   * Each subscription is independent and ends after the terminal observation.
   * Subscribing or cancelling a subscription does not start or cancel the body.
   */
  readonly phases: Stream<ComponentExpansionPhase, void>;
}
```

Subscribe without a gap between the initial phase and subsequent changes. Each
subscriber has its own queue; one reader cannot consume another reader's phase.
There is no replay of preceding phases, retained history, provider call or
terminal reader. A subscription after completion receives the terminal
observation and finishes. The `void` return means the outcome is in the terminal
phase value; stream completion is not a second result authority.

The session owns its phase consumers and keeps them alive through entry cleanup.
Effection removes a subscription when its consumer scope ends. Removing one
does not release or cancel component work. The component's canonical operation
continues with no reader, and a slow UI does not hold it waiting for a frame
acknowledgment. On cancellation the canonical operation still unwinds first;
the terminal observation describes the completed unwind. If the session itself
is cancelled, its own teardown clears the live view and joins its consumers;
no late delivery may revive a removed entry.

The exact phase values and completion payload are the next two review items.
This member accepts their transport and lifetime rather than deciding every
state label or error-reporting field.

**Decision for item 3: accepted.** The Product Owner accepts
`readonly phases: Stream<ComponentExpansionPhase, void>` with independent
scope-owned subscriptions, a current reading followed by subsequent changes,
and completion after unwind. The terminal phase carries the reporting outcome.

## Item 4 of 5: phase values

**Feature.** Show preparation, body execution, cleanup and final completion as
different parts of the same expansion, without calling a returned body settled.

**Example.** The body returns a valid Plan source, but an owned resource is still
closing. Its phase is EXIT until that cleanup finishes and Core accepts its
result. An early failed import never reaches ACTIVE. A cancelled question clears
its wait but keeps EXIT until its unwind completes.

**Proposed phase type.**

```ts
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

| Value | Observable meaning |
| --- | --- |
| `enter` | Core began the element and is resolving/validating it; its body has not started. |
| `active` | Core entered the accepted body or structural expansion, including work it owns below it. |
| `exit` | Body work ended, or preparation refused the occurrence. Owned cleanup and final acceptance are not yet finished. The reason describes what began the exit, not its final outcome. |
| `complete` | Core finished cleanup and result acceptance. Successful Result draws SETTLED; failed Result draws FAILED, including semantic failures Core prints. |
| `cancelled` | Cancellation completed its unwind with no canonical failure taking precedence. Draw the existing cancelled wording. A teardown failure taking precedence instead produces `complete` with failed Result. |

A late result-validation failure may follow EXIT with reason `returned`, because
the body returned before Core rejected its result. An early refusal can leave
ENTER without ever becoming ACTIVE; it still finishes with failed Result.
Cancellation is not successful settlement or a fabricated ordinary failure.

WAITING remains a private reading of actual Elicit questions, interactive
permissions and owned pause holds. The phase stream does not equate suspension
with waiting for a person. The REPL combines the latest execution phase with
its actual pending wait reasons; it retains the underlying exit phase when
cleanup itself is waiting. Closing a drawer changes no phase or wait.

Only executed occurrences produce phases. Unselected branches have source but
no live phase. ENTER and EXIT have no minimum display duration; execution does
not wait for a rendered frame. Final phases remain readable in the live session
snapshot, and historical panes receive none of this overlay.

The Result payload and failure reporting are item 5. This proposal determines
the lifecycle states and their ordering, without granting the observer result
authority or changing canonical failure precedence.

**Decision for item 4: accepted.** The Product Owner accepts ENTER, ACTIVE,
EXIT with its reason, COMPLETE with Result, and distinct cancellation. WAITING
comes from actual pending questions, interactive permissions and pause holds,
combined with the underlying phase by the REPL. Final completion follows unwind
and result acceptance; no minimum animation duration is added.

## Item 5 of 5: completion reporting

**Feature.** Tell the REPL whether this expansion finished successfully, failed
or was cancelled, while Core remains the sole owner of execution results.

**Example.** A function component prints its own failure and returns normally
through its printing boundary. The component's final phase still reports failed
Result. A parent that recovered a child's failure can finish successfully under
Core's existing recovery rules. A cancellation with clean teardown reports
cancelled; a cleanup failure taking precedence reports failed completion.

**Current.** Effection `Result<T>` carries success under `value` and failure as
an `Error`. Core's document middleware retains canonical settlement in private
state and reconciles it independently of middleware returns or catches.
`withInvocation` combines body and teardown failures without losing the body's
cause. Those contracts continue to decide expansion and parent outcomes.

**Proposed completion members.**

```ts
type ComponentExpansionCompletion =
  | { readonly phase: "complete"; readonly result: Result<void> }
  | { readonly phase: "cancelled" };
```

This excerpt describes the final two branches of `ComponentExpansionPhase`;
it need not introduce another exported type. Core publishes `Ok(undefined)` for
accepted completion or `Err(reportingError)` for the occurrence's failure.
The observer receives no rendered value, binding, provider object or scope.
The Result describes completion for presentation; Core does not consume it as
the result of executing a component.

The failure Error is a detached reporting snapshot preserving the selected
failure's existing diagnostic name/message and explanatory Error causes where
Core supplies them. It exposes no original mutable canonical Error or arbitrary
resource object. Core keeps its actual cause graph, identities and authoritative
outcome private and unchanged. No new structured stage or general tracing data
is required for the original badge contract; stage information present in the
existing diagnostic stays available. Phase values and detached Result data are
immutable published observations.

Final reporting follows the complete middleware dispatch and its cleanup,
after Core selects the effective outcome. A handler's returned value is ignored;
catching a canonical failure cannot change that failure into accepted success.
A middleware refusal or fault follows the existing policy-failure pattern: it
may refuse work or fail a success but cannot rescue a canonical failure.
Durability/Files fatal precedence and body/teardown cause accounting stay as Core
currently defines them. No observer supplies an outcome for Core to rank.

Phase consumers belong to the session and are not joined from inside the
middleware handler waiting for terminal publication. Otherwise the handler and
publisher would wait for each other. Subscribe before delegation in the
session-owned consumer lineage, which lasts through entry unwind. Consumer
failure follows its ordinary Effection owner; it does not submit a fabricated
completion. Session cancellation joins its owned execution and consumers and
clears the live view.

Exactly one terminal phase is published for an observed occurrence, followed by
stream completion. Clean cancellation ends with `cancelled`, without inventing
a successful Result or a failure Error. When actual failure wins during unwind,
the final phase is `complete` with failed Result. Observer-installed and
observer-absent conforming runs retain the same canonical output, bindings,
failure disposition and Journal bytes.

**Decision for item 5: accepted.** The Product Owner accepts reporting-only
`Result<void>` completion and distinct cancellation. Core retains its existing
outcome, failure precedence and cleanup rules. Reporting exposes a detached
diagnostic, never the mutable canonical result or failure objects.

## Accepted boundary shape

All members below are accepted. The consolidated contract with documentation,
coverage, lifetime and attribution is in
[pr2-invocation-contract.md](pr2-invocation-contract.md).

```ts
interface ComponentApi {
  expand(request: ComponentExpansionRequest): Operation<void>;
}

interface ComponentExpansionRequest {
  readonly expansion: Expansion;
  readonly phases: Stream<ComponentExpansionPhase, void>;
}

interface Expansion {
  readonly id: string;
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
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

`Operation`, `Stream` and `Result` are Effection types; `Expansion` and `SourcePosition`
already exist in Core. The completion event maps successful Result to SETTLED
and failed Result to FAILED. Failure observations carry a detached reporting
Error, never Core's mutable canonical Error. Cancellation has its own terminal
event after unwind. All five boundary items are accepted. Generated-source
presentation and product verification still precede the full PR 2 handoff.

`Expansion` is the existing detached id/name/position snapshot. Its deterministic
id continues to locate a logical authored element. The session's private reading
adds entry identity, process keys and nesting. None reaches the Journal.

The Product Owner corrected the callback proposal: lifecycle observation is an
Effection Stream. Each subscription reads the latest phase first, then receives
subsequent transitions in order through its own queue. It finishes after the
terminal observation. A subscription is owned and removed by the consumer's
Effection scope; no public callback registration or disposer is needed. Reading
the stream neither starts another expansion nor owns or cancels the existing
one. The session consumer's lifetime must cover entry teardown, and session
shutdown clears its private live view even if that consumer is itself cancelled.
An absent or slow UI consumer must not hold canonical execution waiting for a
render acknowledgment. Public observations cannot expose the canonical result
object, mutable Error or private failure ledger. Completion data, fault
behavior and cancellation ordering are settled in item 5. Stream semantics follow
the installed Effection `Stream`/`Subscription` types; publisher mechanics remain
an implementation decision under the accepted lifetime contract.

The Product Owner proposes `expansion` for the description and `phases` for its
stream; these property names are accepted for this feature. The accepted
description type reuses the existing `Expansion` without an additional wrapper.
The property remains required: even a failed import has an element
which Core began expanding. Source position may be absent under its existing
contract. A root occurrence has no enclosing private presentation key.

WAITING is derived privately from actual questions, interactive permissions and
owned pause holds. It is not every suspended generator, import or Prompt. Wait
reasons are counted independently, clear on their own resolution/cancellation,
and cannot overwrite a terminal outcome. Closing an Answer drawer changes no
wait. A parent may show an outstanding descendant without inheriting every child
failure. Canonical recovery decides the parent's own result.

## Product verification proposed for PR 2

1. Run the original nested Plan journey. Source and occurrence rails remain
   readable; a resolved import with its body held remains unfinished. Two sibling
   occurrences remain distinct, and generated children belong beneath Evaluate.
2. Hold an Elicit and an interactive permission request. Each waits until its
   actual request ends; hiding a drawer changes nothing. Overlapping waits do
   not clear one another. Ordinary Agent streaming remains active.
3. Return from a body while cleanup is deliberately held. EXIT stays visible;
   final success appears only after cleanup and binding acceptance. Report early
   refusal, printed semantic failure, failed result acceptance and cleanup
   failure truthfully. A recovered child failure does not automatically fail its
   parent.
4. Cancel while waiting. Owned cleanup completes, waits disappear and no late
   observer publication revives the occurrence. Preserve Core's established
   precedence when cleanup also fails.
5. Inspect an earlier prefix while the live run changes, then return live. The
   inspected panes remain prefix-only; returning live shows the latest snapshot.
   Cold reopen shows retained facts with no provider call or Journal mutation.

Lower-level discriminating evidence compares conforming observed and unobserved
runs for identical canonical outcomes and Journal bytes. It uses actual runtime
fixtures rather than invented durable events. Exact commands and the later
visual matrix are frozen by the Planner after product/boundary approval.

## Continuity

Accepted direction: middleware feeds the session-owned live lifecycle view;
completion follows teardown; live observations stay separate from retained
inspection; no persistence change. PR 1 feedback remains complete.

Current review: **all 5 API items accepted** and consolidated in
[pr2-invocation-contract.md](pr2-invocation-contract.md).
All five presentation decisions are also accepted in pr2-source-presentation.md.
The main verification journey is accepted in pr2-product-verification.md.
Canonical static source inspection is accepted in pr2-source-inspection.md.
The ready pr2-planner-handoff.md consolidates all PR 2 contracts. History
adaptation and product verification are accepted in pr3-planner-handoff.md;
the Planner owns complete-story scene mapping and finite evidence.
No persistence question is reopened.
