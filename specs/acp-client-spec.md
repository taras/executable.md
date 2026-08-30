# Executable.md ACP Client

The `Agent` Api, the `<Agent>` / `<Session>` / `<Prompt>` components, prompt
journaling and replay, the provider-factory seam, and the `Config` timeouts are
implemented in `@executablemd/core`. A provider is supplied through
the `rootProvider` factory seam described below.

## The Agent Api

`Agent` is an Effection Api (`@executablemd/core`) for stateful coding-agent
sessions, distinct from the stateless Sample Api. It has exactly five
contextual operations:

```ts
interface AgentApi {
  agent(name?: string): Operation<Agent>;
  session(name?: string): Operation<Session>;
  prompt(content: string, options?: PromptOptions): Operation<Stream<AgentPromptEvent, string>>;
  launch(request: AgentLaunchRequest): Operation<void>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}
```

The caller-facing native-launch operation is separate from that request-only
route:

```ts
function launchAgentSession(
  instructions: string,
  options?: LaunchOptions,
): Operation<SessionLaunchResult>;

interface LaunchOptions {
  agent?: Agent;
  session?: string | Session;
}

interface SessionLaunchResult {
  agent: Agent;
  session: Session;
  nativeSessionId: string;
  launcher: string;
}
```

`launchAgentSession()` and `prompt()` resolve through the same `Agent` and
`Session` operations. The extra shape exists only at the authority boundary:
callers supply instructions and receive a result, while public Agent middleware
routes an opaque request and cannot manufacture that result.

- `Agent` is a resolvable agent name (a string). `Session` is
  `{ sessionKey; cwd; agentSessionId? }`. `PromptOptions` is
  `{ agent?; session?: string | Session; timeout? }`.
- `AgentPromptEvent` is `started` → zero or more `text_delta` → one `terminal`
  (`{ status: "completed" | "failed" | "cancelled"; stopReason?; error? }`).
- `launch()` routes one frozen, one-use `AgentLaunchRequest` and answers
  nothing. `launchAgentSession(instructions, options)` is the canonical
  operation that issues that request, retains the launch's phases, and derives
  its `SessionLaunchResult`; the route is where public middleware sees the ask,
  and authority to perform it reaches the installed provider directly rather
  than travelling on this chain
  (specs/native-agent-session-launch-spec.md). A launch performs no model turn,
  and a provider that answers `prompt()` does not thereby answer it: native
  session launch is its own capability, installed on its own.
- Built-in **`claude` is advertised**, for two separate capabilities: native
  launch, and attaching ACP to a session a native process constructed. Its
  sessions are named by XMD and created by the native process
  (specs/native-agent-session-launch-spec.md). So the ownership,
  construction-route and executable-observation requirements below apply to it
  on every host, and only the hosts that assemble all three — Deno and the
  compiled binary — can serve it. `codex` remains unadvertised for both.
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
- The host also passes in a **construction-route store** and an **executable
  observer**, directly and from the same trusted root as the coordinator. Both
  are required only for an advertised agent whose adapter names its own
  sessions: a provider that returns the identity constructs nothing a route
  governs and binds no build, and keeps its behavior unchanged on a host that
  has neither. A host missing either refuses that agent before any provider
  effect, on the same terms as a missing coordinator. The observer is not a
  contextual Api for the same reason the coordinator is not: executable
  validation decides which retained history may be accepted.
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
- A `session()` or subscribed `prompt()` meeting a **bound** `client-native`
  route **attaches** to it. Under the same ownership it reobserves the build and
  compares the binding exactly, requires any retained ACP arrangement to assert
  that route's identity, selects the runtime for `(resolved agent command,
  binding)`, calls `ensureSession()` with `resumeSessionId` equal to that
  identity, and requires the returned canonical assertion to equal it before a
  turn. The observed executable path reaches only that runtime's transient child
  environment. A legacy unbound `client-native` route, an agent this host has
  not advertised for attachment, build drift, a disagreeing arrangement and a
  differing returned identity each refuse before a turn and create no substitute
  conversation.
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

### Agent selection, directories, and models

`<Agent>`'s `name` prop is optional. Omitting it asks `Agent.agent(undefined)`
to resolve the current agent: an enclosing `<Agent>` when one is active,
otherwise the installed provider's `defaultAgent`. An explicit name overrides
that selection for the element's body. A self-closing `<Agent />` performs the
same resolution and availability validation, then renders nothing; it does not
create a session or run a turn.

`defaultAgent` names an ACP agent command, not a model. The stateful Agent and
Session surface has no `model` prop or launch option in V1. Model routing on the
stateless Sample Api is a different contract and does not create an implicit
model-selection mechanism for `prompt()` or native launch. A provider may
report the model already active in its session as observational evidence, but
that observation neither selects nor changes it.

The current ordinary-run Agent surface grants the resolved contextual cwd and
defines no directory-registration component. In particular, `Agent.AddDir` is
not registered or specified as an available component, and native launch's
`additionalDirectories` value is the explicit empty ordered list. A future
directory-registration feature must first define path resolution, ordering and
access modes here; until then native launch cannot claim or widen any additional
root. Filesystem accessibility and rendered agent instructions remain separate:
the cwd is not injected as text, and rendered instructions grant no directory.

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

A canonical Markdown test may configure one nested `host="run"` execution with
a direct `<TestAgent>` declaration (`testing-spec.md`). That declaration carries
only detached scenario data. The trusted child host installs the controlled
root provider and launcher in the isolated child, registers these six defaults
and declares `<Session>` before root import. The provider and every logical
session belong to that exact child; a sibling nested execution receives fresh
state. Ordinary component resolution remains in force, so configuring the
provider does not force any of these defaults to win over a repository
component.

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
- **`<Agent name?>`** resolves its explicit name, or the current/default agent
  when `name` is omitted, and for its body pins that resolved agent onto nested
  prompts and launches. Self-closing performs the same resolution and
  availability validation, then renders nothing.
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

The profile states both native capability sets empty for the same reason. A
workflow session belongs to a run — named by a row in the run's own database,
arranged in the run's own sidecar, continued by reattaching that row — and the
machine-wide account of ownership, construction routes and executable builds
describes a different thing entirely. Inheriting the package's advertised sets
by omission would make an ordinary workflow Claude prompt demand machine
ownership and a route this profile has no way to give it. The profile therefore
supplies no session coordinator, no route store and no executable observer, and
never consults their namespace.

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
no workflow-only operation, and `xmd run` keeps its caller-selected cwd, its
omitted MCP and session options, and its public permission routing.

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

**A canonical assertion comes before the mapping.** The order is: placement,
then the backend's acceptance of the session's first turn, then the provider's
canonical, tagged assertion of a durable identity, then the mapping commit — and
only then whatever that first turn produced. Placement is inert: it creates no
provider session and commits no row. Holding a key in ACPX's store is not an
assertion — it says something is there, not what conversation it is — and a
record held for a first turn nobody accepted asserts nothing at all, so a mapping
is committed only from one canonical assertion, and an interruption before that
commit is reconciled only the same way.

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

`xmd run` and `xmd prompt` configure the agent stack; the options belong to
those two commands, and `xmd test` rejects them, driving agents through the
deterministic test-agent stack instead.

That division also applies to a nested run profile. The outer `xmd test`
invocation supplies no live Agent configuration to a child and no contextual
provider crosses the child's isolation boundary. A direct `<TestAgent>`
declaration on one `<Execution host="run">` explicitly selects the controlled
test-agent assembly for that child alone; without one, the child receives no
Agent provider from the outer test.

| Option | Meaning |
| --- | --- |
| `--agent-provider <name>` | the registered provider to install (default `acpx`) |
| `--default-agent <name>` | the default agent |
| `--approve-all` | approve every permission request |
| `--approve-reads` | approve reads and searches, ask for the rest (default) |
| `--deny-all` | deny every permission request |

The permission options are mutually exclusive.

Both commands also take the three timeout options, which belong to them in the
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
5. an explicit `<Agent name>`, `<Prompt agent>`, or `<Session.Launch agent>`.

The installed provider belongs to the run's `DocumentExecution` scope and closes
during its teardown.

### The `xmd prompt` prompt profile

`xmd prompt` resolves that configuration once and uses it twice: for the prompt
command document that writes the Plan, and for the Plan that runs. The provider
name, the default agent with its `DEFAULT_AGENT_NAME` precedence, the permission
mode and the host's own machine-session assembly are settled before any catalog
is built or any document executes, so an unknown provider or an incompatible
pair of permission flags fails first. It is the settled value that reaches both
consumers, not the flags that produced it: `DEFAULT_AGENT_NAME` is read once per
invocation, and authorship and the executed Plan cannot reach different
conclusions from one command line.

The prompt profile takes the provider name and the default agent from that
answer, and nothing else. Its ceiling is the host's, assembled for that one
document and not readable from the command line:

| The profile's provider gets | Stated as |
| --- | --- |
| one host-owned directory per logical session | `agentCwd`, `~/.xmd/prompt/sessions/<sha256(name)>`, required empty |
| no MCP servers | `mcpServers: []`, an empty set rather than an omission |
| no native tools on a fresh session | `newSessionOptions.allowedTools: []` |
| a private refusal of every native permission request | `permissions: "strict"` |

`"strict"` answers the request inside the provider: the request is denied, the
turn it belongs to fails, and no public Agent handler is consulted or can
intervene. So `--approve-all`, `--approve-reads` and `--deny-all` cannot widen a
ceiling that has nothing in it; they configure the approved document later. A
provider that cannot establish this ceiling refuses before session
materialization or a turn.

The command document itself is given no Files, command, service or XMD-mediated
network capability, and the host decides for that whole execution that a failing
`<Prompt>` ends it — so a turn that streamed text and then failed presents
nothing.

The profile's working directory is derived from the logical session name rather
than shared or freshly made: `~/.xmd/prompt/sessions/<sha256(name)>`, with the
digest in the path and never the name. A session's key includes the directory it
lives in, so a shared location would put two conversations in one ambient
directory while a fresh one would leave `--session` unable to name a conversation
that already exists. It is created empty and required to be empty before the
provider is constructed or a session is materialized; a non-empty one is a
terminal refusal rather than something to clean. Nothing this profile grants can
write there.

An explicitly named session keeps its directory afterwards, because that is what
the next invocation derives the same session identity from, and no cleanup
applies to it. An invocation-unique default keeps nothing: its release is
registered before the directory is created, and once the profile has torn down,
on every ending, exactly one cleanup is attempted — the leaf is removed
non-recursively if it is still the empty directory that was handed over, and if
it has gained content or disappeared it is left as found and the command fails
terminally. Which applies is a trusted host value —
whether `--session` was written — and where the directories live is a host
dependency no caller or document can select.

Only the profile's provider receives `newSessionOptions.systemPrompt`. It carries the
fixed statement of what the session writes, and nothing else — the catalog and
the request are the command document's to send in its own turns
([`xmd prompt`](./prompt-command-spec.md)). ACPX applies those options when it
creates a session and ignores them when it reuses a record. Without `--session`
the command places a name unique to the invocation, so each invocation is a fresh
conversation created under those instructions; `--session <name>` selects an
existing one under ordinary continuation semantics.

That document's scope closes before the final validation, the save and the
execution. A teardown failure fails the command and no later phase happens. The
executed program is an ordinary `xmd run` document with its own root provider and
its own lifetime: it inherits neither the assistant session nor its instruction
layer.

### Availability

Installing a provider starts nothing. The **first** Agent API use validates the
selected agent, and `<Agent>`, `<Prompt>` and `<Session.Launch>` resolve the agent
through the Agent API before a turn or launch begins. A document that never uses
an agent therefore never probes one, and a confirmed full replay restores its
completed work without re-checking availability.

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
- **Sessions.** `session()` places a session by (agent, logical session,
  contextual cwd): placement walks from the cwd up to the Git root and reuses the
  nearest existing record for the same agent command and cwd, otherwise names the
  exact cwd. The resolved `sessionKey` — not the caller cwd — keys the session
  queue.

  A placement is **pending** or **established**. Pending says where a session
  will live and nothing more, and `session()` returns it having contacted no
  backend, published no construction route, built no runtime, written no record
  and started no turn — so a `<Session.Launch>` nested inside that `<Session>`
  still gets to choose how the session is constructed. Established says the
  route and the durable identity already exist, and `session()` keeps its eager
  behavior for one: it takes ownership where the agent needs it, reconciles the
  retained route, ensures through the bound runtime, validates the exact identity
  and host mapping, releases the handle, and starts no turn.

  Directory placement classifies a record still carrying the pending
  materialization marker as pending, and a record without one — including every
  record written before deferred materialization existed — as established. A
  retained client-native route is established even before ACPX has attached to
  it. A published `acp-first` route is not: it is what a first turn writes down
  before it runs, and a first turn nobody accepted leaves exactly that behind.

  A `Session` value must come from this provider's `session()`, and the test is
  the exact object it issued rather than the key inside it: a structural copy, a
  value another provider copy produced, and one whose provider scope has been
  torn down are all refused before any provider work, as is a value used with a
  different resolved agent. The provider keeps that object for the placement's
  life, so a second `<Session>` naming the same placement is answered with it and
  a `<Prompt>` given it is acting on the thing that was pinned.

- **Materialization.** A pending ACP-first placement is constructed by the first
  subscribed `<Prompt>`, and only the backend's acceptance of that turn makes it
  a conversation. The provider ensures with
  `materialization: "first-turn-acceptance"`, which makes ACPX persist a
  provisional record: the key is occupied and the serialized `agentSessionId` is
  absent, so the record is occupancy rather than an assertion.
  `AcpRuntimeTurn.materialized` settles when the session no longer awaits its
  first accepted turn — at once for a record that already asserts, and on the
  adapter's explicit signal for one that does not.

  The signal is one exact versioned key,
  `executablemd.session-materialization/v1`, carried as `{"state": "accepted"}`
  in the update metadata of a standard ACP `session_info_update`. It is control
  data: ACPX consumes it, and it is never appended to the conversation, published
  as an event, exposed as prompt text or retained as a checkpoint token. Nothing
  else promotes a record — not a returning `ensureSession()`, a `startTurn()`
  that returned, a synthesized `started` event, a first text delta, a terminal
  result, checkpoint metadata, an error code or a diagnostic.

  On acceptance ACPX promotes a copy of the live record by installing the
  identity the handle privately carries and removing the pending marker, saves
  that asserting record through the store's own atomic operation, updates the
  in-memory record only after that save returns, and then resolves
  `materialized`. Promotion is serialized against live-checkpoint writes, so a
  promotion that failed is not later overwritten by finalization as though it had
  succeeded. `materialized` rejects when the turn fails, is cancelled, or ends
  without the marker, and the runtime observes that rejection itself so a
  consumer using only `runTurn()` creates no unhandled rejection.

  The durable order is therefore: route, provisional non-asserting record,
  backend acceptance, asserting record, host mapping, and only then the events
  the turn produced. If materialization fails the provider removes no route,
  publishes no identity, calls no host mapping, gives up the handle so the next
  attempt creates rather than resumes, and leaves the exact `Session` value
  pending for a retry. If it succeeds and the turn then fails, the session stays
  established: acceptance, not successful terminal text, is the boundary.
  `packages/acp/vendor/acpx/PROVENANCE.md` records the vendored patch this rests
  on and what removes it.
- **Prompts.** `prompt()` returns a cold stream; each subscription is one turn
  owned by the subscriber. Events are normalized to one `started`, `text_delta`
  for output-stream deltas only (thought/status/tool/usage stay private), and one
  `terminal`, then the stream closes with the full concatenated text (including
  partial text on failure). A completed turn with an absent stop reason is treated
  as `end_turn`; any other stop reason is a failure.
- **Serialization.** Prompts for one session run FIFO on that session's queue;
  different sessions run concurrently. A subscription enters that queue before
  any route, ensure or runtime creation for its placement, and re-reads the
  placement's state once the queue grants — so two concurrent first prompts on
  one session perform exactly one backend creation and the waiter continues the
  conversation its predecessor established. `withSessionRoute` — the hook an
  embedder supplies through `AcpxProviderDependencies` — wraps registry-dependent
  work (preparation, ensure/start) and is not held across turn consumption or
  across the wait on a session's own queue. The queues that serialize this are
  internal to the package.
- **Permissions.** ACPX permission requests are routed — keyed by the record's
  live ACP session id, refreshed on demand — to the in-flight prompt's scope and
  answered through `Agent.requestPermission`; an ambiguous or unknown request
  fails closed. The permission callback always returns a concrete outcome and
  therefore never delegates to ACPX's fallback resolver. ACPX's own
  Promise-returning leaves are consumed with `until`; the provider's only
  Promise-producing adapter is the `onPermissionRequest` callback, and the bridge
  itself is operation-based.
- **Runtime partitions.** Ordinary ACP-first work uses one unbound runtime. A
  bound attachment uses one runtime per `(resolved agent command, executable
  build binding)`, created with the observed path in `agentProcessEnv` and torn
  down when its last handle closes. Acquiring a runtime to ensure through claims
  the partition, and an `ensureSession()` that rejects gives that claim up — so
  the next attempt observes again rather than inheriting a live path nothing is
  holding, while a sibling ensure still in flight keeps the partition alive.
  Eviction requires no handles and no work in flight. A handle that came back is
  owned from that moment, on a provider-returned launch as much as on an
  attachment, and survives every later refusal — identity mismatch, a host that
  cannot retain the session, and a status read that fails all close it through
  its creator. A cancellation with an ensure still in flight
  waits for its answer rather than walking away from it — the call runs whether
  or not anybody is waiting — releasing the claim on a rejection and closing a
  returned handle through its creator before quiescence. A close that failed
  decrements nothing, evicts nothing, forgets nothing and withholds quiescence,
  which an operation answers from that ownership account rather than from the
  sessions a caller can reach. A managed session retains the partition that
  created its handle, and every turn, close, detach and teardown goes through
  that one — reaching for "the" runtime afterwards would open a second child for
  a session the first already owns. `agentProcessEnv` is a local patch to the
  vendored ACP runtime; `packages/acp/vendor/acpx/PROVENANCE.md` records why it
  exists and what removes it.
- **Host-owned dependencies.** `AcpxProviderDependencies` carries what a host,
  rather than a document, decides: `advertiseNativeLaunch` and
  `advertiseClientNativeAttachment` are two separate lists, and a profile whose
  session authority differs from ordinary `xmd run` states both explicitly
  rather than inheriting the package's defaults by omission;
  `executableObserver` says how this host observes the build behind an
  executable; `agentCwd` answers with the directory an Agent runs in when the
  contextual one is not a directory an agent process could stand in; `mcpServers` and `newSessionOptions` are passed to runtime creation and to
  `ensureSession()` exactly as given; `permissions: "strict"` selects the
  workflow profile's permission path; and `sessions` replaces directory-walk
  placement with a host's own, answering with the placement's `state` as well as
  its key and directory, and is where a retained session this host cannot
  continue is refused. `sessions.established()` is called where an assertion
  exists and not before: after the ensure that validated a reattachment, and
  after the backend accepted a constructed session's first turn. Every one of
  them defaults to the `xmd run` behavior above.
- **Teardown.** Provider-scope teardown cancels active turns and closes each
  distinct runtime handle with an all-settled strategy, throwing a single error or
  an `AggregateError` from the provider scope.
