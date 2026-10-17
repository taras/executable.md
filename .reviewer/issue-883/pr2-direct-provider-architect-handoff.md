# #883 PR 2: call the selected provider directly for saved conversations

When a Sidekick chat opens, Core gets its provider object from Context once.
Every subsequent chat operation uses that object directly. Ordinary Agent
middleware therefore cannot change the session that receives a Sidekick message
or turn its required configuration check into an optional one.

This is the Architect disposition for P1, ready for the Planner to turn into a
replacement implementation assignment. It completes the concrete design under
the Product Owner's approved Context-selection direction and architecture rules
23–25. It is not an implementation PASS, completion of R2, or permission to
skip the Planner's bounded assignment.

## Starting point

- Implementation worktree:
  `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
- Branch: `agent/issue-883-pr2`.
- Exact base: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
- Parent: `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`.
- Worktree checked clean at this base during preparation of this handoff.
- P2 is closed. P1, increment 4 and R2 remain unaccepted pending correction.

Review records live in the main checkout under `.reviewer/issue-883/`, outside
the implementation worktree. Read this handoff as the current disposition;
earlier inspection protocols and the proposed capture() method are withdrawn.

## The defect this corrects

At the base, Core sends the chat's session request through `Agent.session`
middleware. A supported handler forwards only `request.name`. ACP sees a string,
does not obtain the original request's setup, and skips `setup.activate()`.
Core accepts the returned Session and sends a turn. The actual ACP probe shows:

```json
{"answered":true,"ensures":1,"turns":["first"],"configurationRecords":0}
```

The unchanged-request control refuses the missing configuration with zero
ensures. The [Architect return](pr2-configuration-request-routing-architect-return.md)
and [review at 08c95ca2](pr2-configuration-result-architect-review-08c95ca2.md)
preserve the evidence and first outputs.

There is a second occurrence of the same design problem: prompt middleware can
replace `options.session` after session resolution has checked a different
session. Guarding only session resolution leaves that substitution possible.
The direct provider path covers both operations, together with agent selection
and options inspection so the chat consistently uses its own provider.

```text
Today
  Core chat -> Agent.session middleware -> provider resolves a session
           -> Agent.prompt middleware  -> provider sends a turn
                  |
                  +-- either middleware call can change the session

Correction
  Provider installation puts its provider object in Context
                  |
  Core chat reads that object once
                  |
                  +-> provider.agent(...)
                  +-> provider.session(original request, selected agent)
                  |      |
                  |      +-> existing setup.activate(...) before native work
                  |      +-> existing setup.finish(...)
                  |
                  +-> Core's existing prompt runner
                           |
                           +-> provider.prompt(..., the completed Session)
                           +-> permission audit and canonical Prompt record
```

Context selects trusted host behavior. Core still owns the configuration
requirement, session-request completion and saved history. Context contains no
permission flag, configuration approval, history mapping or coordinator.

## Provider object: four methods

Add `packages/core/src/agent/conversation-provider.ts`. Export the Context and
its interface from `@executablemd/core/api`, following architecture rule 7.
Do not add a second export alias or replace the existing `Agent` API.

The interface and Context use the same TypeScript name, as `Agent` already uses
one name for its type and value. The exact contract is:

```ts
export interface AgentConversationProvider {
  /** Resolve the agent selected for this conversation. */
  agent(name: string): Operation<string>;

  /** Resolve the original Core request under the selected agent. */
  session(request: AgentSessionRequest, agent: string): Operation<Session>;

  /** Read the selected agent's advertised model and effort choices. */
  options(agent: string, request?: AgentOptionsRequest): Operation<AgentOptions>;

  /** Return a cold turn stream for the exact Session Core supplies. */
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

The types other than this interface already exist. There is no new request
field, settings surface, factory return type, `capture()` operation, launch
method or separate provider-runtime type. The direct prompt uses the existing
Operation-of-Stream shape so obtaining the stream does not subscribe to it.

| Member | Existing implementation to reuse | Required difference for a chat |
| --- | --- | --- |
| `agent` | ACP's local `resolveAgent` | Resolve through this provider, without `Agent.agent` middleware. |
| `session` | ACP's `resolveSession` / `openSession` and delivered setup | Require the genuine Core request and an explicit agent; no string or default-agent route on this method. |
| `options` | ACP's `inspectAgentOptions` | Inspect through the same selected provider object. |
| `prompt` | ACP's `promptStream` and Core's `runPrompt` | Use the explicit agent and exact completed Session without `Agent.prompt` middleware. |

These methods are a direct service selected under rule 24, and operations on
one installed provider under rule 23. Middleware remains appropriate for the
ordinary Agent API under rule 25. No product setting or new durable convention
is introduced by these signatures.

## Installation, selection and lifetime

Keep `AgentProviderFactory(options, coordinator): Operation<void>` unchanged.
A provider that serves saved conversations installs the object in its own
provider scope, alongside any ordinary Agent middleware it provides. Core
continues delivering the existing coordinator directly to that factory.

Core reads the Context once inside `AgentConversationHost`, after provider
installation and before reporting the conversation ready. The resulting object
is a local value passed to the conversation's jobs. It is not looked up again
on every prompt or options call. Resolving the selected agent remains explicit
work for a job; reading the Context must not probe an agent, create a runtime,
ensure a native session, send a turn or save configuration.

If no object is installed, opening the conversation answers an
`AgentConversationError` explaining that its provider does not support saved
conversations. There is no fallback to Agent middleware. Do not append a
configuration or Prompt record, start provider work, or finish the durable root
as a consequence of that readiness refusal. Use the existing readiness/refusal
and resource-release path.

The object remains tied to the provider that installed it. A later Context
selection cannot change an already-open chat; a later chat reads the selection
in its own scope. Closing the chat cancels and joins its work before releasing
its provider. A kept provider reference does not extend that lifetime: methods
must refuse after their provider closes. Prompt lifetime checks belong inside
subscription so the stream remains cold.

For ACP, `createAcpxProvider` already owns one concrete `useAcpxProvider` handle.
Install the direct object for that exact state and the coordinator delivered
to that factory. Reuse the module's private state lookup and liveness checks;
keep the coordinator in provider closures, without exposing it on the Context
value, public `AcpxProvider` handle or Session.

The existing `createPartitionedAcpxProvider(select)` continues to select state
per ordinary Agent dispatch. Do not cache its selector across sibling tests or
invoke it at installation when no test state is current. It does not by itself
claim to supply a fixed provider object for saved conversations. Existing
TestAgent/Plan paths use ordinary Agent operations and keep their behavior.
Adding saved-conversation support to a dynamically selected collection of
provider states is outside this correction. A host serving a saved conversation
must install an object for one concrete state in that conversation's scope.

Custom conversation test providers must install the direct object. A provider
that implements only ordinary Agent middleware remains usable for ordinary
Agent work and now receives the explicit unsupported-conversation refusal if
used with `useAgentConversation`. Do not silently adapt it by calling that
middleware from the new methods.

## Session checks stay in Core

For each live turn, Core calls the selected object's `agent(request.agent)`,
opens the existing one-use session request with `admitting(active)`, and seals
the job's model/effort request as it does today. It passes the original request
and resolved agent to `provider.session` directly.

The provider uses the existing delivered `sessionSetup(request)`. It resolves
the command and construction inputs, then calls `setup.activate(provider,
command, configuration)` before route publication, native construction or
reattachment/ensure. Missing configuration refuses. The first successful
activation saves and acknowledges the detached configuration; later activations
compare it and append nothing. Only success permits provider work and `finish`.
The ordinary setup path remains optional with respect to provider configuration.

Core also retains private evidence of which Session the original request
finished with. Extend the existing issuance/setup implementation internally to
record the exact result after `finish` succeeds, including any configured-use
wrapper. The conversation accepts only that exact result. A provider returning
an arbitrary Session without finishing this request, or returning another value
after finishing it, refuses before Core asks for a prompt stream.

This evidence stays on Core's existing private issuance. Do not add a public
completion callback, receipt, Session brand, coordinator accessor or Context
flag. Internal field/helper names are delegated. Preserve the delivered
activate/finish adapter and its receiver binding across loaded copies.

The result check confirms the provider completed the required setup; it is not
the before-effects configuration check. That check remains `activate` inside
the provider before native effects. All activation cancellation, one-attempt
and closure behavior remains intact. Close the issuance in the same finally
path, including failures.

Preserve the existing native-identity assertions before sending a turn and
against the completed Prompt record. A configuration record does not establish
a native session identity. Do not add a parallel identity mapping.

## Prompt recording and permissions stay on the existing path

The conversation passes the completed Session and explicit agent to the
selected object's prompt method through the existing canonical `runPrompt`
implementation. Supply the provider object to that internal runner; do not
add a second consumer, Prompt-record builder or conversation-specific journal.
The ordinary component continues using ordinary `Agent.prompt` dispatch.

The existing permission audit wraps streams through Agent middleware. Direct
calls would miss that wrapper. Extract/reuse the internal stream-audit wrapping
so both paths receive one audit for the exact stream the canonical runner
consumes. Keep the `requestPermission` observer outside permission policies and
keep its arrival-order recording and scope-local ledger. No public audit API
or provider-supplied ledger is introduced. Audit once, not twice.

Preserve the publisher's `begin`, carried association, started/terminal events,
provider checkpoint delivery through the existing coordinator, actual
configuration read from the started Session, partial failure text, sequence
allocation, durability-failure precedence and joined stream cleanup. No
subscription means no turn. The provider must not resolve the chat's agent by
calling `Agent.agent` internally during session or prompt work: use its local
resolution with the explicit agent instead. Ordinary provider entry points
keep their existing contextual selection behavior.

`options()` uses the same saved provider object and selected agent. Its existing
disposable inspection session remains allowed on an explicit options request;
it sends no model prompt and saves no conversation configuration. Cold opening
and replay invoke none of the object's methods.

## Scope of the correction

Required changes are Core's Context/interface, conversation dispatch, private
setup completion evidence and shared prompt/audit integration; ACP's concrete
provider adapter and explicit-agent internal path; and affected conversation
fixtures, specifications and architecture text.

The CLI's `sidekickAssembly` already installs `createAcpxProvider` with explicit
constraints. It needs no new selection mechanism. Preserve its no native tools,
no MCP servers, deny-all/strict/noninteractive-deny permissions and null prompt
customization. Keep its dedicated agent and existing model/effort behavior.

Do not redesign ordinary `<Session>`, `<Prompt>`, Agent launch, provider
registration or Git-host APIs. Do not add an inspection exchange on each call,
a global restriction on ordinary sessions, a broader coordinator, settings UI,
live configuration updates, replay migration or new journal formats. Earlier
name-forwarding preservation proposals applied to the withdrawn middleware
design; retained conversations now bypass that routing. Ordinary name changes
and whole-session composition continue outside this direct path.

## Source locations verified at the base

Paths below are relative to the implementation worktree.

| File | Relevant current behavior and planned change |
| --- | --- |
| `packages/core/src/agent/conversation.ts` | `held` serves the mailbox; `conversationTurn` currently calls Agent agent/session and `runPrompt`; `inspect` calls Agent options. Read the object once in `held` and pass it to these jobs. |
| `packages/core/src/agent/session-request.ts` | Owns private issuance and one-use consumption. Keep completion evidence here rather than on Context or Session. |
| `packages/core/src/agent/session-setup.ts` | Owns activate/finish and configured-use creation. Record completion only after finish succeeds. |
| `packages/core/src/agent/function-components.ts` | `runPrompt` is the shared canonical consumer; change its internal provider selection without duplicating its record construction. |
| `packages/core/src/agent/journal.ts` | `observePermissionDecisions`, `audited` and `completedPromptAudit` supply the exact-stream audit. Reuse this implementation for the direct stream. |
| `packages/core/src/agent/components.ts` | Owns provider lifetime and installs the audit observer. Preserve its ordering and teardown precedence. |
| `packages/core/src/agent/provider-api.ts` | Existing factory/coordinator delivery and structural setup adapter remain intact. |
| `packages/core/api.ts` | Export the new consumer-facing Context and interface here. |
| `packages/acp/src/provider.ts` | Fixed production factory at `createAcpxProvider`; private state behind `AcpxPartition`; `resolveSession` and `promptStream` currently reenter Agent agent dispatch. Reuse these implementations with an explicit local agent path for the direct object. |
| `packages/cli/src/repl/sidekick/assembly.ts` | Already installs the constrained production provider; preserve its construction inputs. |

Update the provider-factory, saved-conversation and permission-audit sections
of `specs/acp-client-spec.md`, affected Agent expectations in
`specs/executable-mdx-spec.md`, and the corresponding conversation/audit text in
`architecture.md`. In particular, replace the explanation that a chat binds
its selected agent through Agent middleware. Preserve the ordinary middleware
contract where it still applies. Main-checkout approved rules 23–25 and Code
Rule 15 must accompany the implementation as needed; do not overwrite unrelated
main-checkout edits while bringing those exact instructions into the branch.

## Bounded evidence for the Planner

Keep the original probes and first logs unchanged as review evidence. Promote
the relevant real-ACP cases into the permanent test corpus instead of relying
on a reviewer probe as the only regression.

The Planner freezes the smallest focused matrix proving these consequences:

1. The existing missing-configuration control still gives its specific
   configuration refusal with zero native ensures and turns. Adding the
   supported name-forwarding middleware gives that same result. A refusal only
   because the new provider object is absent is not a passing regression.
2. With complete configuration, real ACP chat work succeeds with configuration
   acknowledged before native effects. Ordinary session-name and prompt-session
   rewriting handlers cannot change the session or agent of this chat. Include
   prompt substitution in the same bounded routing scenario where practical;
   verify the handlers were bypassed on the chat path. Existing ordinary Agent
   tests remain evidence that middleware still composes elsewhere.
3. A direct provider that returns a Session without completing the original
   setup reaches no prompt. A successfully completed request is accepted,
   including its configured use. Reuse existing setup lifecycle tests for
   activation refusal, cancellation and closure rather than a new permutation
   matrix.
4. The direct canonical prompt retains its decided permissions and provider
   checkpoint association. Reuse the existing audit and publisher fixtures;
   the assertion must exercise a saved conversation, since ordinary Prompt
   audit coverage alone cannot detect a missing direct-path wrapper.
5. Existing SC1–SC7, cold reopen, selected non-default agent, explicit options,
   Stop/joined cleanup and generated-root evaluation remain valid through the
   same chat object. Add one missing-provider readiness case; establish the
   single Context read and fixed concrete state by the implementation trace,
   without inventing a hostile Context replacement matrix.

Some old conversation fixture assertions describe unnamed Agent middleware
lookups rather than the lasting same-agent behavior. Update those fixture
mechanics and assertions to exercise the explicit selected agent on the direct
methods. Preserve the observable behavior they were intended to prove. The
historical Core probe embeds the old middleware-only stub; it remains forensic
evidence, not a requirement to keep a retired fixture working unmodified.

The original three focused commands remain the baseline selection:

```text
deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts

deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts

deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts
```

The shared audit and prompt-consumer changes also require the known consumer:

```text
deno task test packages/core/tests/agent-function-components.test.ts
```

That file contains the existing permission-audit and publisher regressions.
The Planner adds any further known checkpoint or integration consumer required
by the actual patch. Do not require a full
lint/check/JSR/runtime battery before a feedback commit. Public export checks
remain part of delivery under the repository's existing verification rules.
Preserve first failure output before rerunning a failing command.

## Delivery order and next action

Keep this correction on `agent/issue-883-pr2`, based on the exact SHA above.
The Planner assigns one coherent correction increment covering the direct
provider, Core integration, ACP implementation and their evidence together.
Do not land an intermediate commit that switches conversation calls before
its provider, permission audit and configuration check are present.

The replacement Planner assignment supersedes the old prohibition against
changing this routing boundary. It authorizes this Context-selected service,
while retaining the prohibitions on a public permission flag, broader
coordinator, per-call inspection protocol and a check only after native work.
Local helper names, factoring and representative test placement stay delegated.

After the focused evidence passes, the Implementor makes a signed feedback
commit and returns its exact SHA, parent, branch, tree status and every focused
command/result. Architect review checks this correction at that exact commit;
Planner review checks the frozen evidence. P2 remains closed throughout. No
mounted section 5, terminal packet, push, GitHub mutation or CI inspection is
included.

This handoff changes review records only. No production implementation, test
execution, implementation-worktree edit, commit or push was performed while
preparing it. There is no unresolved architecture choice for the Planner to
delegate to the Implementor within the scope defined here. The next action is
the [Planner correction prompt](pr2-direct-provider-planner-prompt.md).
