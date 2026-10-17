# PR 2: accepted invocation observation contract

All five middleware interview items are accepted by the Product Owner.
This contract settles the Core-to-REPL observation boundary. Presentation choices
are accepted in [pr2-source-presentation.md](pr2-source-presentation.md).
The main product verification journey is accepted in pr2-product-verification.md.
The static source-range boundary is accepted in pr2-source-inspection.md.
All contracts are consolidated in the ready pr2-planner-handoff.md.
PR 1 feedback is complete at
`080b6ec80ca74e614789e8d2252857ac281df7e5`.

The REPL observes one executable element from preparation through cleanup and
final acceptance. For example, an Elicit remains WAITING until its question is
answered; a returning component remains EXIT while its destructor runs.
Core owns execution and outcomes. The session owns the live reading.

## Accepted interface

Add `expand` to the existing `Component` contextual Api. Export `Component`
and its consumer-facing types from `@executablemd/core/api`, including the
existing `Expansion` type needed by this request. Preserve existing root exports.
`Operation`, `Stream` and `Result` come from Effection.

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
  /**
   * Core's detached description of the element this call surrounds.
   * Presentation information only; it grants no execution capability.
   */
  readonly expansion: Expansion;

  /**
   * Observe the latest phase, then subsequent changes in order.
   * Independent scope-owned subscriptions end after the terminal observation.
   * Reading or cancelling a subscription does not start or cancel the body.
   */
  readonly phases: Stream<ComponentExpansionPhase, void>;
}

// Existing Core type; its meaning is unchanged.
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

No separate completion alias, public callback/disposer, process key or parent
wrapper is required. Local helpers and publication mechanics remain delegated.

## Canonical expansion and coverage

Core dispatches through an occurrence-specific terminal following its existing
`Execution.document` request pattern. An observer delegates `next(request)`
with the exact issued request once. Copied, foreign, missing or repeated
delegation cannot fabricate success or execute a body twice. Outside canonical
Core dispatch, the operation refuses an unissued request.

The terminal keeps execution results, bindings and failure decisions in private
state. Middleware return values are ignored. Catching a canonical failure
cannot rescue it. Middleware refusal or failure follows the existing policy
failure pattern: it may refuse work or fail success, while Core's canonical
failure and fatal precedence remain authoritative.

Coverage starts before resolution and props validation, includes the accepted
Markdown or function body, owned child/content/generated work, ordered cleanup,
and final result acceptance and binding. Value/captured invocations receive the
same coverage. Structural engine paths such as Switch and actually executed
consumed regions use equivalent boundaries. Unselected branches and restored
work that does not execute receive no invented invocation phases. Code blocks
remain work within their containing element in this slice.

Use existing invocation machinery and lifetimes. Structural syntax gains no
component resource scope. Caller-retained resources keep their existing owner.
Preserve printed semantic failure, recovery, body/teardown cause accounting and
durability/Files fatal precedence.

## Phase and subscription behavior

| Phase | Meaning |
| --- | --- |
| `enter` | Core begins preparation, before resolution and validation. |
| `active` | Core enters accepted body or structural work, including owned nested work. |
| `exit` | Work ends or preparation is refused; cleanup and final acceptance remain pending. The reason describes why exit began. |
| `complete` | Full middleware dispatch, cleanup and final acceptance finish; the effective outcome is selected. |
| `cancelled` | Cancellation finishes its unwind without an actual failure taking precedence. |

An early refusal never reports `active`. An exit reason of `returned` does not
promise success: return validation or cleanup can still fail. Publish exactly
one terminal phase, then close the stream with `void`. Do not delay execution
to make ENTER or EXIT visible for a minimum animation time.

Each subscriber gets the latest phase followed by ordered changes, without an
initial registration gap. Subscribers have independent queues. A late subscriber
after completion gets the terminal phase and then finishes. There is no replay
of earlier phases and no provider call or execution caused by observation.
An absent or slow UI consumer does not stall Core or wait for frame acknowledgment.

The session owns consumers through entry teardown. Do not join a consumer from
inside a handler while it waits for a terminal phase that Core publishes only
after that handler unwinds. Consumer failures follow their Effection owner;
they do not supply a fabricated completion. Session shutdown joins its owned
execution and consumers, clears the live view, and prevents late publication
from reviving a removed entry. Subscription cleanup has its consumer's lifetime.

## Completion reporting

Successful completion reports `Ok(undefined)`. Failure reports
`Err(reportingError)`. The Result is reporting-only: it carries no component
rendered value, binding, provider, resource scope or authoritative result.

The reporting Error is detached from Core's mutable canonical Error. Preserve
the selected diagnostic name/message and explanatory Error causes that Core
already supplies, without exposing arbitrary resource objects. Keep Core's
actual cause graph and identities private. Published phases and Result data are
immutable observations. No new structured stage or general tracing fields are
required; existing diagnostic stage information remains available.

Clean cancellation reports `cancelled`, without inventing success or an Error.
When an actual cleanup failure takes precedence, report `complete` with failed
Result. A recovered child failure does not automatically fail its parent.

## Session attribution and presentation

Core creates the frozen `Expansion` description before dispatch, including on
resolution failure. Its deterministic id locates a logical source element;
it is not a unique key for a process execution. Position remains optional under
the existing source-position contract.

The REPL allocates a private key for each actual middleware call and binds its
enclosing presentation key around delegation, following the existing private
CurrentWalk composition pattern. Entry identity and nesting remain session view
data. Generated expansion retains this execution lineage while receiving its
own narrowed capability environment. No new `ExecutionEnvironment` member is
required. Core never trusts presentation context for security, durable identity,
reconciliation or resource ownership.

WAITING is a private overlay from actual unanswered Elicitation requests,
interactive permissions and owned pause holds. Count reasons independently and
remove each on its own resolution or cancellation. Closing a drawer does not
answer a question. Ordinary suspension, an import or an in-flight Prompt alone
does not imply WAITING. Permission attribution uses the Agent bridge's actual
owning turn. A wait during cleanup preserves the underlying EXIT phase.

Completion Result maps to SETTLED or FAILED; cancellation uses existing cancelled
wording. Session snapshots may retain completed live badges. They stay outside
ReplModel and the Journal. Historical inspection suppresses all live overlays
while observation continues offscreen. Returning live uses the latest snapshot.
Cold inspection shows retained facts without reconstructing ephemeral phases.

## Planner constraints and evidence

Classify the new operation in the REPL expansion controller's boundary inventory
and update its discriminating tests in `repl-execution.test.ts`. Cover ordinary,
structural and consumed-region expansion without duplicate observations.
Verify subscriptions, late attachment, early refusal, printed failure, recovery,
held cleanup, cleanup failure and cancellation using real operation boundaries.

Compare conforming observed and unobserved execution for identical output,
bindings, failure disposition and Journal bytes. Exercise repeated logical ids,
concurrent siblings, generated descendants and independent wait reasons.
History inspection must stay prefix-only while the live snapshot changes.

These are boundary checks derived from the accepted API. The broader product
journey is accepted; the Planner freezes visual cases and exact focused commands
under pr2-planner-handoff.md. No production implementation, persistence change,
dependency change, GitHub mutation or reusable rule promotion is authorized
by this record.
