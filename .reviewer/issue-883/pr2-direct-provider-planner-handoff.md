# Planner handoff: direct provider calls for Sidekick conversations

**Assignment closed:** both exact-commit reviews pass at signed clean
004de839. Increment 4 is accepted and R2 is complete under
[the reconciliation](pr2-r2-completion-reconciliation-004de839.md).
No correction remains assigned here; mounted work needs its next bounded plan.

**Planner implementation PASS:** signed clean
`004de839e85e53cff4d960cb515729d350383f30`, parent 08c95ca2, satisfies DP1–DP5
and SC1–SC7 under [the review](pr2-direct-provider-planner-review-004de839.md).
The assignment below is completed for Planner review. The Implementor holds
for the separate Architect review; no next slice opens.

**Ready for implementation.** Correct P1 in one coherent increment based on
`08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`. A saved Sidekick conversation uses
one installed provider object for agent selection, session setup, options and
prompts. Ordinary Agent middleware cannot redirect that conversation around
its configuration check or substitute another session at prompt time.

P2 is closed. This assignment replaces the old routing hold; it does not accept
P1, increment 4 or R2 before implementation and review.

## Authority and exact base

- [Architect handoff](pr2-direct-provider-architect-handoff.md): current and
  decision-complete, including the four methods, ownership and audit contract.
- [Planner assignment request](pr2-direct-provider-planner-prompt.md).
- [Architect P2 review](pr2-configuration-result-architect-review-08c95ca2.md)
  and [Planner P2 review](pr2-configuration-p2-planner-review-08c95ca2.md): closed.
- [Routing finding and preserved reproductions](pr2-configuration-request-routing-architect-return.md).
- [Configuration plan](pr2-session-configuration-planner-handoff.md): SC1–SC7
  remain required; its middleware-based dispatch is superseded here.
- [Configuration handback](pr2-session-configuration-implementor-handback.md)
  and [Result correction handback](pr2-configuration-result-implementor-handback.md).

Implementation worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Branch: `agent/issue-883-pr2`.
Base: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
Parent: `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`.
Planner verified this signed G revision and a clean implementation worktree.
Main checkout was `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`, with unrelated
local edits. Planning records and the newly approved instructions live there.
Do not copy whole main-checkout files over the implementation branch.

No rebase, reset, amend, dependency change or independent main PR is assigned.
If the implementation tree advances, reconcile its actual delta before work;
do not discard it or silently change the base.

## Current path and correction

At this base, conversation.ts serves a mailbox inside AgentConversationHost.
held() replays configuration and turns, waits for the execution's bound root
evaluator, then announces readiness. Each live turn uses Agent.operations.agent
and Agent.operations.session, and runPrompt uses Agent.operations.prompt.
inspect() uses Agent.operations.options. Session selection and prompt dispatch
are therefore independently interceptable.

ACP's resolveSession obtains a delivered setup only for a request object.
Forwarding its name selects an ordinary string route, skipping activation.
The preserved real-ACP probe answers a turn with one native ensure and zero
configuration records. A prompt handler can separately replace options.session
after another session was checked. Both paths are corrected together.

The existing pieces stay authoritative: private request issuance, activate and
finish, configuration save/compare, native assertions, runPrompt, persistPrompt,
publisher association and the conversation's cancellation/join protocol.

## Fixed interface and lifetime

Add `packages/core/src/agent/conversation-provider.ts`. Export the interface
and Context under the single name AgentConversationProvider from
`@executablemd/core/api`, without an alias in another public surface:

```ts
export interface AgentConversationProvider {
  agent(name: string): Operation<string>;
  session(request: AgentSessionRequest, agent: string): Operation<Session>;
  options(agent: string, request?: AgentOptionsRequest): Operation<AgentOptions>;
  prompt(
    content: string,
    options: PromptOptions & { agent: string; session: Session },
  ): Operation<Stream<AgentPromptEvent, string>>;
}

export const AgentConversationProvider =
  createContext<AgentConversationProvider | undefined>(
    "executablemd.agent.conversation.provider",
    undefined,
  );
```

All referenced types already exist. The interface and Context share a name as
Agent does. The provider factory signature remains
AgentProviderFactory(options, coordinator): Operation<void>.

The installed object selects trusted behavior. It carries no coordinator,
configuration approval, permission flag, history mapping or completion receipt.
Core reads it once in held(), after provider installation and before readiness,
and passes that local value to the jobs. A later Context selection cannot alter
an open conversation. Reading the Context starts no provider work; cold opening
and replay call none of its four methods.

Missing service means an AgentConversationError explaining that the provider
does not support saved conversations. Use the existing readiness/refusal and
resource-release path. No fallback, provider call, configuration or Prompt
record, or completed durable root follows from this refusal.

The object has its installing provider's lifetime. Each method checks the
existing concrete state's liveness. A retained reference refuses after closure.
Obtaining a prompt stream remains cold; its liveness check and native work
belong inside subscription. Closing the conversation joins its jobs and their
cleanup before its provider is released.

## Ordered work in one feedback increment

### 1. Install the fixed service for one ACP state

createAcpxProvider already acquires one useAcpxProvider handle. Install the
four-method object alongside its ordinary Agent handlers for that exact state
and the coordinator delivered to the factory. Reuse the module-private state
lookup and liveness checks. Keep the coordinator in closures, never on the
Context value, AcpxProvider handle or Session.

Reuse resolveAgent, resolveSession/openSession, inspectAgentOptions and
promptStream. Give the direct session and prompt paths the explicit resolved
agent through local helpers; neither may reenter Agent.operations.agent.
Keep ordinary entry points' contextual agent selection and routing unchanged.
The direct session method accepts the original genuine request, not a string.
Its existing activation remains before route publication, construction,
reattachment or ensure, with finish only after success.

createPartitionedAcpxProvider remains a per-dispatch selector for ordinary
Agent operations. Do not cache that selector or invoke it at installation when
no partition is current. It does not promise the new fixed service. TestAgent
and Plan continue using their existing ordinary path. No support for saved
conversations over a dynamically selected collection is assigned.

### 2. Retain private proof of the exact completed Session

Extend session-request.ts's private issuance and session-setup.ts internally.
Record which exact Session finish successfully returns, including the authentic
configured-use wrapper. Record nothing when configuration or finish is refused
or cancelled. Local helper/field names and factoring are delegated.

The conversation accepts only that exact result for its own original request.
A returned arbitrary Session, or a replacement after a genuine finish, refuses
before Core asks for a prompt stream. Do not infer completion from activation,
acceptance, session shape or key equality. Keep the configured use intact.
This completion check does not replace activate's before-effects check.

Keep one-use consumption, issuance closure in finally, one-attempt activation,
provider closure and delivered activate/finish receiver binding. No public
completion callback, brand, accessor or coordinator member is added.

### 3. Move the conversation's jobs onto the captured object

held() captures the object and refuses readiness when it is absent. Pass it
through deliver/conversationTurn and inspect using ordinary local parameters.
For a live turn, call provider.agent(request.agent), open the existing request
with admitting(active), seal its model/effort, and call provider.session with
that original request and resolved agent. Confirm private completion before
prompting. Close the issuance on every path.

Remove the conversation-only Agent.around agent binding and all four ordinary
Agent dispatches from this chat path. Keep pre-turn and completed-record native
identity checks. Explicit options uses the same provider and selected agent;
its disposable inspection remains allowed, sends no model prompt and saves
no conversation configuration. Generated-root evaluation stays the third job
on the same mailbox and needs no provider call.

### 4. Reuse the canonical prompt consumer and its audit

Pass the provider into the existing internal runPrompt path so it obtains the
direct cold stream. Ordinary Prompt components still obtain their streams
through Agent.prompt. Do not duplicate the consumer or Prompt record builder.

journal.ts currently wraps streams inside observePermissionDecisions's Agent
prompt middleware. Extract/reuse that internal wrapping for direct streams.
Both paths receive one audit for the exact stream runPrompt consumes. Keep the
requestPermission observer outside policies, arrival-order reservation,
scope-local ledger and exact-stream completedPromptAudit lookup. No public
audit API or provider-created ledger is added, and no stream is audited twice.

Preserve publisher begin, carried begun/association, started and terminal
events, coordinator-issued checkpoint association, actual configuration from
the started Session, partial failure text, sequence allocation, durability
precedence and joined stream cleanup. Obtaining a stream without subscribing
does no work. Reuse persistPrompt for live recording and replay.

### 5. Migrate affected fixtures and align documentation

Core agent-conversation.test.ts's stub currently implements only Agent
middleware. Install the new object inside its real provider factory, using
the supplied coordinator for genuine setup and checkpoint completion. Preserve
SC1–SC7, nondefault-agent, options, busy, cancellation, native identity and
generated-root claims. CV1a/CV1b's unnamed/named middleware-lookup observations
become observations of explicit selected-agent arguments on the direct calls;
do not preserve a retired lookup by reentering Agent middleware from the stub.

ACP host-conversation and the CLI Sidekick fixtures already use the production
createAcpxProvider assembly. Keep them on that assembly, including the real
subprocess history/store and the trusted differing-systemPrompt construction.
Keep CLI assembly.ts's empty native tools/MCP servers,
deny-all/strict/noninteractive-deny permissions, null prompt customization,
dedicated agent and existing model/effort behavior. No new selection mechanism
or program.ts owner acquisition is needed.

Update specs/acp-client-spec.md's provider-factory, retained-conversation and
permission-audit contracts; executable-mdx-spec.md's affected Agent expectations
and module roster; and architecture.md's conversation, audit and provider
descriptions. Replace the chat's Agent-middleware agent-binding explanation.
Keep ordinary name/session composition and ordinary optional configuration.
Align Core api.ts documentation and touched source comments with these paths.
Change repl-spec.md only if an existing statement is made false by this patch.

Carry exactly the approved main-checkout architecture rules 23–25 and their
explanatory paragraph, plus the Code Rule 15 amendment, into the branch where
absent. Their accepted wording is recorded below. Do not copy unrelated rules,
architecture prose, Architect instructions or other local main edits.

```text
23. Use methods on an owned handle for operations tied to that instance.
24. Use a Context to select a scoped service; capture it for any lifetime that requires a fixed provider.
25. Use middleware when per-call interception or transformation is an intended extension point.

Rules 23–25 choose the API by ownership and intended composition. A captured
service keeps provider selection fixed for its consumer's lifetime; its mutable
configuration still follows that service's own update contract. A Context
selects a trusted service, while authorization, durable identity,
reconciliation and canonical outcomes stay with their owners.

15. State shared across loaded copies uses stable, namespaced names. Use owned
    handles for instance operations, Context for scoped service selection, and
    contextual Api middleware for intended per-call composition.
    Security enforcement, durable identity, and reconciliation never trust
    replaceable context state.
```

## Affected files and boundaries

| File or fixture | Required responsibility |
| --- | --- |
| Core agent/conversation-provider.ts, api.ts | Fixed interface/Context and its single consumer-facing export |
| Core agent/conversation.ts | Capture once, readiness refusal, direct jobs, exact completion check |
| Core agent/session-request.ts, session-setup.ts | Private completed-result evidence; existing activation and configured use |
| Core agent/function-components.ts, journal.ts | One canonical runner, internal direct-stream audit reuse |
| Core agent/components.ts | Preserve audit observer placement and provider teardown; edit only if extraction requires it |
| Core agent/provider-api.ts | Preserve factory/coordinator signature and structural, receiver-bound setup adapter; no widened accessor |
| ACP provider.ts | Concrete fixed-state object and local explicit-agent internal paths; ordinary partition selector stays dynamic |
| Core agent-conversation.test.ts | Migrate conversation stub; completion, readiness, direct audit/checkpoint evidence |
| ACP host-conversation.test.ts | Permanent real-ACP missing-configuration and routing/prompt-substitution regression |
| Core agent-function-components.test.ts; ACP loaded-copy.test.ts | Preserve ordinary audit/publisher and delivered cross-copy setup behavior |
| Existing CLI Sidekick tests and issue-883 fixtures | Preserve real owner/assembly, subprocess recovery and configuration evidence |
| Specifications, architecture and exact approved instructions above | Describe the implemented boundary without copying unrelated main edits |

Helpers and fixture extraction are delegated. Do not add a new abstraction
without a consumer in this correction, or split commits while the chat has
changed paths but its provider, configuration checks or audit are missing.

## Frozen evidence: DP1–DP5 and SC1–SC7

Rows are observable consequences, not a required number of test functions.
Share existing fixtures and combine observations where practical.

| Row | Finite observation and defect it discriminates | Permanent destination |
| --- | --- | --- |
| DP1 — missing configuration despite routing | Real Core conversation plus real createAcpxProvider with incomplete configuration and installed direct service. Unchanged-request control and installed ordinary name-forwarding handler both refuse for the specific missing-configuration reason, with zero native ensures/turns and no configuration record. An unsupported-service refusal is a failure of this test. | ACP host-conversation.test.ts; promote the preserved real-ACP probe's two arms |
| DP2 — exact provider, agent and session | One complete-configuration real-ACP conversation succeeds, with acknowledgement before native effects. Install ordinary agent/session-name and prompt-session rewriting handlers together. The chat bypasses them (handler counts zero), resolves the explicitly selected nondefault agent, and its prompt uses the genuine completed Session/native identity. Give the prompt handler a different-session canary so reaching it would change the observed destination. The saved configuration and native identity remain its own. | ACP host-conversation.test.ts; retain CV1a/CV1b and CLI nondefault switch/reopen controls |
| DP3 — original request actually finished | Through the installed direct Core test provider, returning a raw Session without finish refuses with zero prompt-method calls; finishing genuinely and returning another Session also refuses with zero prompt calls. Positive control returns the exact successful finish result with authored model/effort, and the same authentic configured use reaches prompt and its retained configuration. Keep existing SC3/SC4 tests for refused activation, cancellation and closure; no new lifecycle matrix. | Core agent-conversation.test.ts, with existing agent-session-setup/session-use tests |
| DP4 — direct turn keeps audit and checkpoint | One saved conversation turn through the direct service, using the existing permission/publisher fixtures. Two decided permission requests retain their safe fields and outcomes exactly once in arrival order; the existing controlled reverse-settlement fixture may be reused. Supply a checkpoint for that exact terminal through the factory-delivered coordinator. Publisher begin runs once before provider prompting; publish sees that same begun value plus the checkpoint and the actual session key, appends once, and the canonical Prompt retains the audit and started configuration. No private checkpoint writer or hand-built Prompt record substitutes for this path. | Core agent-conversation.test.ts, reusing AF audit/publisher fixture mechanics; ordinary AF suite remains unchanged in claim |
| DP5 — readiness and preserved jobs | One ordinary-middleware-only provider yields the explicit unsupported-saved-conversation readiness error, invokes no agent/session/options/prompt work, writes no configuration/Prompt or root terminal, and releases the execution. Existing configured provider cold-open/replay, explicit options, Stop/join and generated-root rows stay green. Source review establishes a single Context read, fixed concrete state, liveness checks on every method and cold subscription; no hostile Context replacement or new lifetime permutation matrix. | Core agent-conversation.test.ts plus existing Core/ACP/CLI selections |

Keep all seven configuration criteria: SC1 complete construction values and
detached/frozen copy; SC2 compatible/incompatible real-process reopen; SC3
missing configuration and finish ordering; SC4 activation cancellation/closure;
SC5 delivered receiver binding; SC6 R2m2 assertion window; SC7 preserved
consumers. The original matrix remains available in the linked configuration
plan. Do not weaken multiple-outcome, unknown acceptance, no-resend or native
identity assertions to accommodate fixture changes.

The preserved red real-ACP routing probe and its green control are the P1
before evidence. Run it unchanged after correction as specified below, and
promote its cases into the permanent corpus. The historical Core probe embeds
a middleware-only stub and remains forensic evidence; it is not an unchanged
compatibility requirement for the retired conversation fixture. Do not modify
either original probe or any first-output log.

SC2's previously recorded comparison mutation remains evidence if comparison
code is unchanged. If this patch changes that comparison, repeat only its
existing compatible/incompatible control, verify the mutation applied, preserve
the first output and restore before the final runs. No mutation per DP row or
additional policy/configuration permutation matrix is assigned.

## Focused commands for the feedback commit

Run from the implementation worktree after the final source/specification edit:

```text
deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts

deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts

deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts

deno task test packages/core/tests/agent-function-components.test.ts

deno task test packages/acp/tests/loaded-copy.test.ts

deno test --config ./deno.json --allow-all --filter 'ACP configuration request routing probe' /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configuration-acp-request-routing-ef68c71c.probe.ts
```

The first three are the original frozen selections. The fourth covers the
shared canonical prompt runner, ordinary routing, permission audit and publisher
failures. The fifth covers the known ACP integration with a foreign Core's
delivered activate/finish adapter, touched by private completion bookkeeping.
Provider.test.ts already covers ordinary ACP checkpoint metadata and dynamic
partition behavior. The final command preserves the exact original real-ACP
regression independently of its permanent integration.

These six commands are the finite feedback selection. No full lint, check,
JSR, runtime suite, packaging or CI gate is a prerequisite. Public export checks
and exhaustive runtime checks remain delivery work. Follow repository formatting
and coding rules while editing; P2 must remain fixed. Preserve a failure's first
output before rerunning, and report an environment limitation separately from
product evidence. Do not repair dependencies or shared caches as part of this
assignment. If an actual patch exposes another concrete black-box consumer,
report it for selection reconciliation rather than silently replacing the matrix.

## Exclusions and handback

No settings UI, live configuration update, replay migration, new journal
format, per-call session/prompt inspection exchange, capture() method, permission
Context flag, broader coordinator, public completion receipt, global ordinary
session restriction, other API refactor, provider-registration/Git-host change,
mounted section 5, program owner acquisition, terminal packet, push, GitHub
mutation or CI inspection. Native identity and canonical outcomes stay in Core.

Once the assigned focused evidence passes, make one signed feedback commit
promptly. Do not wait for delivery checks or amend the base. Hand back exact
SHA, parent, branch, signature, tree status, every focused command/result, a
DP1–DP5/SC1–SC7 mapping and any fixture assertion adaptations. State whether
the configuration comparison changed and whether its prior control is reused.
Stop for Architect review of the exact correction and Planner evidence review.

## Continuity

Exact starting SHA: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
Produced artifacts: this plan and
[the ready-to-send Implementor prompt](pr2-direct-provider-implementor-prompt.md).
Settled: four methods, Context selection once, direct fixed-state ACP calls,
Core-private completion, existing activation, shared canonical prompt/audit,
unchanged SC1–SC7 and the six commands. P2 remains closed. No architecture
choice is delegated. P1, increment 4 and R2 await implementation and review.
Next action: execute the replacement prompt on the verified clean base, return
one signed correction after focused evidence, and stop for review.
