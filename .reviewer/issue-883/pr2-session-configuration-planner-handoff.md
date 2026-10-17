# Planner handoff: Sidekick session configuration

**Accepted, 2026-10-13:** both reviews pass at signed clean
`004de839e85e53cff4d960cb515729d350383f30`. Increment 4 is accepted, P1/P2 are
closed, and [the R2 reconciliation](pr2-r2-completion-reconciliation-004de839.md)
records all six interruption boundaries complete. The assignment is closed;
mounted integration and delivery keep their separate assignments.

**Planner evidence PASS, 2026-10-13:** the
[direct-provider correction review](pr2-direct-provider-planner-review-004de839.md)
accepts DP1–DP5 and preserved SC1–SC7 at signed clean 004de839, parent 08c95ca2.
P2 remains closed. The separate exact-commit Architect review is next before
overall increment 4/R2 closure is recorded. No additional implementation opens.

**Replacement P1 assignment ready, 2026-10-13:** the
[direct-provider plan](pr2-direct-provider-planner-handoff.md) and
[Implementor prompt](pr2-direct-provider-implementor-prompt.md) replace the
routing hold below. Start at clean signed 08c95ca2. Keep this plan's SC1–SC7;
the new assignment supplies the accepted dispatch, completion and audit
correction. P2 remains closed. P1, increment 4 and R2 await implementation
and review; no mounted section 5 or delivery action opens.

**Review status, 2026-10-13:** P2's independent Result correction is PASS at
`08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd` under
[its review](pr2-configuration-p2-planner-review-08c95ca2.md).
The configuration increment remains unaccepted for the supported-routing
activation bypass, referred in [the Architect return](pr2-configuration-request-routing-architect-return.md).
Hold at this signed clean head. The original assignment below does not
authorize a routing-boundary correction before the disposition and Planner
assignment, or declare R2 complete.

**Planner refresh complete, 2026-10-12:** this is increment 4, after separate
Planner acceptance of [the mechanical rename](pr2-session-rename-implementor-handoff.md),
[returned-tree validation](pr2-repl-validation-planner-handoff.md) and
[required host recording](pr2-session-recording-planner-handoff.md).
The [accepted vocabulary/API handoff](pr2-session-vocabulary-architect-handoff.md)
supplies the names below. The five configuration steps, SC1–SC7 behavior and
three focused selections remain frozen. All three prerequisites are now
accepted. Start this increment from
`a66c5d8a5391d43cf8328435bba622a79cc7076b` under
[the recording review](pr2-recording-planner-review-a66c5d8a.md), as its own
feedback increment.

Amend #883 PR 2 so an explicit message continues a saved Sidekick conversation
only under compatible provider configuration. The Product Owner accepts the
complete interface, lifetime and verification journey below. The architecture
decision is resolved; its implementation is pending. Do not declare R2 complete
or infer a PR PASS from this handoff.

**Planner assignment, 2026-10-12:** the implementation steps, acceptance rows and
three focused commands below are frozen. Implement this amendment from the
accepted prerequisite revision, then return one signed feedback commit for
review. This assignment opens no mounted section 5 work.

## Applies to

Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`

Branch: `agent/issue-883-pr2`

Historical reviewed clean head before prerequisites: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`

Parent: `1d373a61cbb6266e4dd90bf17c8076c278174b0f`

Implementation base: `a66c5d8a5391d43cf8328435bba622a79cc7076b`, parent
`8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7`, signed G, tarasm@gmail.com.
Verify a clean worktree before starting.

The governing amendment is
[the Architect decision](pr2-recovery-creation-policy-architect-decision.md),
accepted on 2026-10-12, including the final compatible/incompatible verification
approval. It answers
[the incoming handoff](pr2-creation-policy-architect-handoff-b01bbe6c.md).
Read the repository instructions, Architect rulebooks, architecture and affected
Core/ACP specifications. Preserve the accepted implementation stack.

## Current gap and required correction

`core/agent/conversation.ts` retains and compares conversation ID, agent and
canonical Prompt native identities. It does not save the provider's construction
configuration. `acp/session-store.ts` exposes a retained command and optional
native ID, not that configuration. The vendored ACPX runtime selected by
`acp/acpx-runtime.ts` can reuse a persistent session before applying newly
supplied creation options (`generated/runtime.js`, around lines 460 and 847).
Matching identities therefore does not establish configuration compatibility.

The existing-session path in `acp/provider.ts`, resolveSession(), calls constructRoute
and ensureFromPrepared before setup.finish(). A check added only to
finish is too late to prevent reattachment. The new-session path returns an
inert Session value and must stay inert.

Use the existing provider coordinator delivered to the installed factory and
its genuine Core-issued setup. Core owns the active provider configuration and comparison,
bound by private conversation issuance. The CLI selects the constrained
assembly; the provider validates and normalizes the actual inputs it supplies.
Do not copy the workflow database mapping into Sidekick: the comparison in
`workflow/deno/workspace/agent-sessions.ts` is not reached by Core conversations.

## Instructions

Implement the following accepted contracts in the order below. Local helper
structure and the private durable operation description are ordinary mechanics;
they must satisfy the stated ownership, replay and evidence requirements.

### Save explicit configuration values

```ts
/** Active provider configuration saved for session creation and continuation. */
export interface ProviderSessionConfiguration {
  /** The configured coding-agent tools. An empty array means none. */
  readonly providerTools: readonly string[];
  /** MCP server connection configurations. An empty array means none. */
  readonly mcpServers: readonly JsonObject[];
  /** The provider's permission configuration for this session. */
  readonly permissions: JsonObject;
  /** System-prompt replacement or addition; null keeps the provider's default. */
  readonly systemPrompt: string | { readonly append: string } | null;
}
```

All saved members are required. Initial Sidekick configuration is providerTools
`[]`, mcpServers `[]`, a provider-owned permission configuration covering deny-all,
strict routing and noninteractive denial, and systemPrompt `null`. Empty lists
are not omission. Null records no host customization, not knowledge of the
provider's default prompt; a string replaces and an append object adds.

providerTools means coding-agent tools such as file edits and shell, separately
from MCP tools and XMD REPL controls. Adding a tool or server does not approve
its permission requests. REPL entry permissions remain separate. Core stores
provider-validated MCP JSON without importing ACP types or interpreting
transports. PermissionMode alone does not represent strict routing.

Keep actual values, not only a fingerprint. This records host-supplied
construction inputs, not proof of successful native creation or adapter
application. The existing canonical native assertion establishes identity.

### Activate the setup before provider work

Add the accepted member to AgentSessionSetup in
`packages/core/src/agent/session-setup.ts`, through its existing
createSessionSetupOwner implementation:

```ts
/** One setup, handed to the provider that is resolving it. */
export interface AgentSessionSetup {
  /** The engine-derived identity, when an element opened this setup. */
  readonly sessionIdentity?: string;
  /** Authorize provider work; a retained conversation requires its configuration. */
  activate(
    provider: string,
    agentCommand: string,
    configuration?: ProviderSessionConfiguration,
  ): Operation<Result<void>>;
  /** Finish setup with the session the provider resolved. */
  finish(session: Session, state: AgentSessionSetupState): Operation<Session>;
}

export type AgentSessionSetupState =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly configure: ConfigureAgentSession };
```

The installed provider receives it through
`launchCoordinator.sessionSetup(request)`. Update the structural bridge in
`core/agent/provider-api.ts`, sessionSetupOf(), so a separately loaded provider
receives the operation with its proper receiver. An unsupported bridge must not
let provider work begin without the required activation.

Use the provider's existing discriminator (`acpx` for ACP) and resolved agent
command. Core privately distinguishes retained conversation setups from
ordinary setups; no public flag selects the requirement.

A retained Sidekick conversation requires the full configuration argument;
omission refuses before native work. Ordinary Session setups may omit it,
save no active provider configuration and preserve their current
behavior. Raw programmatic sessions without a setup keep their existing
path. Activation must succeed before completion.

```text
Existing session: activate -> reattach -> finish -> prompt
New session:      activate -> finish (new) -> first prompt creates
```

One activation attempt belongs to one issued setup. Refusal, cancellation
or closure permits neither completion nor retry on that setup. A later
explicit action can get a new setup for the same conversation. The
provider proceeds only on Ok; success asserts neither native creation nor a
configuration update. No handle survives its issuance for a later consumer.

### Keep capture, recovery and ownership coherent

Core commits the initial configuration in the conversation's canonical history
before native creation can begin. Later activation compares the saved
provider, command and configuration before reattachment. Use the existing
journal and persistence protections, not an unfiltered CLI sidecar. Native
association still follows the accepted backend-acceptance/canonical-assertion
order; recording configuration cannot create a native mapping prematurely.

The provider uses the same stable inputs for its declaration and construction.
Core parses, recursively detaches and freezes saved JSON objects and arrays;
mutable caller containers cannot change what was admitted. Retention and
enforcement belong to Core's conversation and installed-provider lifetimes,
not replaceable Context state, a module registry or Session metadata.

Reopening alone performs no activation, append or provider work. An interruption
after a native assertion but before Prompt acknowledgement must find the
already-saved configuration. Do not reconstruct it from current defaults or
infer from absent Prompt records that nothing was created. Preserve the
accepted native assertion reconciliation and refusal of replacement.

### Preserve the configuration lifecycle and scope

These settings are configuration, not permanent conversation identity. Future
supported changes apply and verify on the same native conversation, and Core
saves the result before further work relies on it. Unsupported or unestablished
changes refuse without replacement. This PR implements recording/comparison
for the constrained starting configuration, not a general live-update API or
settings controls.

The accepted optional future tool-change member is
`providerTools?: readonly string[]`: omit to preserve, `[]` to disable all,
supplied list to replace the complete set using provider-native names. MCP
changes have corresponding omit/empty/replace behavior. Their containing
update API is deferred. Partial updates do not replace a complete active provider configuration
with missing fields. Other construction options, including environment and
maxTurns, are not silently represented by this four-field configuration.

Model/effort keep their existing verified transaction. Do not silently extend
SessionConfiguration or canonical Prompt configuration records. Bootstrap,
guide chapters and compatible syntax refresh remain turn context, not
systemPrompt overrides. No new fixed instruction text is required.

No AgentConversationRequest member, authored identity, public accessor, broader
ProtectedSite surface, installation-function hash or CLI mapping algorithm is
approved. AgentSessionPolicy/checkPolicy, retainConfiguration and interim
acceptConfiguration are withdrawn names. There are no older Sidekick histories
to migrate.

## Example and accepted verification

```text
Reopen same REPL -> restore same chat; no agent work
                         |
                   Explicit message
                         |
                 Activate setup
                    /          \
           same config      one unsupported difference
                |                    |
       same conversation        refuse before reattach;
       gives next answer        preserve chat/association;
                                no replacement
```

Keep provider, resolved command, conversation ID and native identity fixed in
both arms. Change only one configuration value through trusted host/provider
assembly in the incompatible arm. Choose a change this PR cannot apply and
verify. No settings UI is needed to exercise that controlled difference.

An implementation checking only identity can pass an ordinary reopen and still
fail this journey. Reuse the existing actual assertion-before-acknowledgement
interruption scenario to observe that configuration was already committed in
that window. Do not substitute an agent/ID mismatch or add a crash/permutation
matrix. Derive the smallest focused commands and boundary evidence that prove
these contracts; the Planner owns their sufficiency. No new tests or CI were
run for the architecture amendment itself.

## Implementation order and affected boundaries

### 1. Carry activation on the genuine issuance

Add ProviderSessionConfiguration beside the setup contract, and expose the
type through the existing host export path that exposes AgentSessionSetup.
Keep Core independent of ACP transport types. Preserve the exact accepted
activate signature above.

Extend the private issuance in packages/core/src/agent/session-request.ts so
Core's conversation opener can bind the configuration operation to
that issuance. Ordinary issuances carry no retained-conversation requirement.
The public AgentSessionRequest still exposes only name and with(). A renamed
derivative keeps the same issuance and requirement; a structural copy cannot
carry either. Do not identify conversations by a name prefix or a public flag.

Implement activation in createSessionSetupOwner. It checks the issuance
and provider-installation lifetime, permits one attempt and prevents completion
before successful activation. Mark an attempt before suspending; cancellation
or refusal cannot reopen it. Owner closure or issuance closure prevents further
activation and completion, including through a handle obtained while live.
Register required cleanup before the work it owns. Preserve configured-use
ownership and the existing model/effort apply-and-verify sequence.

Forward activate through provider-api.ts's sessionSetupOf(), bound to the original
receiver like finish. A delivered setup lacking the new operation refuses;
there is no fallback that treats it as activated. Do not expose the private
configuration operation through a contextual reader or a public request member.

### 2. Save and compare in Core's conversation history

Bind the conversation's configuration operation when conversationTurn()
opens its issuance. It captures provider, resolved agent command and the full
four-field configuration through the existing protected journal path.
Parse and recursively detach/freeze the values before acknowledgement.
Missing required fields refuse rather than becoming defaults.

The initial active provider configuration must be acknowledged before activation returns Ok.
A failed or cancelled acknowledgement authorizes no provider work. Subsequent
activation compares the parsed saved values without changing the active provider configuration.
Compare JSON values rather than object identity or object member insertion
order; preserve the provider's normalized array order. Configuration differences
are unsupported updates in this increment and refuse, preserving the active provider configuration.

Configuration capture and replay must align with the existing durable conversation
sequence. On a later live opening, consume any saved configuration work
needed to replay the saved turn sequence without calling a provider or appending
a duplicate. The same rule must work when the configuration exists and the first
Prompt acknowledgement does not. An absent Prompt is never permission to
replace an existing active provider configuration. No older-history migration is assigned.

Use a private durable operation in the existing canonical stream. Do not add
a CLI record family, configuration sidecar, Session metadata, native identity
claim or AgentConversationRequest member. The existing conversation ID/agent
and native-identity checks remain independently required.

### 3. Declare the inputs ACP actually uses

Update packages/acp/src/provider.ts, resolveSession(), to activate after it has
resolved the actual command and normalized construction inputs, before
constructRoute(), ensureFromPrepared() or another path can reattach/create a
native session. Only Ok permits proceeding. Activate the new-session path before
completing its inert pending Session as well.

Build the active provider configuration from the same stable inputs used for construction:
SessionAgentOptions.allowedTools supplies providerTools, runtime mcpServers
supplies the validated MCP JSON, and sessionOptions.systemPrompt supplies the
replacement/addition or explicit null. The permission configuration includes the
actual permissionMode, strict/composable routing and nonInteractivePermissions.
Use existing provider option meanings; do not claim omitted runtime defaults
are known values. Core normalizes no ACP transport.

The initial Sidekick assembly explicitly supplies allowedTools: [],
mcpServers: [], deny-all with strict routing and noninteractive denial, and no
system-prompt customization. Do not change ordinary provider defaults to force
those values on entries, Plan or raw programmatic sessions.

Detach the provider's construction inputs once and use those same values in
the new session’s first consumer and the existing-session path. Keeping Core's copy stable
while rereading a mutable dependency during actual construction is insufficient.
Do not keep a setup handle alive until that later consumer; completion and
the pending Session preserve existing ownership.

### 4. Give Sidekick its constrained assembly

The current owner harness and recovery fixture pass installations: [] and
inherit the command's installed provider. That does not supply an explicit
empty tool/server list or strict routing. Replace that assumption with a
production CLI assembly using the existing SidekickAssembly and
ExecutionInstallation.install path. Install the selected ACP factory through
installAgentComponents' existing rootProvider lifetime. Reuse the command's
resolved provider dependencies, selected Sidekick agent and owned session
store; supply the explicit constraints above.

Keep this assembly separate from the entry installations and permission mode.
Use one shared production construction in the Sidekick harness and recovery
phases; do not build a pretend provider/configuration journal in a fixture.
Local helper location is delegated. This adds no new provider registry,
conversation method or user-visible configuration option.

Update the existing owner journey, configuration and lifecycle fixtures to
use that assembly. The subprocess fixture continues using its real directory
and canonical disk-backed ACPX store. Its scripted agent remains the only
transport stand-in. Existing native-identity and turn/message observations
must stay intact.

Do not acquire the owner in program.ts or mount controls here. The production
assembly is exercised by the existing real owner/repository path and will be
consumed by the later mounted integration assignment.

### 5. Align specifications and return feedback

Update the affected provider-factory/setup and retained-conversation
sections of specs/acp-client-spec.md, the touched Core module/interface roster
in specs/executable-mdx-spec.md, and architecture.md. Align specs/repl-spec.md
only where its existing active provider configuration or Sidekick assembly statements
are affected.

Carry the accepted ProviderSessionConfiguration and activate vocabulary.
Replace the superseded permanent-creation-policy description in the affected
feature prose with the accepted configuration contract. Keep model/effort
SessionConfiguration and Prompt records distinct. Describe implemented behavior
in the present tense; the deferred update API is not an implemented feature.

Do not edit the vendored runtime or its generated artifacts. This correction
prevents unsupported reuse before entering it and explicitly supplies the
initial construction inputs. If the supported provider path cannot represent
one accepted value, return that concrete boundary rather than inventing an
adapter guarantee or silently broadening the amendment.

## Frozen acceptance and evidence

Use these seven representative rows. Related observations may share a fixture
or test; they are not a required count of new test functions. No additional
configuration or crash permutation matrix is assigned.

| Row | Required observation | Destination |
| --- | --- | --- |
| SC1 — initial configuration | A real Sidekick message saves the provider, command and complete active provider configuration before native work. The actual ACP runtime/ensure inputs have empty tools and servers, deny-all/strict/noninteractive denial and no prompt customization. Core's copy is recursively detached/frozen. A bounded mutable-input test changes an original nested container after activation and shows both the saved value and actual construction remain the admitted values. | Core agent-session-setup/agent-conversation tests plus ACP host-conversation or CLI owner journey |
| SC2 — compatible/incompatible reopen | Seed one real completed chat, then use separate processes and the persistent ACPX store. Both cold reads restore the same chat with zero sessions/prompts/appends. The compatible explicit message answers on the same native conversation. The other arm changes only systemPrompt from null to a literal replacement through a trusted provider installation, keeping provider, command, conversation ID, native identity, tools, servers and permissions fixed. It refuses before reattachment/ensure or a prompt, preserves the earlier chat/configuration/association and starts no replacement. | CLI repl-sidekick-recovery.test.ts and its existing subprocess fixture |
| SC3 — missing activation/configuration | A retained conversation setup given no full configuration refuses before native work. finish before activate and completion after a refused activation cannot resolve a Session. An ordinary setup activates with omitted configuration, saves no active provider configuration and preserves the exact raw Session or existing configured use. | Core agent-session-setup.test.ts and agent-conversation.test.ts |
| SC4 — lifetime | Cancel activation while its acknowledgement is held: no native work or completion occurs, and that handle cannot retry. A later explicit action obtains a fresh setup. A handle retained past issuance or provider closure also refuses. Pair with one successful activation/completion, and preserve joined cleanup. | Core agent-session-setup.test.ts / agent-conversation.test.ts |
| SC5 — delivered bridge | Exercise the real provider-installation delivery adapter with a setup whose activate requires its original receiver. The operation reaches that receiver once with the exact arguments. A delivered setup lacking activate refuses. No imported private function or fabricated public conversation identity substitutes for the bridge. | Core root-provider.test.ts |
| SC6 — assertion window | Extend R2m2's existing real held first-turn acknowledgement: the provider accepted native-one and the on-disk store holds it; the canonical conversation history already holds the complete initial configuration. Cold reopening starts no work, and explicit continuation uses that active provider configuration and the same native identity. Preserve MC1–MC4, unknown first-message association and no-resend assertions. | CLI repl-sidekick-recovery.test.ts / recovery-phase.ts |
| SC7 — preserved consumers | Existing model/effort inspection, apply/readback, agent switch/reopen, Stop, Elicit, message association and ordinary provider/Session behavior remain green in the focused files below. Configuration capture does not become proof of native identity or widen the response ceiling. | Existing Core/ACP/CLI assertions in the frozen commands |

SC2's incompatible arm uses the existing trusted assembly installation path to
construct the provider with the differing systemPrompt input. It does not add
a CLI flag or a supported settings update. The ordinary Sidekick constructor
continues selecting null. Compare the saved association/configuration and existing
chat before and after refusal; this does not forbid retaining the person's new
explicit message under the existing message grammar.

Inspect ensure/reattachment and prompt observations, not merely the final Err.
Provider availability preparation may precede refusal; no native creation,
reattachment or new turn may. Keep the initial configuration/store and
native identity fixed in both SC2 arms.

One discriminating control is sufficient: bypass only the configuration
comparison. The incompatible arm must fail while the compatible arm stays green.
Verify the mutation actually applied before interpreting it, preserve the first
output, and restore before committing. No mutation is required for every row.

## Focused commands and fixture adaptations

Run these three commands from the implementation worktree after the final
source and specification edit:

```text
deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts

deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts

deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts
```

The selection covers the issuance/owner/bridge, ordinary and configured Session
uses, the actual ACP construction path, permission routing and the owner across
fresh processes. Explicit subprocess files are included because import-based
selection alone cannot establish their coverage.

Mechanical changes to test providers are authorized: a provider that completes
a genuine setup now activates it first, and retained-conversation stubs
supply an explicit complete configuration. They must keep their original
behavioral assertions. Report those adaptations in the handback.

R2m2's exact record list may gain the actual configuration event in its real
position. Preserve the exact list and all existing association, acceptance,
native identity, zero-work and no-resend observations; do not replace them with
an event count or a loose containment check. The production journal owns the
new event. Fixtures may read and assert it, but may not append fabricated configuration
to stand in for capture.

No session.ts, route, footer or mounted control change is planned, so the
no-wait journey/presentation selection is not added. If an implementation
actually changes a further supported boundary, report that concrete dependency
and include its known affected test. Do not use that condition to broaden the
product assignment or add confidence permutations.

Check, lint, validate:docs, check:jsr, complete suites and CI are not prerequisites
for this feedback commit. Delivery keeps its existing exhaustive gates. No
dependency, build or generated-artifact change is assigned.

## Feedback and continuity

Update affected architecture vocabulary, the Core/provider interface and
retained-conversation sections in specs/acp-client-spec.md, and the touched
executable-mdx-spec.md contracts alongside implementation. State implemented
behavior in the present tense. Carry the accepted exact signatures and
separation of construction configuration from verified model/effort records.

Return a stable feedback commit and every focused command after the amendment's
evidence passes. R2 completion remains subject to its implementation and the
remaining frozen evidence. Preserve root evaluation, message correlation,
admission/Pause, Stop, Elicit ownership, designated feedback and agent selection.

Commit promptly once the three focused commands and SC1–SC7 evidence pass.
Return exact signed SHA, parent, branch and tree status; the commands and their
actual results; the SC rows' destinations; any mechanical fixture changes;
and the verified comparison control result. Preserve first failure output
before fixing/rerunning a failed command. Stop for Planner review of that exact
commit. The Architect decision itself ran no tests and supplies no green result
to borrow.

Mounted section 5 owner acquisition, terminal R7/R8 and the 36-frame comparison
packet remain separate assignments. This architecture handoff authorizes no
production change by the Architect, push, GitHub mutation or CI inspection.

Historical base: b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2. Implementation base:
a66c5d8a5391d43cf8328435bba622a79cc7076b. Produced artifact:
.reviewer/issue-883/pr2-session-configuration-planner-handoff.md. Settled
decisions: the four-field ProviderSessionConfiguration, Core-owned configuration saving,
setup.activate, single-attempt lifetime and compatible/incompatible
verification. No architecture choice remains assigned to the Implementor.
Implementation and review are pending; R2 is incomplete until accepted.
Next Implementor action: implement steps 1–5 and the frozen SC1–SC7 evidence,
then hand back the signed feedback revision. No mounted section 5 work opens.
