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
- The provider is constructed with three host capabilities, all passed directly
  and none contextual: the session coordinator, the construction-route store,
  and — for an adapter that binds an executable build — the executable observer.
  An advertised agent refuses when any of them is missing, because answering two
  of the three questions is not enough to act on a session a native UI may be
  in. An unadvertised agent keeps ordinary ACP behavior on every host.
- Every operation that can act on an **advertised** session — `session()`, a
  subscribed `prompt()` stream, a launch, and an incomplete launch replay —
  takes exclusive ownership of it first, through the session coordinator its
  host passed into the provider. Coverage follows the agent's capability, not
  the operation, and not which mechanism constructed the session: a prompt for
  an advertised agent may be talking to a session a native UI is in right now.
  Resolving an agent owns nothing. Acquisition never waits: contention refuses.
- A host that is missing any of the three capabilities refuses each of those
  four surfaces **before any provider work at all**. Not merely before `ensure`:
  before an agent is probed, and before the ACP session store is read. Deciding
  which existing session a caller meant loads session records, and a host that
  may not act on a session must not read that session's state to learn what it
  is refusing. A read-only agent resolution still answers.
- Before it ensures or takes a turn, and while ownership is held, the provider
  reconciles the session's **construction route**. An eager `session()` publishes
  `acp-first`; a client-native launch publishes `client-native` under an identity
  its adapter allocated. Publication is create-once, so the loser of either order
  adopts the winner rather than replacing it, and no route ever converts into the
  other. `withSessionRoute` remains routing only — it selects which partition
  serves a call and carries no authority to construct, own or answer.
- A session constructed client-native is **attached to, never created**: the
  provider passes the retained identity as `resumeSessionId`, and an attachment
  that reports a different session is refused and its handle released before a
  turn is taken. An ACP-first session attaches with no resume identity.
- ACP runtimes are partitioned by **executable build binding** — the agent
  command together with the canonical reported version and the digest of the
  executable's bytes. A handle belongs to the runtime that made it and is used
  only through it, so a session bound to one build can never take a turn through
  a connection to another. The adapter child for a bound session is spawned with
  a transient environment naming that exact executable, assembled per launch and
  never written to the host process environment.
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

`installAgentComponents()` registers seven components for the installing scope
(§5.3). They are ordinary function components and non-reserved **defaults**: a
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
  launches. Self-closing validates only.
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

The ACP runtime this package executes is a source snapshot of `acpx@0.12.0`
under `packages/acp/vendor/acpx`, not the resolved package, carried with one
behavioral patch that threads a transient agent-process environment through to
each spawned child. `vendor/acpx/PROVENANCE.md` records the upstream release
commit, the patch, and the packaging adaptations; `scripts/tests/acpx-vendor.test.ts`
proves offline that nothing else differs from the pristine upstream bytes.

The snapshot is owned by issue #519 and removed by issue #526, after a released
upstream package set provides that input on its own and passes #526's removal
gate. Vendoring is a workaround for a missing upstream capability, not a
long-term position.

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
- **Teardown.** Provider-scope teardown cancels active turns and closes each
  distinct runtime handle with an all-settled strategy, throwing a single error or
  an `AggregateError` from the provider scope.
