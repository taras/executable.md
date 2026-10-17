# Root documentation boundary interview record

**Completed:** the Product Owner accepts the conversation evaluation method,
standalone evaluation independent of agents, and a returned host execution
method in place of the proposed generatedRoot callback. The
[accepted Architect handoff](root-evaluation-architect-handoff.md) supersedes
the proposal text below and supplies the complete public/private boundary.
All three decisions are settled; the Planner now amends the plan and finite
evidence mapping. No implementation or passing verification is claimed.

The following text preserves the interview proposal. The callback was not
accepted and is not part of the final interface.

Partially accepted boundary review, against
`8be2d2bc3c38c4a896d0b678e121beef28e02920`, parent
`91eb10bd14b279dc764958972c401810a77f230d`.
The Planner's REQUEST CHANGES is justified. Decision 1 is accepted following
the Product Owner's clarification and approval in conversation. The Product
Owner also accepts keeping standalone, agent-independent root evaluation. Its
explicit binding interface remains under review, so this is not a completed
implementation handoff. No passing test result is claimed.

The earlier [Architect decision](generated-root-syntax-architect-decision.md)
settles scoped canonical dispatch but does not settle the composed documentation
contract. Its bare `syntaxReference(admittedSymbols(entries))` prescription is
insufficient for named package documentation. Do not use it as a complete wiring
handoff.

## Boundary inventory

Three decisions require reconciliation:

1. The public call that asks a conversation-owned execution to evaluate a reply.
2. The Core-private delivery of its captured reference and exact minted Syntax
   implementation.
3. The public standalone operation's documentation and routing contract.

The interface/ownership trigger in `.agents/architect.md` applies: this changes
a cross-package capability and where work runs. Review these decisions with the
Product Owner before issuing a final Implementor handoff.

## Decision 1 of 3: accepted conversation handle amendment

Feature: evaluate a completed reply using the documentation captured when this
conversation's execution was assembled, without another provider turn.

Current: AgentConversation exposes only `prompt` and `options`. Its private
queue cannot be reached by an arbitrary CLI call. A new job kind alone cannot
provide this capability.

Accepted additional member:

```ts
/** Evaluate a complete generated root using this execution's captured reference. */
evaluateGeneratedXmdRoot(
  request: GeneratedXmdRequest,
): Operation<Result<GeneratedXmdRootResult>>;
```

The exact CLI call is
`yield* conversation.evaluateGeneratedXmdRoot(request)` after successful provider
completion and under the CLI's revocable response scope. GeneratedXmdRequest
and the result/error shapes stay unchanged. `prompt` still returns source and
does not evaluate it. This is explicitly a third handle member, not private
plumbing or an implicit addition to prompt.

Core serves the request through the existing mailbox's admission and join
protocol. Overlapping work refuses before enqueueing. Evaluation starts no
provider prompt, changes no native association, and uses the request's pinned
capabilities rather than the conversation's installed executable vocabulary.

Each admitted evaluation receives its own fresh durable sequence within the
supplied conversation history, separate from the conversation continuation and
provider turns. Reopening projects prior response facts without running an
unfinished response suffix. Cancelling the method cancels and joins its
evaluation and owned cleanup before releasing the busy slot. The CLI remains
the owner of response authorization, control revocation and feedback; an already
admitted REPL entry retains its independent lifetime.

Status: accepted. The Product Owner approved separate explicit methods for
talking to the agent and evaluating its completed response. The handle's
existing prompt and options members remain accepted. This approval does not
settle the standalone operation or approve a Core-only documentation fallback.

## Decision 2 of 3: Core-private implementation handoff

Use an internal execution entrypoint used by conversation.ts rather than making
AgentConversationHost protected. The synthetic host remains local to its
synthetic root and is not added to the global protected catalog.

At the canonical executeDocument boundary, after identity installation and
reference construction, Core builds a bound root-evaluation closure from:

- the exact definition in that execution's `identity.protected` for Syntax;
- its existing guarded routing; and
- its already captured root SyntaxReference.

A private callback from this internal execution entrypoint delivers only the
bound closure to conversation.ts before its host starts serving. It is not an
ExecutionInstallation hook, public initialization member, environment accessor
or ambient context. The mailbox closes over it. The protected table, domain,
claimant and raw documentation contributions never cross that callback.

For each evaluation, the closure narrows the route using that exact function
and narrows the reference with `available(admittedSymbols(entries))`. Each
response closes its narrowed route after joining; execution teardown revokes
the underlying domain. No static declaration or newly minted function is
substituted for the execution's installed implementation. Released fragment
behavior remains unchanged.

This reuses the accepted ownership and existing reference/routing mechanisms;
Architecture rules 2 and 3 delegate this implementation structure. It does not
require adding a ProtectedSite member or changing ExecutionEnvironment. The
final handoff supplies the complete private signature inventory after the
standalone boundary is settled.

## Decision 3 of 3: standalone capability accepted; binding proposed

The standalone operation has no captured execution reference. Moving the CLI
to another path does not repair its named-reference contract. Keeping its
scoped installation preserves dispatch but does not supply captured package
chapters; deleting that installation also removes its current canonical route.

Do not delete `installScopedProtected`, declare the Core-only documentation
fallback accepted, or change the standalone guarantee as a consequence of
decision 1. Review the standalone contract explicitly next. A final handoff must
resolve it, including supported standalone Syntax behavior, before coding.

The Architect withdrew the recommendation to remove standalone evaluation after
explaining its cost: it would make general generated-XMD execution depend on an
agent conversation. The Product Owner agrees to keep both capabilities. This
does not approve a Core-only documentation fallback or a particular new setup
signature.

Proposed standalone binding: a trusted host requests a bound evaluator through
its existing ExecutionInstallation. Core delivers the function after capturing
the execution's environment and before any authored code runs. No agent
conversation is required.

```ts
type GeneratedXmdRootEvaluator = (
  request: GeneratedXmdRequest,
) => Operation<Result<GeneratedXmdRootResult>>;

interface ExecutionInstallation {
  /** Receive this execution's generated-root evaluator before authored work starts. */
  readonly generatedRoot?: (evaluate: GeneratedXmdRootEvaluator) => void;
}
```

Only the additional member is shown; existing ExecutionInstallation members
keep their contracts. Core captures these callbacks by value with the host
assembly before installers run. They receive an operation, not a protected
definition, table, reference, claimant or index. The callback receives the bound
function synchronously; it does not evaluate a program or open another journal
merely because it is attached. A callback failure is a setup failure.

The standalone host then calls `evaluate(request)` under its ordinary owned
durable execution, preserving the evaluator's current request, admission,
rendering, error and retained-policy comparison contracts. This binding does
not create a provider conversation, supply ambient entry bindings, widen the
pinned ceiling or provide a new history format. The function is valid only
while its canonical execution remains live. Calls after closure refuse;
execution teardown cancels and joins active evaluations before revoking their
underlying route. Caller cancellation joins that evaluation's owned work.

This proposal replaces the siteless module-level generated-root function with
the bound function delivered through the host installation. It preserves the
standalone capability but explicitly amends how a host obtains it. The public
function signature is not silently preserved with a weaker documentation
contract. The evaluator type remains exported from the trusted host entrypoint;
request and result types remain unchanged. Preview and released fragment
evaluation keep their existing public interfaces and behavior.

Both paths use the private binding from decision 2. The conversation obtains
it through Core's private callback and serves calls under its mailbox and fresh
response sequences. A standalone host obtains it through its captured trusted
installation callback. Both describe their root's admitted vocabulary using
the owner's already captured reference. No path recollects document-time
middleware or substitutes a Core-only index. Delete scoped siteless routing
only after both supported paths have this replacement.

Status: the standalone capability is accepted; the generatedRoot installer and
replacement of the siteless export require Product Owner acceptance. No
production exports, scoped routing or tests are changed by this record.

## Next action

Obtain Product Owner feedback on decision 3's binding interface and show the complete amended
boundary. Only then does the Planner update the
handoff and finite evidence mapping. Keep the correction in PR 2 and leave the
untracked gate work untouched.
