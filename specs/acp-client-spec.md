# Executable.md ACP Client

The `Agent` Api, the `<Agent>` / `<Session>` / `<Prompt>` components, prompt
journaling and replay, the provider-factory seam, and the `Config` timeouts are
implemented in `@executablemd/core`. A provider is supplied through
the `rootProvider` factory seam described below.

## The Agent Api

`Agent` is an Effection Api (`@executablemd/core`) for stateful coding-agent
sessions, distinct from the stateless Sample Api. It has exactly five
operations:

```ts
interface AgentApi {
  agent(name?: string): Operation<Agent>;
  session(name?: string): Operation<Session>;
  prompt(content: string, options?: PromptOptions): Operation<Stream<AgentPromptEvent, string>>;
  launch(request: AgentLaunchRequest): Operation<void>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}
```

- `Agent` is a resolvable agent name (a string). `Session` is
  `{ sessionKey; cwd; agentSessionId? }`. `PromptOptions` is
  `{ agent?; session?: string | Session; timeout? }`.
- `AgentPromptEvent` is `started` → zero or more `text_delta` → one `terminal`
  (`{ status: "completed" | "failed" | "cancelled"; stopReason?; error? }`).
- `launch()` routes one frozen, one-use `AgentLaunchRequest` and answers
  nothing. `Agent.launch(instructions, options)` is the canonical operation that
  issues that request, retains the launch's phases, and derives its
  `SessionLaunchResult`; the route is where public middleware sees the ask, and
  authority to perform it reaches the installed provider directly rather than
  travelling on this chain (specs/native-agent-session-launch-spec.md). A launch
  performs no model turn, and a provider that answers `prompt()` does not
  thereby answer it: native session launch is its own capability, installed on
  its own.
- Built-in **`claude` is advertised**, as a client-allocated adapter: its
  sessions are named by XMD and created by the native process
  (specs/native-agent-session-launch-spec.md). So the ownership and
  construction-route requirements below apply to it on every host, and only the
  hosts that assemble both a coordinator and a route store — Deno and the
  compiled binary — can serve it. `codex` remains unadvertised.
- Every operation that can act on an **advertised** session — `session()`, a
  subscribed `prompt()` stream, a launch, and an incomplete launch replay —
  takes exclusive ownership of it first, through the session coordinator its
  host passed into the provider. Coverage follows the agent's capability, not
  the operation. Resolving an agent and placing a session own nothing.
  Acquisition never waits: contention refuses, and a host that installs no
  coordinator refuses every one of them before contacting an agent. Node and Bun
  install none, so default Claude session work refuses there before any provider
  effect — no availability probe, no runtime, no route read, no identity, no
  child. An agent that is not advertised keeps ordinary ACP behavior on every
  host, Codex included.
- The host also passes in a **construction-route store**, directly and from the
  same trusted root as the coordinator. It is required only for an advertised
  agent whose adapter names its own sessions: a provider that returns the
  identity constructs nothing a route governs, and keeps its behavior unchanged
  on a host that keeps no routes. A host missing it refuses that agent before
  any provider effect, on the same terms as a missing coordinator.
- While ownership is held and before any provider construction effect, the
  provider reconciles the route. A first `session()` or subscribed `prompt()`
  publishes or adopts `acp-first` before runtime creation, `ensureSession()` or
  a turn, and an ensure that fails afterwards leaves that route standing. A
  launch by an adapter that names its own sessions publishes `client-native`
  under an identity that adapter allocated, unless existing durable ACPX state
  or an existing route says the session was constructed through ACP — in which
  case it publishes or adopts `acp-first` and retains `identity-unavailable`.
  Publication is create-once, so the loser of either order adopts the winner,
  and no route converts.
- A `session()` or subscribed `prompt()` that meets a `client-native` route
  raises `AgentSessionRouteError` before runtime creation, ensure, turn, close
  or accepted history. It manufactures no launch failure, because no launch was
  asked for, and this release does not attach ACP to a session a native process
  created. Advertising `claude` does not change that: `<Session>` and
  `<Prompt>` still fail closed on a route it constructed, and continuing such a
  conversation is `<Session.Launch>`'s to do.
- `withSessionRoute` remains routing only: it selects which partition serves a
  call and carries no authority to construct, own or answer.
- **Base behavior:** with no provider installed, `agent()`, `session()`,
  `prompt()`, and `launch()` report a missing provider; `prompt()` reports it
  **coldly** — the
  returned stream is handed back without starting a turn, and the failure
  surfaces only when it is subscribed. `requestPermission` has a working base
  that **denies**: it selects `reject_once`, then `reject_always`, and otherwise
  returns `{ outcome: "cancelled" }`.

### The provider-factory seam

A provider is a factory that installs `Agent` middleware for its scope:

```ts
type AgentProviderFactory = (options: AgentProviderOptions) => Operation<void>;
interface AgentProviderOptions { defaultAgent: string; permissionMode: PermissionMode; }
```

`installAgentComponents({ rootProvider: { factory, options } })` owns the root
provider's lifetime through `Execution.document`: the handler delegates the
request it was given and returns nothing, and the factory runs inside a scoped
provider lifetime that surrounds the document's expansion and ends while the
journal is still live, so the completion resolves **only after the provider's
finalizers have run**. Rendered output closes independently of
teardown, and every finalizer runs even if one throws.

Teardown and prompt failures are *additive completion policies*, and completion
precedence is first-failure:

- a document that already failed keeps its own failure — provider teardown
  neither replaces it nor aggregates onto it, and the policy is not consulted;
- an otherwise-successful document becomes an `Err` when its prompts failed,
  when teardown failed, or both — prompt failures first, then teardown, flat
  rather than nested; and
- once a policy has failed the completion, no later policy replaces it.

Cleanup still runs in every case. "The document failed" and "cleanup also
failed" are both true; what the caller receives is the document's own failure,
because that is the one it earned.

### The provider registry

`AgentProviders` resolves a factory by name. `registerAgentProvider(name,
factory)` installs a resolver for that one name in the current scope and
delegates every other name outward, so a nested registration overrides an outer
one for its own name without affecting siblings or process-global state.
Resolving an unregistered name throws `Unknown agent provider "<name>"`.

Registering a provider only makes a factory **resolvable**; it does not install
that provider into the `Agent` Api. Operations still report a missing provider
until one is installed as a root provider or by `<AgentProvider>`.

### Seeded configuration

`installAgentComponents({ defaultAgent, permissionMode })` seeds the values that
`<AgentProvider>` inherits. The configuration surfaces are those options, the
`defaultAgent` and `timeout` props on `<AgentProvider>`, and the permission
components below; the contextual state holding them is private to the
components.

## Components

`installAgentComponents()` registers six components for the installing scope
(§5.3): `<AgentProvider>`, `<Agent>`, `<Session.Launch>`, `<Prompt>`,
`<ApproveAll>` and `<AskPermission>`. `<Session>` is the seventh agent word and
is supplied separately, because its implementation names durable work after its
own invocation: a host declares it to the execution through the identity-bearing
installation described in executable-mdx-spec §5.6, and the execution builds it
from the claimant it minted. `agentIdentityComponents()` is what a host declares;
a host that declares none has no `<Session>` at all.

All seven are ordinary function components and non-reserved **defaults**: a
repository component with one of these names is chosen ahead of them, and the
engine owns their expression props, schema validation, `as` capture, content
projection and invocation lifetime exactly as it does for any other `.ts`
component. Props take string and boolean values, from a literal or from an
expression that resolves to one.

What is not ordinary is which of their failures end the document. An unknown
provider, a missing default agent, an unusable duration, an unavailable agent, a
session that cannot be established, and a `<Prompt>` replaying a recorded
`raised` marker all stop the execution rather than rendering a diagnostic and
letting later siblings run as though the agent had answered. `<AgentProvider>`
extends that to the resources its factory installs, whose cleanup the invocation
boundary runs after the component has returned.

- **`<AgentProvider>`** resolves a registered provider by its `name` prop and
  installs it for its body. The optional `defaultAgent` prop overrides the
  inherited default agent for that body, and the optional `timeout` prop
  declares how long each prompt in that body may take. A prompt nobody bounded
  has no timeout: the run deadline bounds the run, not each prompt inside it.
  The permission mode is **inherited and has no prop** — it always reaches the
  factory unchanged.

  ```md
  <AgentProvider name="acpx" defaultAgent="codex" timeout="30s">
    <Prompt text="Review this change" />
  </AgentProvider>
  ```

  An unknown provider name, or no default agent configured, **fails the
  execution before the body expands**: neither the body nor any later content
  renders.
- **`<Agent name>`** resolves an agent and, for its body, pins it onto nested
  prompts. Self-closing validates only (no output).
- **`<Session name>`** resolves a session and pins it onto nested prompts and
  launches. Self-closing validates only. It is the one agent word a host does
  not register with the others: its implementation names durable work after its
  own invocation, so the host **declares** it to the execution and the execution
  builds it from the claimant it minted (executable-mdx-spec §5.6). A document
  run by a host that declares none has no `<Session>` at all, which is why
  `installAgentComponents()` alone leaves the name unresolved.
- **`<Session.Launch>`** prepares one durable session from its rendered body and
  hands the provider's native UI the terminal for it, rendering nothing itself
  and returning only after that UI exits
  (specs/native-agent-session-launch-spec.md). Its props are exactly `agent` and
  `session`, which mirror `<Prompt>`; no executable name, native session id,
  argv or instruction-channel selection appears on the document surface. The
  dotted name addresses a subdirectory, so a repository override for it is
  `components/Session/Launch.md`.
- **`<Prompt>`** sends one prompt and renders the reply.
  - Content is the rendered children; a self-closing `<Prompt text="…" />` uses
    the `text` prop instead.
  - `agent`, `session`, and `timeout` props override the enclosing scope for
    that prompt; `timeout` accepts a duration string.
  - `as="name"` captures the reply into the eval environment instead of
    emitting it.
  - `throwOnError` aborts the document on failure; without it, a failed prompt
    renders its partial text, the document continues, and the failure is
    aggregated into the execution completion as an `AggregateError` of
    `AgentPromptError`s ("N agent prompt(s) failed"), ordered by execution
    sequence.
- **`<ApproveAll>`** answers each request in its body by selecting an allow
  option, and denies when none is offered.
- **`<AskPermission>`** asks for every request in its body, and denies without an
  interactive TTY or a valid choice.

  Both apply to their body only; the enclosing policy applies again after the
  closing tag. They change which policy answers requests — not the provider's
  `permissionMode`, which a provider factory still receives as inherited.

## Journaling and replay

Each prompt is one durable operation (`agent_prompt`). The record carries the
prompt's identity and input, the agent and session identity, terminal status,
stop reason, text (including partial text on failure), and any structured
failure. A `sequence` records execution order explicitly, and per-location
ordinals keep durable identities stable across `<Each>` loops.

On a **full replay** (the journal already holds the root `Close`), completed
records are restored from the journal without contacting any provider —
producing identical output and identical aggregated failures. A prompt failure
that was thrown through `throwOnError` is marked `raised`; a partial replay
re-throws it, while a full replay omits it from aggregate restoration because it
was already handled where it occurred.

A native session launch is not a prompt and does not reuse `agent_prompt`. It
retains its own `agent_session_launch` records, one per completed phase, so an
interrupted launch resumes the provider session it already prepared rather than
creating a replacement; the shape is specified in
specs/native-agent-session-launch-spec.md.

## Config

`Config` (`@executablemd/runtime`, re-exported from `@executablemd/core`) is the
shared execution config. It carries three optional timeouts in milliseconds, and
**there is no timeout by default**: each is `undefined` until something
configures it, and `undefined` means the operation is not bounded.

| Field | Bounds | Consumed by |
| --- | --- | --- |
| `timeout` | the entire run, preparation and execution together | the outer run boundary |
| `timeoutExec` | each exec block | exec blocks and the built-in `timeout` modifier |
| `timeoutFetch` | each Fetch | Fetch |

Override a field for a scope with
`yield* Config.around({ timeoutExec: () => 30_000 }, { at: "min" })`. Installing
at `min` is what lets a nested override win. Omitting a field inherits the
enclosing value; it does not clear it. The validated `timeout`, `timeoutExec`
and `timeoutFetch` operations each return a positive, finite number of
milliseconds or `undefined`, and throw on any other value (zero, negative, NaN,
Infinity, or a non-number) before the operation they would bound starts.

Ownership is strict, and nothing falls back to a field it does not own. A
per-call `timeout` always wins where one is supported; otherwise Fetch resolves
`timeoutFetch`, and an exec block resolves `timeoutExec` at the block and hands
it to the Process operation explicitly. The Process operation itself consults no
configuration: what bounds a command is what its caller asked for. Agent prompts
and service startup are bounded by what a document or caller declared for them,
never by the run deadline.

The run deadline encloses everything above, so a longer exec or Fetch timeout
cannot outlive it. Its expiry is Effection cancellation rather than a result, so
structured teardown still completes before the process exits.

## Permissions

`PermissionMode` selects the policy that answers `Agent.requestPermission`. It is
`approve-all`, `approve-reads`, or `deny-all`:

- **approve-all** selects `allow_once`, then `allow_always`.
- **approve-reads** approves the `read` and `search` tool kinds and asks for
  everything else. Asking prompts only on an interactive TTY.
- **deny-all** uses the base deny behavior, so it installs no policy of its own.

A policy **decides every request inside its scope**. When it cannot approve — no
allow option is offered, there is no TTY, or no valid option is selected — it
denies with the base semantics rather than deferring outward, so a policy nested
inside a more permissive one can never be overruled by it.

Every permission request therefore receives a concrete decision.

### The workflow Agent profile

`xmd workflow` installs a stricter profile than `xmd run`, and installs it only
while a live or partial run is attached. A completed replay restores its Prompt
records without contacting a provider at all, so it starts nothing.

Under that profile an Agent receives no Workspace, checkout, materialized root,
caller path or ACP `additionalDirectories`. Its process runs in a directory the
host owns: created empty before the session is established, never written to by
this host, never read back, and removed when the attachment ends. The runtime is
created with `mcpServers: []`, each session with `allowedTools: []`, and the
permission mode is `deny-all` with non-interactive denial.

A fixed session instruction layer states that boundary to the Agent in the same
terms, and states all of it: that no native tool is authorized; that retained
work can be asked for only when the prompt being answered asks for it and only
in the exact closed shape that prompt supplies; and that nothing the Agent
returns carries authority — source it writes is data this run may admit under
ceilings decided before the prompt was sent. Those instructions are part of the
policy fingerprint below, so changing them refuses a session created under the
previous wording rather than continuing it under new terms the session never
received.

`allowedTools` and `mcpServers` are stated as empty arrays rather than omitted:
omission is ACPX's own default, and this host is making a different statement.

A native permission request under this profile does not reach
`Agent.requestPermission`. The provider answers it: a reject option when ACP
offered one, otherwise cancellation — and the turn the request belonged to fails
with a fixed diagnostic, whatever the adapter reports afterwards. An authored
`<ApproveAll>`, or any other public permission handler, composes around nothing
here, because there is no native tool authority to widen. The diagnostic names
nothing the request carried: no tool title, raw input, path or command.

This is what the host asks for and what it refuses. It is not a proof that every
ACP adapter exposes no tool when asked for none; that portable proof is tracked
separately and does not widen this ceiling.

Nothing else changes. `<Prompt>` is still exactly one turn, the Agent Api gains
no operation, and `xmd run` keeps its caller-selected cwd, its omitted MCP and
session options, and its public permission routing.

#### Retained sessions

A provider session outlives one execution, so a continued run reattaches the
conversation it was having rather than replaying its transcript into a new one.

**Identity is the engine's.** Within one workflow run a session is identified by
the Agent/Session expansion identity the engine derived, and by nothing else. The
authored `<Session name>` is descriptive: two sibling `<Session name="review">`
elements are two sessions, and a document that reuses a name cannot make them
one. The name travels the public `Agent.session()` chain, where a handler may
observe or change it; the identity travels inside an opaque placement the
`<Session>` element routes and is readable only through the authority delivered
to the installed provider. Middleware holding the placement reads the name and
reaches no further.

Where the element gets that identity is the other half. `<Session>` does not
read it from anywhere: the execution mints it for that invocation and answers
for it only through the claimant it delivered to this `<Session>` factory. So an
implementation kept from one execution's `<Session>` names nothing at another's,
one kept from a different component names nothing here, and an issuance
belonging to another element — finished, still projecting, or live in a frame of
its own — names nothing either. Two attachments running side by side hold two
claimants, and neither answers for the other.

The provider and the resolved agent command are stored beside that identity as
compatibility attributes. Changing either refuses reattachment rather than
addressing a second mapping. The key ACPX places a session under is a different
thing and namespaces both, because ACPX's store is shared; that key is
arrangement, not this run's session identity.

**A canonical assertion comes before the mapping.** The order is: provider
creation, then the provider's canonical, tagged assertion of a durable identity,
then the mapping commit, then the first Prompt. Holding a key in ACPX's store is
not an assertion — it says something is there, not what conversation it is — so a
mapping is committed only from one canonical assertion, and an interruption
before that commit is reconciled only the same way.

Continuation is decided before a turn starts:

- no mapping and no assertion means nothing was ever established here, and a
  session may be created;
- no mapping and exactly one canonical assertion is the pre-commit window, and
  reconciles to that identity;
- a mapping whose identity, compatibility attributes and policy fingerprint
  agree, and whose assertion the provider still makes with the same kind and
  value, reattaches;
- a missing assertion, an assertion of a different kind or value, a changed
  provider, agent or policy, and more than one assertion are each one explicit
  refusal.

No refusal starts a replacement session. ACPX fixes a session's creation-time
options when the ACP session is created and ignores them when it reuses a
persistent record, so continuing without comparing the retained policy would be
continuing a session created under a wider one.

The mapping is a row in the run's own database, committed in the run's own
transaction: a mapping that could commit while the run did not would describe a
session the run never had. What stays beside the run on disk is the provider's
own session store and one empty working directory per session, both disposable.

## Command-line configuration

`xmd run` configures the agent stack; the options are exclusive to it, and
`xmd test` rejects them, driving agents through the deterministic test-agent
stack instead.

| Option | Meaning |
| --- | --- |
| `--agent-provider <name>` | the registered provider to install (default `acpx`) |
| `--default-agent <name>` | the default agent |
| `--approve-all` | approve every permission request |
| `--approve-reads` | approve reads and searches, ask for the rest (default) |
| `--deny-all` | deny every permission request |

The permission options are mutually exclusive.

`xmd run` also takes the three timeout options, which are exclusive to it in the
same way:

| Option | Establishes |
| --- | --- |
| `--timeout <duration>` | the deadline for the whole run |
| `--timeout-exec <duration>` | the default timeout for each exec block |
| `--timeout-fetch <duration>` | the default timeout for each Fetch |

An option nobody writes leaves its field absent, which is no timeout. Each value
is a **duration**: a whole number with an optional unit — `500ms`, `30s`,
`5min`, `20min` — where bare digits are milliseconds. The value is greater than
zero. Empty, zero, negative, signed, hexadecimal, scientific-notation,
`Infinity`, `NaN`, fractional and trailing-text forms are rejected, and the
whole argument has to match: `30 seconds` is not a duration. The raw argument
text is what gets validated, because an argument parser may coerce or drop these
forms before they reach the check. A rejected value fails the invocation before
it prepares a document.

Invalid options and an unknown `--agent-provider` fail before the document
executes, with a non-zero exit status.

The default agent resolves in order, each entry overriding the ones above it:

1. the ACPX default agent,
2. the `DEFAULT_AGENT_NAME` environment variable,
3. `--default-agent`,
4. an enclosing `<AgentProvider defaultAgent>`,
5. an explicit `<Agent name>` or `<Prompt agent>`.

The installed provider belongs to the run's `DocumentExecution` scope and closes
during its teardown.

### Availability

Installing a provider starts nothing. The **first** Agent API use validates the
selected agent, and both `<Agent>` and `<Prompt>` resolve the agent through the
Agent API before any turn begins or is journaled. A document that never uses an
agent therefore never probes one, and a confirmed full replay restores its
prompts without re-checking availability.

A failed availability check aborts expansion where it occurs: the content after
the failed operation does not render, no prompt failure is aggregated, and the
run exits non-zero. A turn that fails for any other reason remains an ordinary
prompt failure.

## ACPX provider

`@executablemd/acp` implements the `rootProvider` seam over the `acpx` runtime.
`createAcpxProvider()` returns an `AgentProviderFactory` supplied directly to
`installAgentComponents({ rootProvider: { factory: createAcpxProvider(), options } })`;
`useAcpxProvider` exposes the same operations without the Agent install, so
several independent providers can run in sibling scopes. The provider owns
every resource it starts and creates the shared runtime lazily on first use with
the contextual cwd — nothing spawns at install, and no timeout is invented for a
prompt nobody bounded. A prompt carries the duration its caller supplied, from
`<Prompt timeout>` or the enclosing `<AgentProvider timeout>`, and otherwise
none.

- **Availability.** The first use of an agent validates it through a disposable
  probe runtime's `doctor()`; a non-ok report throws with the agent's code and
  details. Results are cached per agent.
- **Sessions.** `session()` resolves a session by (agent, logical session,
  contextual cwd): placement walks from the cwd up to the Git root and reuses the
  nearest existing record for the same agent command and cwd, otherwise creates
  one at the exact cwd. The resolved `sessionKey` — not the caller cwd — keys the
  session queue. A `Session` value must come from this provider's `session()`; an
  unknown or agent-mismatched session is rejected.
- **Prompts.** `prompt()` returns a cold stream; each subscription is one turn
  owned by the subscriber. Events are normalized to one `started`, `text_delta`
  for output-stream deltas only (thought/status/tool/usage stay private), and one
  `terminal`, then the stream closes with the full concatenated text (including
  partial text on failure). A completed turn with an absent stop reason is treated
  as `end_turn`; any other stop reason is a failure.
- **Serialization.** Prompts for one session run FIFO on that session's queue;
  different sessions run concurrently. `withSessionRoute` — the hook an embedder
  supplies through `AcpxProviderDependencies` — wraps registry-dependent work
  (preparation, ensure/start) and is not held across turn consumption. The
  queues that serialize this are internal to the package.
- **Permissions.** ACPX permission requests are routed — keyed by the record's
  live ACP session id, refreshed on demand — to the in-flight prompt's scope and
  answered through `Agent.requestPermission`; an ambiguous or unknown request
  fails closed. The permission callback always returns a concrete outcome and
  therefore never delegates to ACPX's fallback resolver. ACPX's own
  Promise-returning leaves are consumed with `until`; the provider's only
  Promise-producing adapter is the `onPermissionRequest` callback, and the bridge
  itself is operation-based.
- **Host-owned dependencies.** `AcpxProviderDependencies` carries what a host,
  rather than a document, decides: `agentCwd` answers with the directory an Agent
  runs in when the contextual one is not a directory an agent process could stand
  in; `mcpServers` and `newSessionOptions` are passed to runtime creation and to
  `ensureSession()` exactly as given; `permissions: "strict"` selects the
  workflow profile's permission path; and `sessions` replaces directory-walk
  placement with a host's own, and is where a retained session this host cannot
  continue is refused. Every one of them defaults to the `xmd run` behavior above.
- **Teardown.** Provider-scope teardown cancels active turns and closes each
  distinct runtime handle with an all-settled strategy, throwing a single error or
  an `AggregateError` from the provider scope.
