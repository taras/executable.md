# Accepted Core interfaces for the REPL Sidekick

**Product Owner spelling correction, 2026-10-15:** use `--sidekick-agent` and
`sidekickAgent` throughout active implementation and instructions. This supersedes
the earlier exact-spelling instruction. Selection, ownership and persistence
contracts are unchanged. See
[the current correction](pr2-terminal-completion-implementor-correction-d634b28b.md).

The accepted [root evaluation amendment](root-evaluation-architect-handoff.md)
replaces the earlier siteless generated-root export. executeInstalled returns
HostExecution with evaluateGeneratedXmdRoot; AgentConversation exposes that
method beside prompt/options. Request/result data, preview and released
fragment behavior stay unchanged. No generatedRoot callback is added. The
[implementation amendment](root-evaluation-planner-handoff.md) supplies the
ordered work and E1–E9 evidence. The inventories below include the accepted
interface change; the earlier reviews remain historical decision records.

The accepted Sidekick behavior needs canonical Core operations for a generated
response root, safe incomplete-source preview and a retained agent conversation.
This is a system-boundary interview: it introduces host-facing capabilities
across Core and CLI, with independent authority and lifetime. Product behavior,
verification and all interfaces below are accepted. The filename is retained
for continuity with the interview record.

The three capabilities below have settled operation, input, output and failure
contracts. Types and implementation modules are not added to production by
this record.

## 1. Generated response root

### Accepted operation

Current host export:

```ts
evaluateGeneratedXmd(request: GeneratedXmdRequest): Operation<string>
```

It evaluates a generated fragment and rejects Output. Its existing callers and
retained fragment records keep those semantics.

Accepted execution-bound interface from @executablemd/core/host:

```ts
interface HostExecution extends DocumentExecution {
  /** Evaluate a complete generated root using this execution's captured reference. */
  evaluateGeneratedXmdRoot(
    request: GeneratedXmdRequest,
  ): Operation<Result<GeneratedXmdRootResult>>;
}

function executeInstalled(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
  initialization?: ExecutionInitialization,
): Operation<HostExecution>;
```

AgentConversation exposes the identical method beside prompt/options. The
module-level siteless root export is replaced. Both bound methods use their
owning execution's captured documentation and exact minted Syntax routing.
Ordinary execute() keeps DocumentExecution and exposes no evaluator at runtime,
including through its prototype. No callback or new request field is added.

The trusted host supplies the same generated-request contract: stable admission
identity, exact complete source, pinned observation/mutation entries and selected
effect classes. Sidekick supplies no workspace basis and begins with empty
bindings. The bound operation uses Core's captured profile, complete-source admission
and canonical root Output selection. It records root context distinctly from
fragment context, so their retained admissions are not interchangeable.

The live owning execution runs response evaluation in a fresh durable sequence
separate from its main continuation and provider turns. Its task uses the
execution's installed services, not a caller's ambient context. The caller's
cancellation waits for that task and cleanup; overlap refuses without queuing,
and completed/closed handles refuse without reopening. Host output and iterable
main completion retain their existing meaning. The CLI's surrounding revocable
response scope supplies controls and joins their work before feedback or
another turn. Ordinary
generated-source/control failures return Effection Result failures; existing
integrity, policy and teardown failures retain their authoritative classification.
No generic generated-fragment or trusted-document execution behavior changes.

The Product Owner accepts these bound generated-root operations. The reused
GeneratedXmdRequest input keeps its established host contract; this introduces
no new request fields or document-facing evaluation component.

### Result member inventory

GeneratedXmdRootResult has two accepted members:

1. output: canonical rendered root text.
2. hasOutput: whether the root declares Output, for explicit chat selection.

The ordinary failure interface below preserves actual evaluated partial output.

### Accepted result member 1 of 2: output

```ts
/** The root's canonical rendered text after evaluation completes. */
readonly output: string;
```

Core produces this required string through ordinary root selection and
rendering. An empty string is a valid completed render. It is evaluated output,
not provider source or streamed preview, and includes only what canonical
rendering produced rather than a second CLI interpretation. The host receives
it under Result.value only when root evaluation succeeds. It carries no binding
snapshot, operation receipts or entry output
that the response did not itself render.

Root rendering retains its ordinary no-Output fallback behavior. Sidekick uses
the separately reviewed hasOutput fact to suppress that fallback in chat.
The string therefore does not decide whether the CLI presents a chat message.
Later lifetime joining and operation feedback remain the CLI owner's duties;
receiving output is not proof that an unrelated admitted entry has finished.

The Product Owner accepts the required output string and its canonical evaluated
meaning.

### Accepted result member 2 of 2: hasOutput

```ts
/** Whether this root declares an explicit Output region. */
readonly hasOutput: boolean;
```

Core derives this required boolean through its canonical root structure rules.
It concerns this root's Output selection, not any Output source stored inside a
passive fence or an entry draft. It is independent of rendered string length:
an explicit Output region that renders nothing still yields true.

The CLI uses output as selected chat text only when hasOutput is true.
When false, Sidekick suppresses the ordinary root fallback text while controls
and operation feedback retain their accepted behavior. The flag grants no
execution capability and creates no provider feedback. Core remains the owner
of syntax interpretation; the CLI does not search source for Output tags.

The Product Owner selects hasOutput as the name for this required flag. The
complete accepted success result is:

```ts
interface GeneratedXmdRootResult {
  /** The root's canonical rendered text after evaluation completes. */
  readonly output: string;
  /** Whether this root declares an explicit Output region. */
  readonly hasOutput: boolean;
}
```

### Accepted ordinary failure data: partial

```ts
class GeneratedXmdRootError extends Error {
  /** The root's evaluated rendering so far, when evaluation began. */
  readonly partial?: GeneratedXmdRootResult;
}
```

Ordinary generated-source or control failure returns Err(error). An admission
refusal has no partial rendering because evaluation never began. A runtime
failure carries the canonical rendering already produced and the same hasOutput
fact; it does not evaluate more source to produce a summary or complete Output.
An empty partial rendering remains a truthful observed result.

The CLI applies hasOutput before displaying partial.output and shows the actual
failure beside that text. Existing actual effects remain recorded; this field
does not authorize rollback, replay or a new provider turn before scope teardown.
The Error message uses the canonical safe diagnostic. Raw stacks, provider source
and unsanitized cause objects are not feedback or chat output. Infrastructure
integrity, policy and teardown failures keep their existing classification.

The Product Owner accepts this failure data after clarifying that the operation
returns Effection Result: Ok carries the complete rendering and Err carries the
Error with optional partial rendering. The partial field is plain rendering
data, not a nested Result. Retained failure data is schema-validated; reading it
never depends on a replaceable capability or creates execution authority.

## 2. Safe streaming preview

### Accepted preview operation

The closest existing operation is the pure scanner function scanSegments. It
reads complete source into canonical segments but does not supply a dedicated
streaming prefix result. A CLI regular-expression recognizer would create a
second interpretation of the same syntax.

Accepted host export:

```ts
/** Preview literal root Output from the source received so far. */
previewGeneratedXmdRoot(source: string): Result<GeneratedXmdRootPreview>
```

The input is the entire response prefix received so far, not just the latest
transport chunk. The function is a pure canonical parser/projection: it reads no
files or bindings, invokes no components, evaluates no expressions, grants no
admission and writes no history. It needs Result but no Effection Operation
because it performs no suspended work. Chunk boundaries inside tags, fences or
expressions do not change the projection for an identical accumulated prefix.

An unfinished construct is an explicit successful incomplete parse, rather than
an invalid program or repaired source. Invalid syntax returns a safe Error and
does not execute the valid-looking prefix. The result exposes only unambiguous
literal top-level Output text; computed output waits for real evaluation. The
CLI applies the existing disclosure policy before displaying Preview and never
uses preview completion as provider completion or execution authorization.

The accepted provider terminal status and separate generated-root admission
remain mandatory even if the currently received source is syntactically complete.
The CLI replaces preview in the same chat item on evaluation or marks it
Incomplete on a stopped/failed provider turn. Preview result members are reviewed
after this operation; they must carry literal text and explicit incomplete state.

The Product Owner accepts the pure preview operation and its direct Effection
Result return. Its source argument is the accumulated response prefix.

### Preview result member inventory

GeneratedXmdRootPreview has two accepted members:

1. output: safely recognized literal Output text.
2. incomplete: whether canonical parsing still needs more source.

### Accepted preview member 1 of 2: output

```ts
/** The literal root Output text safely recognized in this source prefix. */
readonly output: string;
```

Core derives this required string from canonical parsing, excluding source
outside root Output, the region's own delimiters and text whose meaning requires
expression or component evaluation. Tags inside passive examples do not create
Output regions. A prefix that
contains no safely recognized output returns an empty string. This is a complete
projection for the supplied prefix, not an append-only delta; the CLI replaces
the previous preview value rather than concatenating repeated text.

The string is provisional presentation, not the successful root rendering.
It remains labeled Preview even when the supplied prefix is syntactically
complete. The final generated-root result replaces it after successful provider
completion, admission and evaluation. Its lifetime belongs to the same chat item;
it is not an additional assistant reply or agent feedback.

The Product Owner accepts output as the preview text field and its replacement,
rather than append-delta, semantics.

### Accepted preview member 2 of 2: incomplete

```ts
/** Whether this source prefix ends in syntax that needs more input. */
readonly incomplete: boolean;
```

Core derives this required boolean from canonical parsing. An unfinished tag,
expression or fence is incomplete rather than a guessed repair or a parse
failure. A prefix such as <Output>Hello carries safely recognized Hello with
incomplete true; once its closing tag arrives, a syntactically complete prefix
can carry the same text with incomplete false. A later incomplete construct
elsewhere in the response can set the flag while preserving earlier safe text.

Invalid syntax returns Err and is distinct from a successful incomplete parse.
The flag describes the supplied source prefix only. False does not mean the
provider has finished, the response has passed admission or any control may run.
The CLI continues to label the text Preview until the separately accepted
provider-completion and generated-root evaluation boundaries have been met.

The Product Owner accepts incomplete. The complete preview result is:

```ts
interface GeneratedXmdRootPreview {
  /** The literal root Output text safely recognized in this source prefix. */
  readonly output: string;
  /** Whether this source prefix ends in syntax that needs more input. */
  readonly incomplete: boolean;
}
```

## 3. Retained provider association

### Accepted scoped conversation operation

Current canonical Session derives its placement from the execution's claimant;
public Agent.session names alone cannot recreate that authority. Canonical Prompt
also owns journaling, provider checkpoints and publication. Direct public
Agent.prompt calls are expressly not journal-owned turns. The existing host
prompt publisher can retain a canonical completion but cannot by itself create
or reopen a genuine retained Session.

Accepted host export:

```ts
/** Use one agent conversation and its history for the caller's owning scope. */
useAgentConversation(
  request: AgentConversationRequest,
): Operation<Result<AgentConversation>>
```

Core establishes genuine Session placement through its canonical engine-owned
identity machinery and supplies a scope-owned handle for canonical turns.
The CLI supplies the selected Sidekick conversation, retained history and
trusted provider assembly; request members are reviewed next. Core does not
trust an arbitrary native session ID or public name as retained identity.
Provider association uses its authenticated assertion and the accepted exact
reattachment/policy checks. The implementation reuses canonical Session/Prompt
machinery instead of exposing a private claimant or copying component bodies.

The calling Sidekick owner retains the handle until that scope ends. Teardown
revokes it and cancels/joins its provider work; a kept handle cannot reach a
closed provider or a different owner's conversation. Admitted REPL entries
belong to their independent owner. No session-opening operation runs during
cold projection. Opening a fresh placement does not by itself send a model
prompt or establish a durable native identity; the existing accepted-first-turn
assertion order still governs establishment.

The Product Owner accepts the operation and selects useAgentConversation as its
name. Conversation history names the persisted messages/turns; provider identity
is also saved so continuation reaches that exact conversation. Session history
is avoided here because it can also mean the REPL's entry history. Canonical
Session remains Core's underlying execution concept; it is not renamed.

The accepted request and handle members follow. This cross-package ownership
contract does not permit an unjournaled prompt loop.

### Accepted request inventory

The request has four accepted members:

1. history: the conversation's canonical durable stream.
2. id: the host-owned stable conversation address.
3. agent: the explicitly resolved agent selection.
4. installations: the trusted conversation execution assembly.

The handle's canonical turn and configuration members follow the request.
Model/effort preferences apply at the next turn boundary using the existing
SessionConfiguration contract; they do not add a native identity override or
an arbitrary options bag to this request.

### Accepted request member 1 of 4: history

```ts
/** The durable stream holding this conversation's canonical history. */
readonly history: DurableStream;
```

The trusted host supplies the required read/append stream for exactly this
conversation. Core uses it for canonical identity, turn and outcome records,
with the established append acknowledgement and single-writer contract. It is
the original history, not a transcript reconstituted as prompts for a fresh
provider session. An empty stream is valid only for a genuinely new conversation;
missing history for an established conversation is refused before calling Core.

The CLI repository owns physical storage and its binding to the REPL execution.
The paired sidekick.jsonl can retain multiple explicitly selected conversations
and host control facts. Its adapter presents only the selected conversation's
canonical stream to Core, preserving exact event order and append ownership;
unrelated conversation events and ordinary entry events are not replayed here.
This introduces no third file or materialized projection as another authority.

Passing history permits canonical reconstruction when explicit work opens the
conversation; it does not request another turn or replay old response controls.
Cold UI projection reads retained records without invoking this operation.

The Product Owner accepts history as the required canonical durable stream.

### Accepted request member 2 of 4: id

```ts
/** The stable host-owned identity this conversation history belongs to. */
readonly id: string;
```

The CLI mints a unique opaque ID when it establishes a new logical Sidekick
conversation and retains it with the REPL ownership record. Every reopening of
that conversation supplies the same ID. An explicit agent change establishes a
different conversation ID while preserving the earlier conversation's records.
Sending another message or changing model/effort does not mint another ID.

Core captures the required expected ID and binds its canonical conversation
history to it. An established history belonging to another ID refuses, so a
misrouted stream cannot silently reconnect the wrong conversation under the
selected chat. A genuinely new empty history is bound before provider-produced
source or controls can be exposed. Physical repository ownership remains the
CLI's responsibility, including the association with the REPL execution.

This ID addresses the host's logical conversation. It is not an authored Session
name, an ACPX placement key or a provider-native session ID. Core still derives
genuine Session placement and validates authenticated provider assertions; the
string grants no claimant and cannot override an established native identity.

The Product Owner accepts id as the stable host conversation identity checked
against the supplied history.

### Accepted request member 3 of 4: agent

```ts
/** The selected agent name for this conversation. */
readonly agent: string;
```

The CLI supplies a required explicit name, such as codex or claude, after
resolving Sidekick's own selection. Core resolves that name through the trusted
installed provider using the existing Agent.agent contract. The resolved command
and provider remain compatibility facts of the established conversation.

For first creation, CLI selection follows --sidekick-agent, DEFAULT_AGENT_NAME
and the package default. Entry --default-agent does not supply this member.
On reopen the CLI supplies the stored active conversation selection, rather
than replacing it with a fresh-session default. Changing the agent for an
established id/history refuses reattachment; an explicit agent switch creates
the accepted new conversation and retains the prior one.

The name is neither a role-file path nor a shell command supplied by generated
source. Model and effort are separate verified per-conversation configuration.
An unavailable selection produces its actual reason without fallback. Resolution
and initialization run only when explicit Sidekick work requires them, so
restoring the pane remains provider-free.

The Product Owner accepts the required agent selection and preservation of the
stored selection on reopening.

### Accepted request member 4 of 4: installations

```ts
/** The trusted installations for this conversation's execution. */
readonly installations: readonly ExecutionInstallation[];
```

The CLI supplies the immutable Sidekick conversation assembly through Core's
existing host installation type. Core captures its declarations, identities,
policy and bound operations before installation code runs, following the
existing executeInstalled boundary. The array is required: this operation does
not infer a conversation assembly from an entry's visible bindings or profile.

The assembly selects the provider and its constrained session configuration. For
Sidekick it explicitly supplies no native tools or MCP servers, does not inherit
entry permission flags as native tool grants, and keeps the provider's default
system prompt. The provider declares its actual construction inputs through
the genuine Core-issued placement's activate operation; Core owns their saved
account and comparison before reattachment. The accepted
[session configuration amendment](pr2-recovery-creation-policy-architect-decision.md)
and [Planner handoff](pr2-session-configuration-planner-handoff.md) define that
boundary without adding a conversation request member.
The generated-response capability ceiling is
separately pinned under the accepted root-evaluation boundary; installed entry
components do not become response capabilities.

Core owns canonical Session placement, Prompt journaling and provider coordinator
delivery within this execution. The installations do not substitute another
implementation for those canonical identities or expose their private claimants.
A conflicting or incomplete assembly refuses through the existing installation
rules. The CLI owns its provider's runtime-specific dependencies and filesystem
adapter; shared Core code performs no runtime detection or host-path discovery.

This reuses the existing host extension mechanism instead of a second provider
registry, a replaceable authority context or an untyped provider-options bag.
The installations are infrastructure supplied by the host, never generated
response props or user-editable chat configuration.

The Product Owner accepts installations. The complete request is:

```ts
interface AgentConversationRequest {
  readonly history: DurableStream;
  readonly id: string;
  readonly agent: string;
  readonly installations: readonly ExecutionInstallation[];
}
```

### Conversation handle member inventory

The three accepted members are prompt, which sends one canonical turn; options,
which inspects the provider's model/effort choices; and evaluateGeneratedXmdRoot,
which explicitly evaluates a complete response in the owning execution.
They share one admission guard through cancellation cleanup. Configuration uses the existing verified
SessionConfiguration contract at the next prompt boundary. Stop is scope
cancellation, not an additional handle method or native-session identity setter.

### Accepted handle member 1 of 3: prompt

```ts
/** Send one journaled turn and return its successfully completed reply. */
prompt(
  input: string,
  configuration?: SessionConfiguration,
): Operation<Result<string>>;
```

The input is the rendered person message, bootstrap/discovery context, requested
syntax reference or ordered operation feedback the host intends to send to this
conversation. Core runs a canonical
Prompt with the genuine owning Session. A successful result is the provider's
complete reply source, exactly as the canonical prompt record retains it. It
is not evaluated here; the CLI explicitly calls the conversation's bound root
method to admit it. A
failed/non-success turn returns the canonical AgentPromptError and its actual
partial text remains in prompt history and live observation, not a success value.

An optional configuration carries exact advertised model/effort IDs. Before the
turn starts, Core uses canonical apply/readback verification for this same native
conversation. Omitted settings keep their established meaning of no change.
Rejected settings start no turn and substitute no model, effort or conversation.
The CLI stores desired preferences and supplies them at this boundary rather
than applying them during an already running cycle.

Live text and status use canonical prompt observation/publication through the
trusted installations, as existing Agent work does. Core remains the sole
consumer that starts the provider stream. The CLI's Sidekick-owned observer
creates no synthetic entry key, opens no second subscription and derives its
immutable view from actual turn events. Completion is retained before this
method answers; earlier deltas grant no execution authority.

The handle admits at most one provider turn at a time and refuses overlap
without queuing. Its caller's cycle additionally waits for response controls and
their teardown before asking another turn. Cancelling the turn's owning scope
cancels/joins that work, while the conversation's retained identity survives.
It sends neither another prompt nor an old unfinished turn merely because the
handle was opened. Previous ambiguous accepted-turn status is reconciled through
canonical provider facts or refused, never blindly resent.

The Product Owner accepts prompt, its Result<string> completion, canonical live
observation and verified next-turn SessionConfiguration input.

### Accepted handle member 2 of 3: options

```ts
/** Inspect the selected agent's advertised model and effort choices. */
options(request?: AgentOptionsRequest): Operation<Result<AgentOptions>>;
```

This uses the established Agent.options contract, bound to this conversation's
selected agent. The existing optional request.model asks for effort choices for
that exact model; no agent override or agent-name enumeration is added. Core
returns canonical provider-ordered choices with exact IDs, labels, grouping and
null for unsupported settings. An inspection failure returns its actual Error
without substituting choices or changing the active conversation association.

Inspection sends no model prompt, applies no desired setting and cancels no
active turn. The existing provider implementation may initialize a separate empty
probe to obtain options; that probe does not establish or replace this logical
conversation's native association. The operation is called on explicit Configure
interaction, never merely to restore a pane during cold opening.

Advertised selected values describe the provider inspection, not proof that a
pending preference was applied to this exact native conversation. The UI keeps
desired preferences and canonical verified settings distinct, using the prompt
configuration/readback facts for the latter. Changing request.model refreshes
effort choices without applying that model. Verified application remains the
next prompt's configuration boundary.

The Product Owner accepts options and its reuse of the canonical AgentOptions
contract.

### Accepted handle member 3 of 3: evaluateGeneratedXmdRoot

```ts
/** Evaluate a complete generated root using this execution's captured reference. */
evaluateGeneratedXmdRoot(
  request: GeneratedXmdRequest,
): Operation<Result<GeneratedXmdRootResult>>;
```

This is the same generated-root contract as HostExecution, served through the
conversation mailbox using that execution's privately bound operation. It
sends no provider turn and changes no model setting. Each explicit evaluation
has a fresh owned sequence; reopening repeats no completed response and resumes
no interrupted response suffix. Prompt, options and evaluation refuse overlap
and keep the guard occupied until cancellation cleanup joins. AgentConversationHost
remains an ordinary declaration; the handle exposes no protected authority.

The complete accepted handle is:

```ts
interface AgentConversation {
  /** Send one journaled turn and return its successfully completed reply. */
  prompt(
    input: string,
    configuration?: SessionConfiguration,
  ): Operation<Result<string>>;
  /** Inspect the selected agent's advertised model and effort choices. */
  options(request?: AgentOptionsRequest): Operation<Result<AgentOptions>>;
  /** Evaluate a complete generated root using this execution's captured reference. */
  evaluateGeneratedXmdRoot(
    request: GeneratedXmdRequest,
  ): Operation<Result<GeneratedXmdRootResult>>;
}
```

The operation returns ordinary setup/availability/identity refusals through
Effection Err, with canonical Error diagnostics. There is no replacement-session
fallback. Existing fatal integrity, policy and teardown classifications remain
authoritative. A retained or closed handle grants no native identity override.

## Completed boundary

The conversation handle is provided by an Effection resource owned by the
caller's scope. Returning the handle does not extend its lifetime; an inner
scoped operation must not tear down its provider before the caller can use it.
Async cleanup is registered with ensure and observed through completion. These
follow the required [Effection agent contract](https://github.com/thefrontside/effection/blob/v4/AGENTS.md).

All three capabilities and their reviewed members are accepted: generated-root
evaluation with success/partial failure data, pure source-prefix preview, and a
scope-owned conversation with canonical prompt/options/evaluation methods. Their request
and result types cross only the trusted Core host boundary; existing constituent
types retain their established exports and semantics.

Core must isolate the durable sequence for each new prompt and each response
evaluation under the genuine conversation owner. Opening an interrupted history
does not resume an old prompt or unexecuted response suffix. Completed facts are
projected, unresolved accepted-turn identity is canonically reconciled or refused,
and a later explicit instruction authorizes a new turn. The CLI never fabricates
engine claimants, native identity, turn checkpoints or journal terminal records.

These are required canonical Core extensions. The Planner may choose their
conforming private modules and schema implementations; it may not substitute a
public unjournaled Agent.prompt loop or a trusted executor for generated source.

## Evidence and next handoff

The current declarations and behavior were inspected in packages/core/host.ts,
packages/core/src/generated-xmd.ts, expand.ts and the retained-session contract
in specs/acp-client-spec.md. The product journeys in remaining-architecture.md
are accepted. The completed planner-handoff.md incorporates this boundary;
the Planner now chooses conforming internal modules and finite implementation
evidence.
