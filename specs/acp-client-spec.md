# Executable.md ACP Client

**Status:** Implemented
**Protocol:** [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)
**Provider:** `acpx@0.12.0`

## Overview

Executable.md uses the Agent Client Protocol to run stateful coding-agent
sessions from Markdown. The public model has four parts:

- `<AgentProvider>` selects and configures an agent provider.
- `<Agent>` selects an agent and verifies that it is available.
- `<Session>` ensures a persistent session exists and scopes it to its body.
- `<Prompt>` sends text to the current agent session and renders the agent's
  text response.

The CLI installs ACPX as the root provider. Components and Context API
middleware can override that configuration for a nested scope.

`<Sample>` and `SampleApi` remain unchanged. Agent prompts are stateful and use
the separate `AgentApi`.

## Markdown interface

The smallest prompt uses the root provider, default agent, current working
directory, and default session:

```md
<Prompt>Describe this repository.</Prompt>
```

Agent and session scopes compose:

```md
<Agent name="codex">
  <Session name="review">
    <Prompt>Review the current changes.</Prompt>
    <Prompt>Summarize the highest-risk finding.</Prompt>
  </Session>
</Agent>
```

Direct prompt props override the ambient agent or session for that prompt:

```md
<Prompt agent="codex" session="review">
  Review the current changes.
</Prompt>
```

### AgentProvider

`<AgentProvider>` resolves a registered provider by name and installs it as an
Effection resource for its body:

```md
<AgentProvider name="acpx" defaultAgent="codex" timeout="2m">
  <Prompt>Describe this repository.</Prompt>
</AgentProvider>
```

Nested providers override root configuration without affecting siblings.
`defaultAgent` and `timeout` override inherited values for the component's
body; omitted values retain the outer configuration.
Provider teardown cancels active turns, closes owned processes and
connections, and retains persisted session state.

### Agent

`<Agent name="codex">` installs `codex` as the current agent for its body.
The self-closing form performs the same availability check without producing
output. When `name` is omitted, the component selects the inherited or default
agent.

```md
<Agent name="codex" />
```

Availability uses the selected provider's own resolution and probe behavior.
For ACPX, validation resolves the agent command, starts it, completes ACP
initialization, and closes the probe process. A successful probe does not
guarantee that a warm process remains available. The provider caches successful
validation for its scope so repeated references do not repeat the probe.

### Session

`<Session>` calls `session()`, which calls the provider's `ensureSession()`.
The wrapper form also makes the resulting session current for its body:

```md
<Session name="implementation">
  <Prompt>Implement the accepted plan.</Prompt>
</Session>
```

The self-closing form eagerly ensures the session exists and produces no
output:

```md
<Session name="implementation" />
```

An omitted name selects the default session. `name` identifies the session;
the engine-wide `as` prop continues to capture rendered output and has no
session semantics.

Session lookup is scoped by agent command, working directory, and optional
name. It follows ACPX's cwd behavior: inside a Git repository, lookup walks
from the current directory to the repository root; outside a repository, only
the exact current directory is considered. Different documents running in the
same scope therefore share the same default session.

The provider derives a stable, Executable.md-owned `sessionKey` from that
identity. Named sessions add the name to the identity. The exact key encoding
is an implementation detail, but it must avoid collisions with sessions owned
by other ACPX consumers.

Prompts submitted concurrently to one session run in submission order.
Different sessions may run concurrently.

### Prompt

`<Prompt>` renders its children and sends the resulting text to `prompt()`.
Rendered children take precedence over the `prompt` prop. Input is not
trimmed.

```md
<Prompt prompt="Describe this repository." />
```

The component accepts:

- `prompt`: fallback text for the self-closing form
- `agent`: agent override for this prompt
- `session`: named-session override for this prompt
- `timeout`: duration such as `500ms`, `30s`, or `2m`
- `throwOnError`: fail immediately instead of collecting the failure

The default output is the concatenation of ACPX `text_delta` events whose
stream is `output`. Thought, status, tool, usage, and raw protocol events do
not render. Output is buffered and becomes visible when the turn finishes.
Raw event streaming is not part of this interface.

## Context APIs

### ConfigApi

`ConfigApi` supplies a shared timeout in milliseconds:

```ts
interface ConfigApi {
  timeout: number;
}
```

The exported `timeout` value is an `Operation<number>`:

```ts
const timeoutMs = yield* timeout;
```

Its base value is `120_000`. It is always a positive, finite duration; it is
never `undefined`. Process, Fetch, and Agent operations use the contextual
value when the call does not provide an explicit timeout:

```text
explicit operation timeout → contextual timeout
```

Existing call sites that provide an operation-specific timeout retain that
behavior.

### AgentApi

The public agent value is a string. The session, event, and prompt types
are:

```ts
type Agent = string;

interface Session {
  sessionKey: string;
  cwd: string;
  agentSessionId?: string;
}

type AgentPromptEvent =
  | { type: "started"; agent: Agent; session: Session }
  | { type: "text_delta"; text: string }
  | {
      type: "terminal";
      status: "completed" | "failed" | "cancelled";
      stopReason?: string;
      error?: Error;
    };

interface PromptOptions {
  agent?: Agent;
  session?: string | Session;
  timeout?: number;
}

interface AgentApi {
  agent(name?: string): Operation<Agent>;
  session(name?: string): Operation<Session>;
  prompt(
    content: string,
    options?: PromptOptions,
  ): Operation<Stream<AgentPromptEvent, string>>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}
```

`prompt` returns `Operation<Stream<...>>` rather than a bare `Stream`: an
Effection Stream is itself an Operation, so a Stream-typed handler result
would be subscribed by Api dispatch and hand callers a Subscription.

`yield* Agent.operations.prompt(...)` performs Context Api dispatch and
returns a cold stream; it does not start the agent turn. Subscribing to
the returned stream resolves the agent and session and starts the turn.
Each subscription is an independent turn owned by the subscribing scope —
the Agent Api does not implicitly multicast, buffer, or replay prompt
events, and callers that need fan-out multicast one subscription
explicitly.

A subscribed turn emits exactly one `started` event — carrying the
authoritative agent and public `Session` — once the ACPX turn has
actually started, then zero or more `text_delta` events containing only
output text, then exactly one `terminal` event, and closes with the
complete concatenated text, including partial text on failure. The close
value equals the concatenation of the emitted text deltas. A prompt
waiting on its session's turn queue emits no events, and agent, session,
or turn-start failures fail the subscription before `started`.

The subscription resolves the agent override, then the session. A string
`session` option is a session name resolved against the selected agent
and contextual cwd. A `Session` value targets that already-resolved
session; a value the active provider does not own — or whose agent does
not match an explicit agent override — is rejected rather than silently
recreated.

`throwOnError` is not a `PromptOptions` member. It is a `<Prompt>`
component prop: direct Agent Api consumers inspect the terminal event and
choose their own failure policy. `<Prompt>` renders its buffered text
only after consumption finishes — Markdown output stays buffered even
though the Context Api itself is stream-based.

The existing runtime `cwd` operation supplies the working directory. Agent
APIs do not read the process cwd directly.

The ACPX handle remains private to the provider. The provider maps the public
`Session` to the full ACPX handle needed for turns and cleanup.

### AgentProviderApi

`AgentProviderApi` resolves provider factories by string name. Registration is
scope-local Context API middleware: nested registrations override an outer
registration without changing siblings or process-global state.

```ts
type PermissionMode = "approve-all" | "approve-reads" | "deny-all";

interface AgentProviderOptions {
  defaultAgent: string;
  permissionMode: PermissionMode;
}

type AgentProviderFactory = (options: AgentProviderOptions) => Operation<void>;

interface AgentProviderApi {
  resolve(name: string): Operation<AgentProviderFactory>;
}
```

`registerAgentProvider(name, factory)` installs resolution middleware in the
current scope. The CLI registers `acpx` before resolving the root provider.
An unknown root provider fails before document execution begins. An unknown
nested provider fails when its component expands.

Provider factories install their `AgentApi` implementation and own all
resources they start. The generic `<AgentProvider>` component resolves the
factory and applies it to its body.

## Permissions

Permission middleware uses a stable Executable.md shape rather than exposing
ACP SDK objects:

```ts
interface PermissionRequest {
  session: Session;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: readonly PermissionOption[];
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };
```

The base `requestPermission()` implementation denies the request. It selects
`reject_once`, then `reject_always`; when neither is available, it returns
`cancelled`.

The ACPX permission callback re-enters the active prompt's Effection scope,
calls `requestPermission()`, and translates the result back to ACP. The root
permission mode also configures ACPX's direct client filesystem and terminal
checks.

Eval blocks can install scoped `requestPermission` middleware for custom
policies. Two components provide common policies without JavaScript:

- `<ApproveAll>` selects `allow_once`, then `allow_always`.
- `<AskPermission>` asks for every request and denies when no interactive TTY
  is available.

The CLI's `approve-reads` policy automatically approves `read` and `search`
tool kinds. Other requests are interactive and are denied without a TTY.

## Prompt completion and failure

ACP defines five stop reasons. Only `end_turn` is successful. `max_tokens`,
`max_turn_requests`, `refusal`, and `cancelled` are failures.

By default, a failed prompt returns the output collected before failure, or
`""` when there is none. The failure is still recorded against the document
execution. This lets later content run without treating the document as
successful.

After output closes, an otherwise successful `DocumentExecution` completes as:

```ts
Err(
  new AggregateError(
    promptErrors,
    `${promptErrors.length} agent prompt(s) failed`,
  ),
);
```

Each entry is an `AgentPromptError` containing the agent, session key, stop
reason, and underlying cause. Errors remain in prompt execution order.
`xmd run` exits with failure status when the aggregate is present.

The `<Prompt throwOnError>` prop throws the individual `AgentPromptError`
immediately. Timeouts, provider errors, permission failures, and
non-success stop reasons follow the same rule.

## Journaling and replay

Each prompt is one durable operation. The journal Yield splits into a
description and a result: the description carries the durable identity
(`type: "agent_prompt"`, a `prompt:<path>:<line>:<column>#<ordinal>` name
whose per-location ordinal keeps `<Each>` iterations distinct, and the
prompt input); the result record carries an explicit `sequence` (prompt
execution order), the agent and session identity from the `started`
event, terminal status, stop reason, the text result including partial
text on failure, and the structured error when present. The live
`started` event is reduced into those fields and is not separately
journaled.

A failed prompt thrown through the `<Prompt throwOnError>` prop also
records `raised: true`. Replay decides from the stored marker, not the
live prop: a partial replay re-throws the recorded failure, and a full
replay omits raised failures from aggregate restoration because the
throw was already handled where it happened — for example by a failing
test. A record without the marker parses as not raised, and successful
records are never raised.

With a replay-populated stream, a completed prompt returns its recorded result
and restores its recorded failure without contacting the agent. During normal
CLI execution, `--journal` creates a new stream, so prompts execute live and
the journal serves as an observability trace.

Agent output is not emitted incrementally, which keeps the durable result
atomic and matches the current `<Sample>` output behavior.

## ACPX provider

The ACPX provider depends on exactly `acpx@0.12.0` and imports its public
`acpx/runtime` entrypoint. The version is pinned because ACPX marks its runtime
API as unstable.

The provider:

1. creates the ACPX runtime with `createAcpRuntime()`;
2. uses ACPX's agent registry and fixed `~/.acpx` state directory;
3. passes the contextual cwd and timeout to session and turn operations;
4. calls `ensureSession()` in persistent mode;
5. calls `startTurn()` and consumes its event stream and terminal result
   separately;
6. adapts ACPX promises with `until` and consumes its async event iterables
   through Effection operations;
7. cancels active turns and calls ACPX `close()` during teardown.

ACPX `close()` soft-closes its record while retaining persistent state. A
later `ensureSession()` with the same stable key reopens the record and
resumes the saved ACP session when supported. No keep-alive or state-directory
option is exposed.

Provider availability validation uses ACPX's registry, process launch,
initialization, and errors. Executable.md does not maintain a second list of
available agents.

## CLI

`xmd run` accepts:

```text
--agent-provider <name>
--default-agent <name>
--timeout <seconds>
--approve-all
--approve-reads
--deny-all
```

`--agent-provider` defaults to `acpx`.

Default-agent precedence, from lowest to highest, is:

```text
ACPX DEFAULT_AGENT_NAME
→ DEFAULT_AGENT_NAME environment variable
→ --default-agent
→ scoped AgentProvider override
→ explicit AgentApi, Agent, or Prompt override
```

The ACPX default is `codex`. ACPX global and project `defaultAgent`
configuration does not participate in this precedence.

`--timeout` accepts a positive decimal number of seconds, matching ACPX's CLI,
and converts it to milliseconds once. When omitted, the root `ConfigApi`
timeout is 120 seconds. Markdown duration props use the existing Executable.md
duration syntax.

The three permission flags are mutually exclusive. `--approve-reads` is the
default. Root CLI policy overrides the base deny implementation for the
document scope; nested permission middleware can override it for a subtree.

The provider and its processes live for the `xmd run` Effection scope. The CLI
does not expose `--keep-alive` or an ACPX state-directory flag.

## Test plan

Acceptance coverage is divided by the boundary under test:

- The existing CI smoke document uses deterministic `AgentProviderApi` and
  `AgentApi` Context API middleware instead of ACPX. It exercises the public
  Markdown flow through `<AgentProvider>`, `<Agent>`, `<Session>`, and
  `<Prompt>`, covering contextual defaults and overrides, named-session reuse,
  permission middleware scoping, and rendered text output. The existing live
  and replay smoke runner verifies that replay produces the same result
  without invoking the mock provider again.
- Context API tests cover provider registration and scoping, cwd and timeout
  propagation, permission modes, failure aggregation, and provider teardown
  with deterministic mocks.
- Durability tests cover prompt journaling and restoration of both successful
  results and recorded failures.
- CLI tests cover option precedence, mutually exclusive permission flags,
  unknown-provider failures, and failure exit status.
- ACPX adapter tests use a fake ACPX runtime to cover session, turn, event,
  permission, and close translation without starting a real agent.

Starting a real ACPX agent is an optional integration check and is not required
in CI.

## Not included

This interface does not include:

- raw ACP event streams
- non-text prompt attachments
- session mode or config-option controls
- explicit session closing or deletion
- additional ACPX runtime configuration
- replacement or removal of `SampleApi`
