# Accepted amendment: Sidekick session configuration

**Vocabulary correction, 2026-10-12:** the saved values are the **active provider
configuration**. The Product Owner withdraws the old session terminology.
The accepted [vocabulary and API handoff](pr2-session-vocabulary-architect-handoff.md)
now supplies the replacement names and two separate API corrections. Its
signatures supersede the older spellings below. Configuration behavior and
SC1–SC7 remain settled; Planner refreshes steps and evidence before implementation.

A reopened REPL continues its own Sidekick conversation only under compatible
saved provider configuration. Core saves that configuration before native
creation can begin and checks it before reattachment. An unsupported change
refuses while preserving the chat and its association; it creates no replacement.

**Disposition, 2026-10-12:** ownership, terminology, all four saved fields, the
assembled type, activation interface, lifetime and product verification are
accepted by the Product Owner. The final verification approval is the latest
`y` in this interview. The architecture question is resolved. Implementation
and its review remain pending; this is not a PASS for PR 2 or completion of R2.

Reviewed base: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, parent
`1d373a61cbb6266e4dd90bf17c8076c278174b0f`, branch `agent/issue-883-pr2`,
worktree `.claude/worktrees/issue-883-pr2`. The worktree is clean.
The incoming [Architect handoff](pr2-creation-policy-architect-handoff-b01bbe6c.md)
is answered by this record and the self-contained
[Planner handoff](pr2-session-configuration-planner-handoff.md).

## The observable behavior

```text
Reopen REPL -> same Sidekick chat; no agent work
                         |
                  Send a new message
                         |
                 Check configuration
                    /          \
                 matches     incompatible
                    |             |
                    v             v
              Continue same   Explain refusal;
              conversation    preserve chat;
                              no replacement
```

The values are configuration, not policy. Tools, MCP servers and permission
settings are not permanent conversation identity. A future supported change
applies and verifies on the same native conversation, and Core retains the
result before further work relies on it. An unsupported or unestablished change
refuses. This PR records and compares the initial constrained configuration;
it does not add a general live-update protocol or settings UI.

There are no older Sidekick conversations to migrate. The recovery requirement
concerns conversations created by this implementation, including an interruption
after a native assertion but before Prompt acknowledgement. Their configuration
must already be saved in that window, rather than reconstructed from today's
defaults. An empty Prompt history is not proof that native creation never began.

## Why the current boundary needs an amendment

At the reviewed base, the production path is:

```text
CLI owner: history, id, agent, installations
    |
Core conversation: compare id/agent and canonical native identities
    |
ACP provider: resolve command, prepare placement
    |
Vendored ACPX: reuse eligible persistent session
              without comparing the complete new construction configuration
```

Concrete evidence in the implementation worktree:

- `packages/cli/src/repl/sidekick/owner.ts`, open(), supplies the four accepted
  Core request members. None states an active provider configuration.
- `packages/core/src/agent/conversation.ts`, bindConversation(), retains
  `{id, agent}`; openable() checks canonical Prompt outcomes and their native
  identities. Neither compares these construction settings.
- `packages/core/src/agent/session-placement.ts`, AgentSessionPlacement and
  createSessionPlacementOwner(), currently expose identity and complete only.
  The existing configuration transaction verifies requested model/effort.
- `packages/acp/src/provider.ts`, resolveSession(), calls constructRoute and
  ensureFromPrepared before complete on the established path. Checking only
  inside complete is too late to prevent reattachment. The fresh path completes
  an inert pending Session without creating a native resource.
- `packages/acp/src/session-store.ts`, retainedSession(), exposes agentCommand
  and optional agentSessionId, not a complete construction configuration.
- `packages/acp/src/acpx-runtime.ts` selects the vendored runtime. Its
  generated/runtime.js reuse predicate around line 460 compares reset, cwd,
  agentCommand and an optional resume identity. ensureSession around line 847
  reuses an eligible saved session before applying new creation options.
  Retaining some sessionOptions does not compare the full configuration;
  assertPersistedKeyPolicy checks key spelling, not tool permissions.
- `packages/core/src/agent/provider-api.ts`, placementOf(), structurally adapts
  a delivered placement and currently forwards only identity and complete.
  The accepted operation must cross that adapter as well.

The workflow path is a precedent, not Sidekick's enforcement path.
`packages/cli/src/workflow-agent.ts` computes an explicit configuration
fingerprint, and `packages/workflow/src/deno/workspace/agent-sessions.ts`
compares it in the workflow run's database. Core conversation history does not
reach that comparison. Copying its database mapping algorithm into the CLI
would violate Sidekick's accepted Core ownership.

This is a direct trace of the supported ACP-first path, not a new experiment
or proof that every coding-agent adapter honors an empty tool list. No tests
or CI were run for this amendment. Earlier accepted corrections remain closed.

## Ownership and saved configuration

The CLI selects the constrained Sidekick assembly. The installed provider
validates and normalizes its actual construction inputs and declares those
same values through the placement Core delivered to it. Core binds the active
provider configuration to its genuine conversation issuance, makes a detached
immutable copy, saves it in that conversation's canonical history and compares
it on later work.

Store actual configuration values, not only a fingerprint. The configuration
saved before creation describes what construction will attempt. It does not assert native
creation, backend acceptance, successful adapter application or unobserved
provider defaults. Existing canonical native assertions establish native
identity separately; configuration capture cannot manufacture that assertion.

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

Every member is required. Missing information is not an empty set or a default.

| Member | Initial Sidekick value | Meaning and owner |
| --- | --- | --- |
| providerTools | `[]` | Coding-agent tools such as file reads, edits and shell; provider-native names, distinct from MCP tools and XMD controls |
| mcpServers | `[]` | Provider-validated connection configurations, saved as JSON; Core interprets no ACP transport and imports no ACP type |
| permissions | Provider-owned JSON configuration for deny-all, strict request routing and noninteractive denial | All three settings matter; Core PermissionMode alone is insufficient, and entry approval flags cannot override Sidekick denial |
| systemPrompt | `null` | No host customization; string replaces, append object adds, and null keeps the provider default without claiming to know its text |

Bootstrap, guides and refreshed syntax references are ordinary prompt context.
Model and effort keep their existing apply/readback transaction and Prompt
record grammar. Do not extend SessionConfiguration or those records silently.
No new fixed system instruction text is required.

For a future change request, omission preserves a setting; explicit empty tools
or servers remove all, and a supplied collection replaces the full set. The
accepted optional tool member is:

```ts
/** Coding-agent tools to enable. Omit to leave unchanged; [] disables all. */
readonly providerTools?: readonly string[];
```

Its containing update API is deferred. A partial request never replaces the
complete active provider configuration with omitted fields. Enabling tools or adding MCP servers
also does not grant permission to use them. Other construction options such as
environment or maxTurns are not silently admitted into this four-field configuration;
support requires a separate boundary decision. Ordinary authentication and
transient executable-binding inputs keep their existing paths.

## Accepted provider-to-Core operation

The operation belongs on Core's existing AgentSessionPlacement in
`packages/core/src/agent/session-placement.ts`, implemented by
createSessionPlacementOwner. The installed provider receives it through
`launchCoordinator.sessionPlacement(request)`. It is neither XMD syntax nor a
public conversation method.

```ts
/** One placement, handed to the provider that is resolving it. */
export interface AgentSessionPlacement {
  /** The engine-derived identity, when an element opened this placement. */
  readonly sessionIdentity?: string;
  /** Authorize provider work; a retained conversation requires its configuration. */
  activate(
    provider: string,
    agentCommand: string,
    configuration?: ProviderSessionConfiguration,
  ): Operation<Result<void>>;
  /** Settle this placement with the exact Session the provider resolved. */
  complete(session: Session, state: AgentSessionPlacementState): Operation<Session>;
}
```

Provider and resolved agent command are existing compatibility facts, not new
user settings. ACP uses its existing `acpx` discriminator and resolved command.
Core derives the conversation placement from its private issuance; the provider
supplies no authored conversation identity or public scope flag.

The full configuration argument is required for a retained Sidekick conversation
placement. Omission refuses before native work. It is optional for ordinary
Session placements, which can rely on unknown provider defaults: activation then
saves no active provider configuration and preserves existing behavior.
Raw programmatic sessions without a Core placement keep their existing path.

This adds no AgentConversationRequest member, Session metadata, public context
reader, module registry or broader coordinator accessor. The existing delivered
coordinator and its structural adapter carry activate. Core's configuration check
cannot be supplied or waived by a replaceable contextual value or CLI prose.

## Ordering, lifetime and recovery

```text
Existing native session:
  activate -> reattach -> complete -> prompt

New native session:
  activate -> complete (pending) -> first prompt starts creation

Placement lifetime:
  issued -> activating -> active -> completed
                |           |
          refusal/cancel   closure/cancel
                |           |
                v           v
              closed      closed
```

One activation attempt belongs to each issued placement. Core commits the
initial configuration before native creation can start; subsequent placements compare
provider, command and configuration before reattachment. The provider proceeds
only on Ok. Activation must succeed before complete. Refusal, cancellation or
closure allows neither retry nor completion on that placement. A later explicit
action can obtain a fresh placement for the same conversation.

Fresh activation opens no native resource and contacts no backend. Do not keep
its handle past the issuance for the first consuming prompt. The provider uses
one stable set of construction inputs for declaration and actual construction;
a detached Core snapshot does not authorize a second mutable read. Core parses
and recursively copies/seals JSON objects and arrays without retaining caller
containers. State belongs to the conversation and provider installation, and
closes under their existing cancellation and teardown ownership.

Configuration capture remains separate from native establishment. Keep the
existing canonical assertion-before-Prompt-acknowledgement reconciliation and
native association commit order. Never treat the saved configuration as a
native identity or a missing Prompt outcome as permission to create a substitute.
Retain through the conversation's existing journal and persistence protections;
do not create an unfiltered CLI configuration sidecar.

## Accepted product verification

Use a compatible/incompatible reopening pair. Keep provider, resolved command,
conversation ID and native identity fixed. Reopening restores the same chat
without provider work; the next explicit message triggers the check.

The control keeps the saved configuration and receives the next answer from
the same conversation. The other arm changes one configuration value through
trusted host/provider assembly, using a change this PR cannot apply and verify.
It receives a refusal before reattachment or a new turn, keeps its chat and
association, and starts no replacement. No settings UI is needed for this
controlled assembly difference.

This distinguishes an incomplete implementation that only compares identity.
Reuse the existing actual assertion-before-acknowledgement scenario to show
that configuration was already saved in that window. No new crash or
configuration-permutation matrix is assigned. The Planner derives the finite
focused evidence from this accepted journey.

## Scope and next action

The proposed AgentSessionPolicy/checkPolicy, retainConfiguration and interim
acceptConfiguration names are withdrawn. Permanently immutable settings,
fingerprint-only storage, extending partial model/effort configuration by
implication and hypothetical older-history migration are superseded.

The Planner incorporates this amendment and freezes its implementation steps
and focused commands before assignment. Update the feature's architecture and
Core/ACP specifications with the implementation, including the accepted type
and operation vocabulary. No production implementation is made in this review.

Preserve accepted recovery/message correlation, root evaluation, admission and
Pause ordering, Stop cleanup, Elicit ownership, feedback, model/effort and agent
selection. Mounted section 5 integration, owner acquisition, terminal R7/R8 and
the 36-frame packet remain separate Planner assignments. R2 is not complete
until this amendment's implementation and required evidence are accepted.
No GitHub write, push or CI inspection is authorized by this handoff.
