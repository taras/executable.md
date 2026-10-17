# Sidekick provider selection: Architect decision and interview history

**Architect handoff complete under the approved Context-selection direction.
Ready for a replacement Planner assignment at 08c95ca2.**

The [consolidated handoff](pr2-direct-provider-architect-handoff.md) is the
current contract: Core reads one provider object from Context for an open chat
and directly calls its agent, session, options and prompt methods. It specifies
the interface, provider lifetime, existing Core checks and permission audit.
The [Planner prompt](pr2-direct-provider-planner-prompt.md) requests the bounded
replacement Implementor assignment. This interview history is not an additional
set of requirements.

The Product Owner approves reusable API-selection rules and the corresponding
Code Rule 15 amendment, recorded in .agents/architecture-rules.md rules 23–25
and AGENTS.md in the main checkout. A Context-selected runtime fits Sidekick's
fixed provider selection; Core invokes the captured service directly and keeps
its configuration admission and canonical history privately. The session
inspection protocol below is superseded and the proposed prompt protocol is
withdrawn. Their interview records remain historical, not implementation
instructions. The consolidated handoff supplies the concrete interface,
delivery and lifetime; the Planner still freezes implementation and evidence.

P2 is closed at `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`, parent
ef68c71c, branch agent/issue-883-pr2. P1 remains open. The implementation
worktree is clean. The previous overall PASS is superseded by the
[review at 08c95ca2](pr2-configuration-result-architect-review-08c95ca2.md).

## The problem

The accepted mandatory conversation configuration check disappears when
supported session middleware forwards only the request's descriptive name.
The [Architect return](pr2-configuration-request-routing-architect-return.md)
and unchanged real-ACP probe establish native work with no configuration record.
The latest review independently reproduced it at 08c95ca2.

Forwarding a raw name does not open a fresh Core issuance. ACP follows its
ordinary string path, obtains no setup and skips activation altogether.
Substituting another request is a different way to lose the original
requirement; it is not what the existing name-forwarding probe does.

```text
Current
  Core conversation issues request with required configuration check
       |
  middleware forwards request.name
       |
  ACP sees string -> no setup -> no activation -> native work
```

## Existing seams inspected

- conversationTurn opens and closes its issuance around Agent.operations.session.
  It owns the conversation requirement but not the provider's resolution work.
- ACP's installed Agent.session handler captures a continuation but ignores it;
  it calls the selected state's openSession directly.
- resolveSession calls the delivered coordinator's sessionSetup only when the
  final argument has request shape. Native reattachment can occur before the
  operation returns, so inspecting its returned Session is too late.
- The delivered coordinator's sessionSetup consumes an exact issuance. It
  does not identify the originating Core call from a raw string.
- The provider installation protocol already uses a Core-owned invocation
  terminal, reached through the selected provider's captured continuation.
  Sharing the contextual API name shares routing without publishing that
  terminal. This is a reusable pattern, not an existing session-resolution
  check: session dispatch currently has no corresponding handshake.

## Historical middleware interview: ownership and name forwarding

The middleware design in this and the following historical sections is
superseded by the context-selected runtime direction. Its accepted behavior
describes that earlier design, not instructions for the replacement.

The Product Owner accepts name-only forwarding continuing to work while Core
preserves the mandatory conversation configuration check. This accepts ownership
of that requirement by the originating Core session-resolution operation;
middleware selecting a name cannot turn it into an ordinary unchecked call.
Matching configuration permits continuation; incompatible or unstated required
configuration refuses before native work. This is a local feature decision,
not a new rulebook entry.

The earlier response to the explanation confirmed understanding. The later
explicit yes to "Should name-only forwarding continue to work, with Core
preserving the check?" accepts the behavior above. It does not approve the
private handshake's wire shape or implementation.

## Accepted provider handshake behavior

After the performance clarification, the Product Owner accepts the proposed
mandatory local exchange for every provider session-resolution call. The
exchange consults Core through the captured continuation before native session
effects. It performs local dispatch and private-state checks; it sends no agent
prompt, contacts no backend and writes no journal event. Activation separately
owns the existing durable configuration save or comparison. No measured timing
is claimed because the exchange is not implemented.

Core keeps the mandatory conversation requirement on its individual session
resolution call. Routing selects a descriptive name without determining whether
the call owes configuration admission. The installed provider consults that
call's Core-owned terminal through its captured continuation before resolution
can create or reattach native state. The admitted request still reaches the
existing delivered coordinator and setup.activate/finish protocol.

```text
Proposed
  Core starts session resolution and keeps its conversation requirement
       |
  middleware selects the descriptive name
       |
  provider consults the call's Core-owned terminal
       |
  provider obtains the admitted request's setup
       |
  activate -> save/compare configuration -> native work -> finish
```

Use of the continuation pattern avoids publishing the requirement in Context
or adding a lookup for an ambient conversation. It is nevertheless a change
to the provider dispatch contract and needs review. The precise private
messages, delivery shape, response settlement and ordinary-call fallback are
not approved by this directional proposal.

The tradeoff is an additional mandatory provider/Core handshake before session
work. In return, routing cannot silently turn the conversation's check off.
Ordinary session calls continue without a conversation configuration
requirement; a raw string does not globally become a retained conversation.
The independent ordinary model/effort routing rules are not silently changed.

## System-boundary interview

Triggered because enforcement ownership moves from the final routed issuance
to the Core-owned call and the provider dispatch contract changes.

Five members are in scope:

1. AgentApi.session — the originating call and what middleware may select.
2. Provider session handler and captured continuation — before-effects admission.
3. AgentLaunchCoordinator.sessionSetup — the authentic admitted request handoff.
4. AgentSessionSetup.activate — durable configuration admission and attempt lifetime.
5. AgentSessionSetup.finish — authoritative completion and the Session Core accepts.

**Member 1 of 5 accepted: originating-call ownership and name forwarding.**
Public signature remains:

```ts
session(name?: string | AgentSessionRequest): Operation<Session>;
```

Accepted behavior: the mandatory conversation requirement belongs to the
originating Core call; the provider must consult its Core-owned terminal before
native resolution work. A routed name cannot decide whether admission is owed.
The public signature alone does not encode that private provider protocol.

**Member 2 of 5 accepted in behavior: provider handler and captured continuation.**
Every provider session handler consults its captured continuation
for the request it may resolve, before native session effects. For a retained
call, Core supplies a request preserving the originating call's mandatory
requirement and the selected descriptive name. For an ordinary call, the
ordinary route retains its existing behavior and acquires no conversation
configuration requirement. The provider then gives the accepted request to
the existing delivered coordinator to obtain its setup. The continuation does
not publish the coordinator or construct a provider-owned setup itself.

This introduces a private request-admission exchange on the existing session
dispatch path. Its exact message types, ordinary terminal behavior and
model/effort routing details still need definition. Behavioral acceptance is
not approval of an unspecified wire interface. Do not write an Implementor
assignment from this draft.

**Members 3 and 4 of 5 conform to the accepted existing interfaces.**

```ts
sessionSetup(request: AgentSessionRequest): AgentSessionSetup;

activate(
  provider: string,
  agentCommand: string,
  configuration?: ProviderSessionConfiguration,
): Operation<Result<void>>;
```

The admitted authentic request reaches the delivered coordinator; its accessor
is not broadened to discover a conversation from a name or ambient state.
Activation continues after command/input preparation and before native session
effects. Complete configuration remains required for conversation work and
optional for ordinary work. One-attempt, acknowledgement and closure behavior
remain the accepted contract. These conforming members need no repeated
Product Owner approval.

**Member 5 of 5 accepted in behavior: authoritative completion.**

The existing method remains:

```ts
finish(session: Session, state: AgentSessionSetupState): Operation<Session>;
```

The Core-owned retained-conversation resolution uses only the
Session completed through its admitted setup. Its private call owner keeps that
completion; an arbitrary Session returned through middleware is not evidence
of activation or completion. If no setup completes, Core refuses before
prompting. Middleware can still refuse the operation by throwing. Ordinary
session result-composition behavior remains its existing contract outside the
Core-owned retained-conversation call.

The Product Owner accepts this after clarification of checking session A and
then using substituted session B. Middleware may influence selection before
validation; it cannot authorize an unchecked replacement after validation.
The conversation's existing native identity rules remain in force.

This follows the existing invocation-owned settlement pattern: the owner reads
what its terminal settled, rather than treating a routing handler's return as
the authoritative outcome. The exact completion witness and private wire
exchange remain to be assembled below.

## Accepted session inspection exchange

The five session-resolution responsibilities and the concrete local
inspect/request message and delivery shape are accepted by the Product Owner:

```ts
type AgentSessionRoute = string | AgentSessionRequest | undefined;

type AgentSessionCall =
  | AgentSessionRoute
  | {
      readonly intent: "inspect";
      readonly request: AgentSessionRoute;
    };

interface AgentSessionDelivery {
  readonly request: AgentSessionRoute;
}
```

An installed provider's session handler asks its captured continuation with
`{ intent: "inspect", request: routed }` and reads the structurally validated
delivery. In an owned conversation call, the invocation terminal returns a
genuine request carrying its mandatory requirement and selected name. In an
ordinary call, the ordinary terminal returns the ordinary routed value. The
provider's existing object-request versus raw-name handling then resolves the
delivered request. Only an object request reaches sessionSetup; neither the
inspection message nor delivery carries a coordinator, configuration values
or a public conversation/retained flag.

Normal Agent.session callers keep the existing typed signature returning
Operation<Session>. The provider-facing wire view supports the private exchange
under the existing stable Agent API name and session operation. Sharing that
name composes routing; the individual Core descriptor owns its terminal. Do
not expose an invocation terminal as a contextual value or turn ordinary user
session results into unknown. The exact TypeScript arrangement of those typed
views is delegated implementation structure, subject to no unsafe casts.

The inspection's only input member is the routed request. It says what
middleware selected, not whether admission is owed. The delivery's only member
is the request Core permits the provider to resolve. Session completion remains
on the existing setup, observed privately by the Core-owned call; it is not a
new public inspection message or an arbitrary dispatch return.

The explicit sure to the inspect/request interface accepts this shape. A
delivery must actually contain its request member, including when that member
is undefined for a valid ordinary unnamed route. No valid delivery is a refusal,
not evidence that the call is ordinary. The new exchange remains unimplemented.

## Accepted boundary extension: prompt dispatch

The Product Owner accepts extending the same Core-owned requirement through
actual prompt dispatch. Session resolution alone is not the complete correction.
The direction is accepted; the prompt protocol below remains under review.

Assembly of the complete before-effects trace exposes a further supported
session substitution point. The original five-member session-resolution
boundary cannot, by itself, enforce that the completed session is the one
the Sidekick actually uses.

Direct trace at unchanged 08c95ca2:

1. conversationTurn passes its completed Session to runPrompt in PromptOptions.
2. function-components.ts runPrompt calls Agent.operations.prompt(text, options).
3. Public Agent.prompt middleware can replace options.session. The ordinary
   configured-use specification expressly permits selecting another whole
   Session or an unconfigured route.
4. ACP's prompt handler returns a cold stream. On subscription, promptStream
   reads the final options.session, prepares that route, constructs/reattaches
   it through ensureFromPrepared and starts the turn. It does not call the
   public Agent.session handler or sessionSetup/activate on that path.

Source: core/src/agent/function-components.ts runPrompt around line 444;
acp/src/provider.ts installed prompt handler around line 731 and promptStream
around lines 2612–2760; specs/acp-client-spec.md ordinary configuration routing
around lines 349–361. This is a direct data-flow trace, not a newly executed
probe or a claim of additional passing/failing test evidence.

```text
Session resolution: Core checks A -> finish(A)
                                        |
Prompt middleware replaces A with B      |
                                        v
ACP prepares B -> ensures B -> starts turn in B
```

The structural invariant is the same already accepted one: mandatory
conversation configuration cannot be waived by routing before native work,
and approval of A cannot authorize unchecked use of B. This record explicitly
extends the correction boundary to Agent.prompt and its cold subscription
following the Product Owner's sure to that proposal. It does not declare the
session-only proposal sufficient or assign implementation yet.

The Core-owned requirement lives through the retained turn's
actual prompt dispatch as well as its session-resolution call. The provider
must consult that prompt invocation's Core terminal before the subscription
can create/reattach a native session or start a turn. The check remains local;
ordinary prompts retain their ordinary routing behavior. The completed session
and actual provider construction configuration must remain subject to the
owned requirement at this second effect boundary.

This adds a sixth member to the boundary interview: Agent.prompt and its
provider subscription. Its private messages, delivery and relationship to the
accepted one-attempt setup protocol are reviewed below. The session
inspect/request shape is accepted; no prompt wire shape is yet approved.

## Withdrawn prompt protocol

Use two local exchanges through the provider's captured continuation, inside
the cold subscription. Each exchange answers through the owning invocation's
Core terminal. Ordinary prompt callers retain:

```ts
prompt(content: string, options?: PromptOptions): Operation<Stream<AgentPromptEvent, string>>;
```

First inspect the routed prompt, before route preparation:

```ts
interface AgentPromptInspection {
  readonly intent: "inspect";
  readonly content: string;
  readonly options: PromptOptions | undefined;
}

interface AgentPromptDelivery {
  readonly content: string;
  readonly options: PromptOptions | undefined;
}
```

The owned conversation terminal requires the selected Session to be the exact
completed use for this turn and preserves the conversation's selected agent.
A replacement is refused before its route is prepared or native state is
opened. The final routed content and ordinary non-identity prompt options keep
their existing composition. An ordinary terminal returns the ordinary routed
content/options without adding a conversation requirement. The provider uses
the delivered prompt, not unchecked original arguments. Both delivery members
are required; undefined options is a valid ordinary value, not a missing reply.

After preparing the resolved command and construction inputs, activate before
constructRoute, ensureFromPrepared or startTurn:

```ts
interface AgentPromptActivation {
  readonly intent: "activate";
  readonly provider: string;
  readonly agentCommand: string;
  readonly configuration: ProviderSessionConfiguration | undefined;
}

// The terminal answers Operation<Result<void>>.
```

The three data members reuse the existing setup.activate contract. The owned
terminal compares actual construction inputs using the same private
configuration admission function as session activation. Session resolution
has already saved the initial configuration, so prompt activation compares it
and appends no new event. An ordinary terminal answers Ok without requiring a
complete provider configuration. A missing/invalid activation reply is a
refusal, never permission to continue.

This activates the prompt invocation, not the session setup that already
finished. The provider does not reactivate a spent setup, obtain a second
session or duplicate model/effort application. The prompt invocation owns one
activation attempt. Its terminal stays live through subscription and joined
cleanup; returning a cold stream alone is neither activation nor a native turn.
No subscription means no preparation, activation or native work.

The Core-owned call preserves authoritative activation/refusal state, so a
returned or wrapped stream cannot stand in for the provider reaching its gate.
Core accepts no purported turn without the required admission. Existing
canonical native assertions, stream auditing and fatal-durability precedence
remain required. This does not introduce another Prompt record grammar.

The private provider-facing wire view supports the two messages under the
existing Agent prompt operation. Public prompt return typing remains unchanged.
No new coordinator accessor, public scope flag, prompt option, Session property
or replaceable authority context is introduced. The captured continuation is
used unchanged; neither it nor its metadata is mutated.

Historical question: accept the prompt inspect(content, options) exchange,
followed by activate(provider, agentCommand, configuration), before native work?

## Accepted API direction: context-selected conversation runtime

The Product Owner approves capturing this as a reusable pattern and revisiting
other API choices later. The
[approved API selection record](../api-selection-pattern-proposal.md) contains exact
approved rules, the matching Code Rule 15 amendment and deferred review
candidates. Those rules are recorded in the main checkout. They assign no
other API refactor.

The reproduced risk comes from trusted host middleware changing the route,
not from an agent response installing TypeScript middleware. The original
proposal grew into mandatory exchanges on all provider session and prompt
calls to preserve the requirement through that composition. The Product Owner
questions that cost and suggests using a Context instead.

Under the approved pattern, the host installs a conversation runtime as a scoped
service; Core captures that service for one live conversation opening and
calls its session/prompt operations directly. Ordinary Agent middleware can
retain its composition elsewhere. Context selection is trusted host
configuration. Core still privately owns the saved conversation binding,
active configuration admission and canonical history; a Context value is not
an authorization flag or a replacement durable identity record.

```text
Host installs conversation runtime in Context
                    |
Core captures runtime for the live conversation
                    |
Core invokes its session/prompt operations directly
                    |
Existing Core activation and canonical recording
```

This replaces the inspection proposals. The scope is retained conversation
operations, not a global replacement of the ordinary Agent API.

The provider already separates implementation state from Agent middleware in
AcpxProviderState and createPartitionedAcpxProvider. That is a useful code seam,
but the public AcpxProvider handle is not a drop-in authoritative conversation
runtime: its session path receives no Core coordinator and its prompt handle
does not expose the canonical checkpoint delivery. A concrete context-bound
runtime must preserve the installed provider's existing Core coordination and
lifetime without publishing the coordinator itself. No interface is yet frozen.

AGENTS.md Code Rule 15 now permits Context-selected services under the approved
general pattern. No Sidekick-only exception is needed. Its separate
requirement that enforcement, durable identity and reconciliation never trust
replaceable context state still applies: the Context selects a service, while
Core keeps those authoritative records privately.

Next Architect action: review the concrete context-selected runtime methods,
Core coordination handoff and lifetime. It replaces composable session/prompt
routing for retained conversations; ordinary Agent composition remains outside
this change. Apply the approved rules without asking for this direction again.

## Concrete runtime boundary: interview in progress

The Context selects the installed provider service. The Core conversation
continues to own the requirement, logical identity and canonical history;
one-use issuance carries the link needed by the provider's existing setup.
There is no requirement, saved identity or authorization flag stored in Context.

The previous question of which handle a forwarded name reaches is superseded:
retained conversation execution does not route its session or prompt through
ordinary Agent middleware. Core passes its original opaque request directly
to the captured runtime and then uses the completed Session directly. Ordinary
Agent name routing remains an extension point elsewhere. The original probes
remain unchanged; the correction makes their name-forwarding middleware
irrelevant to retained execution, rather than repairing forwarded strings.

### Proposed members and ownership

Five members are in scope:

1. Provider service capture — binds one actual provider runtime to the Core
   conversation's live scope.
2. Agent resolution — resolves this conversation's explicitly selected agent.
3. Session resolution — consumes the genuine Core request for that selected
   agent and uses the existing delivered setup/activation contract.
4. Options inspection — uses the same runtime for the explicit options job.
5. Prompt execution — uses that runtime and completed Session through the
   existing canonical runner, cold-stream ownership and checkpoint recording.

The implementations must not reenter ordinary Agent.session or Agent.prompt
dispatch internally, which would reopen the same substitution seam. Selected
agent resolution must also stay consistent across session and prompt work;
capturing an object that silently switches provider state on later calls does
not satisfy fixed runtime selection. Prompt permission auditing and canonical
checkpoint delivery remain required; the public AcpxProvider handle alone is
not a substitute for the installed provider's Core-bound operations.

### Correction: no additional capture method

The proposed capture() method is withdrawn. It introduced another object and
operation without demonstrating why selecting the provider object through
Context was insufficient. The five-member inventory above is historical;
provider selection does not require a new public method.

When the Sidekick chat opens, Core reads the provider object from Context once
and uses that same object for the chat. Core calls its methods directly instead
of sending retained conversation operations through ordinary Agent middleware.
Reading the object opens no native session, starts no turn and writes no
journal event. A missing provider is a refusal, with no middleware fallback.

Core keeps its configuration checks, session identity and conversation history.
The provider keeps its existing connection to Core private. Existing permission
auditing, prompt recording, stream cancellation and cleanup remain required.
Selecting an object must keep the actual provider state consistent across its
calls; a public factory layer is not prescribed to achieve that.

That remaining design work is now specified in the consolidated handoff linked
above. The Planner replaces the old correction assignment with a bounded
implementation and test assignment at 08c95ca2. This interview record is not
that assignment; P1, increment 4 and R2 remain open, and P2 stays closed.

## Continuity

No new test, source edit, worktree/index change, commit, push, GitHub mutation or
CI inspection occurred in this architecture turn. Existing probes and their
first outputs remain unchanged. R2 and increment 4 remain unaccepted. The
unchanged-request control and real-ACP name-forwarding regression remain the
bounded correction evidence; Planner assigns their permanent destinations
after the architecture decision. Mounted section 5 and terminal work remain
separate.
