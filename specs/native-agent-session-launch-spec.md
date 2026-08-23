# Native Agent Session Launch

**Status:** Built
**Related:** [Executable.md ACP Client](./acp-client-spec.md),
[Markdown Agents Vision](./markdown-agents-vision.md),
[Workflow Workspace](./workflow-workspace-spec.md),
[native session launch story](https://github.com/taras/executable.md/issues/517),
[future bootstrap prompts](https://github.com/taras/executable.md/issues/514)

## Purpose

An executable document can prepare a coding-agent session and then place the
user in that agent's native interactive UI. The document decides which context
the session receives and which filesystem roots it can use. The provider owns
the mapping from the logical XMD session to the durable native session and the
command that resumes it.

The common repository entry point is an ordinary document target:

```sh
xmd AGENTS.md#Implementor
```

The target executes deterministic preparation, establishes one durable agent
session, releases XMD's ACP ownership of that session, and starts the provider's
native UI. XMD remains the parent process and waits. Document execution resumes
only after the native UI exits.

This is session construction followed by an ownership handoff. XMD does not
become a chat frontend, proxy terminal input, or interpret the native UI's
turns.

## Smallest example

```md
# Repository Agents

## Implementor

The implementor makes changes according to the approved plan.

<Agent>
  <Session name="implementor">
    <Session.Launch>
You are the repository implementor. Follow the supplied role contract,
architecture, and approved plan.

<File path=".agents/implementor.md" />
<File path="architecture.md" />
<File path=".xmd/approved-plan.md" />
    </Session.Launch>
  </Session>
</Agent>

## Architect

The architect reviews settled structural invariants.

<Agent>
  <Session name="architect">
    <Session.Launch>
You are the repository architect. Apply the supplied role contract and
authoritative architecture.

<File path=".agents/architect.md" />
<File path="architecture.md" />
    </Session.Launch>
  </Session>
</Agent>
```

The paragraphs outside `Session.Launch` remain documentation and rendered
output. Only the rendered body of `Session.Launch` becomes prepared agent
instructions. A file that exists in the repository is not selected merely
because the provider can read it.

`Agent` keeps provider and model binding separate from role identity. With no
authored agent name, the host's `--default-agent` selects Claude Code, Codex, or
another compatible agent without changing what `Implementor` means.

## Existing semantics

The feature reuses these contracts unchanged:

- a static heading target is the role entry point, and sibling targets do not
  execute;
- document help discovers targets without executing authored effects;
- ordinary XMD components gather, parse, and transform preparation inputs;
- `Agent` selects the coding agent lexically, and is the availability boundary
  for what it wraps;
- `Session` identifies stateful continuity lexically;
- the contextual cwd participates in logical session identity;
- the Agent provider belongs to `DocumentExecution` and finishes teardown before
  the document completes;
- completed durable effects restore without contacting their external provider;
  and
- a missing or unresumable provider session fails rather than being replaced by
  transcript reconstruction.

No behavior depends on the filename `AGENTS.md`. Any executable document target
can launch a prepared native session.

## The added operation

The Agent API gains one operation:

```ts
interface AgentApi {
  agent(name?: string): Operation<Agent>;
  session(name?: string): Operation<Session>;
  prompt(
    content: string,
    options?: PromptOptions,
  ): Operation<Stream<AgentPromptEvent, string>>;
  launch(request: AgentLaunchRequest): Operation<void>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}

interface LaunchOptions {
  agent?: Agent;
  session?: string | Session;
}

interface AgentLaunchRequest {
  readonly instructions: string;
  readonly agent: Agent;
  readonly session?: string | Session;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly permissionMode: PermissionMode;
  readonly model?: string;
  with(changes: {
    instructions?: string;
    agent?: Agent;
    session?: string | Session;
  }): AgentLaunchRequest;
}

interface SessionLaunchResult {
  agent: Agent;
  session: Session;
  nativeSessionId: string;
  launcher: string;
}
```

`Agent.launch(instructions, options)` is the canonical operation and the only
owner of what a launch settles on: it reserves the terminal, normalizes the
request, mints its durable identity, retains every phase, and derives the
`SessionLaunchResult`. It is available anywhere inside a live document
expansion, including a repository function component, and refuses outside one.

The `launch` route on the Agent Api is the *public* surface, and it routes
rather than performs. What travels on it is one frozen, one-use
`AgentLaunchRequest` describing the launch; middleware may inspect it, narrow it
through `with()`, refuse by throwing, or delegate it, and what a handler returns
is discarded. Identity is object identity: a rebuilt look-alike, a superseded
parent, a foreign request, or a second delegation of the same leaf describes the
same ask and authorizes none of it.

Authority to run and retain a phase never travels on that chain. Core delivers
one `AgentProviderAuthority` directly to the provider factory it installs, as an
argument the factory closes over — there is no context holding one, no request
member carrying one, and no reader for one. The authority validates the routed
request and the provider's installation generation, runs each absent phase once,
cross-checks the returned record against the request, retains it before the next
live effect, and derives the result. A provider supplies the work; it never
supplies the verdict.

`launcher` is a stable provider-assigned adapter identity such as `claude` or
`codex`, not an executable path. The result describes a successful normal exit;
nonzero exit, signal, and cancellation do not produce it. It contains only
filtered stable evidence and exposes no process handle, ACP client, credential,
raw environment, or executable argument vector.

`launch()` is distinct from `prompt()`:

- `prompt()` performs one model turn through ACP and returns the agent response;
- `launch()` performs no model turn, transfers the session to a native UI, and
  returns only after that UI exits.

The base `launch()` handler fails. A provider must install the operation
explicitly; availability of `agent()`, `session()`, and `prompt()` does not imply
native-launch support.

`Session.Launch` renders its body before invoking `Agent.launch()`. An empty body
is valid and prepares no additional instructions. Its optional `agent` and
`session` props mirror `Prompt`; omitted props use lexical `Agent` and `Session`
configuration.

## Prepared session request

Core hands the provider a normalized request containing:

```text
agent
logical session
prepared instructions
primary cwd
ordered additional directories
effective model request, when present
effective permission configuration
source position and expansion identity
```

The provider applies the instructions as a provider-native session, system, or
developer instruction layer before the native UI accepts its first user turn.
It does not send the instructions as a user message and does not invoke a model.

A provider that cannot establish instructions without a model turn refuses the
launch. V1 has no bootstrap-prompt fallback. An explicit, observable bootstrap
mode is a separate future feature tracked by issue #514.

Prepared instructions are the current attachment's instruction layer. A
relaunch with the same layer resumes the existing provider session and does not
append another copy to conversation history.

A relaunch with a different layer reconciles according to provider capability:

- a provider may replace the layer in place only when it can preserve the same
  provider-native identity and all provider-native conversation history without
  invoking a model, and reports `replaced`; and
- otherwise the provider refuses with `instructions-refused` before detaching
  ACP ownership or starting a native process.

V1 discards no persistent provider state. There is no third branch in which an
"unused" session shell is deleted and remade: no observation available on this
side distinguishes a session that was never used from one a native UI has been
in for an hour, so no launch path sends a discard. `installed`, `resumed` and
`replaced` are the whole of `instructionReconciliation`. What this costs is a
refusal where a recreation would have been convenient; what it buys is that no
launch destroys a conversation XMD does not own and cannot see.

An empty cached transcript is not proof that a retained or previously handed-off
session has no conversation. Native UI turns are provider-owned and need not be
mirrored into ACPX or XMD state. Relaunch therefore never silently keeps a stale
layer, discards unobserved native history, substitutes a new provider session
for retained continuity, or performs a bootstrap turn.

The prepared text and the filesystem roots are different capabilities:

- cwd and additional directories determine what the native agent can access;
- prepared instructions determine text supplied to the model as instructions;
- neither one implies the other; and
- unreferenced repository files are not injected as text.

The native launcher preserves the admitted access mode of every root. It cannot
map a read-only additional directory to a native CLI option that makes the
directory writable. An adapter without an authority-preserving mapping refuses
that request before handoff.

Raw prepared instructions never appear in process arguments or environment
variables. A provider uses its session API or an invocation-private file with
restrictive permissions and removes any temporary during cleanup.

## Provider-native identity

Three identities remain distinct:

```text
logical XMD session key
ACPX record/session identity
provider-native session identity
```

An identity is chosen in one of two ways, and the prepared record says which.

```ts
type IdentityProvenance = "provider-returned" | "client-allocated";
```

`provider-returned` means the provider created the session and reported what it
is called; `client-allocated` means XMD chose the identity before the provider
existed and supplied it unchanged. New records always write provenance. A
released record without the member reads only as `provider-returned`, because
client allocation did not exist in that format — the one compatibility
inference this contract makes, and it infers only the weaker claim. Unknown
provenance refuses.

The identity itself comes from the adapter. What shape a provider-native
identity takes and what that provider will accept is knowledge about that
provider, so an adapter that names its own sessions allocates one, and the
provider decides only whether a freshly allocated candidate wins publication.
Allocation happens while coordinator ownership is held. An authored string, a
logical XMD session key, an ACP session ID, an ACPX record ID, process output,
or a value that merely looks like a UUID never supplies or replaces it.

Where the provider returns the identity, XMD does not infer that an ACP session
ID is accepted by a native CLI merely because both values are strings or UUIDs.

A provider-returned native-launch-capable provider proves all of the following:

1. session creation materializes durable state the native UI can resume;
2. its returned native ID names that exact state;
3. prepared instructions are effective on the first native user turn without a
   bootstrap model turn;
4. cwd, additional directories, model, and permissions survive the handoff;
5. the ACP owner can release the session before native attachment;
6. the native process can exit without deleting the resumable session; and
7. ACP can later reattach to the same session if document execution uses it
   again.

An adapter that names its own sessions proves less, because it asks less: no
ACP session is created, so there is nothing for ACP and a native process to
agree about. It creates the session directly and resumes it by the same name.

For the built-in adapters, the native commands are:

```text
claude --session-id <native-session-id> --system-prompt-file <private-file>
claude --resume <native-session-id>
codex resume <native-session-id>
```

This release retains no executable path, version or byte digest, and accepts
that the installed native CLI may have changed between invocations. A CLI that
cannot resume the retained identity fails normally; XMD creates no replacement
history. Exact executable equality becomes necessary only before ACP and native
processes may jointly accept one identity as one history, which is deferred with
ACP reattachment.

Those command shapes are adapter implementation details, not authored document
values. A custom ACP agent without a declared native launcher fails with an
unsupported-capability error before XMD releases its ACP session.

Knowing a command shape is not the same as being launch-capable. Advertisement
is separate, and empty by default: an adapter becomes launch-capable only once
an opt-in integration test proves the seven claims above against the installed
CLI. Until then `<Session.Launch>` refuses that agent before releasing its ACP
session, which is the failure this contract asks for rather than a hopeful
spawn. `claude` and `codex` are unadvertised on `main`.

## Runtime sequence

Given `xmd AGENTS.md#Implementor`:

1. XMD resolves the selector to one exact canonical document target.
2. The CLI installs the selected Agent provider and native process launcher.
3. Target projection excludes sibling roles.
4. XMD expands the target and renders `Session.Launch` content completely.
5. File reads, captures, parsing, and deterministic evaluation finish or fail.
6. `Session.Launch` takes the run's one foreground-terminal lease. A host with
   no terminal refuses here — before an agent is resolved, so learning that
   this invocation cannot launch anything costs no availability probe.
7. The host flushes what the document has produced, so the native UI does not
   open over half-written output.
8. The provider resolves the logical Agent and Session against the contextual
   cwd.
9. The provider creates or resumes the durable provider session and applies the
   prepared instruction layer and directory configuration.
10. The provider verifies a native-resume capability and obtains the exact
    native session ID.
11. XMD commits the prepared launch record before releasing ownership.
12. The provider closes or detaches the ACP session and waits for that owner to
    terminate, and XMD commits that too.
13. The provider spawns the native UI as a foreground child using the native
    session ID, with the terminal inherited.
14. `Session.Launch` suspends while the child runs.
15. The child handles prompts, tools, permission dialogs, rendering, and native
    transcript persistence directly.
16. When the child exits, XMD records its terminal outcome and releases the
    terminal lease.
17. Later Agent work lazily reattaches through ACP to the same provider session.
18. Document execution continues after `Session.Launch`.

An enclosing `<Agent>` or `<Session>` resolves by its own contract, before
anything inside it runs, so a document that wraps a launch has already reached
its provider by step 6. That is an ordinary earlier effect: what step 6 stands
in front of is the launch, and no session ownership transfers before it.

XMD spawns and waits; it does not replace itself with `exec`. Remaining the
parent preserves document cancellation, child-liveness settlement, exit-status
ownership, and continuation after the UI closes.

## Ownership and concurrency

One session has one active owner. Its states are:

```text
ACP-owned -> detaching -> native-UI-owned -> detached -> ACP-owned
```

The transition to native ownership occurs only after ACP release completes. The
provider never runs ACP prompts against a native-owned session. A launch holds
the session's ownership until the native child exits.

Ownership is answered by a plain `AgentSessionCoordinator` the host builds and
passes directly into the provider's dependencies. It is deliberately not a
contextual Api: ownership is a security decision, and one document middleware
could replace is not one. Its key is natural rather than authored:

```text
provider = acpx
agent    = the resolved agent command
sessionKey = the resolved xmd:v1 session key
```

Every operation that could act on an advertised session enters it first —
establishing the session, subscribing a prompt stream, launching, and resuming
an incomplete launch. Coverage follows the agent's capability, not the
operation, and not which mechanism constructed the session. Resolving an agent
and placing a session own nothing, because there is no session yet to own. An
agent no adapter is advertised for keeps ordinary ACP behavior on every host.

Acquisition never waits. A native UI may stay open for hours, and a caller that
queued would hold the reader's terminal while offering no way to reach the owner
it waits for. A contending launch retains `session-busy` and performs no ACP
ensure, detach, or spawn; session and prompt work raises the corresponding typed
failure instead of manufacturing a launch record.

The body of an acquisition receives a one-use `quiesced()` acknowledgement. What
it acknowledges is not "I finished" but "nothing I started can still touch this
session" — so a provider acknowledges it exactly when it no longer holds a
usable handle for that session. A handoff whose detach failed, or a session
prepared and never handed over, does not acknowledge, and the durable record
stays active.

An active record is a recovery tombstone. A crash releases the kernel lock but
not the record, and nothing observable afterwards distinguishes a session whose
owner died mid-turn from one it left cleanly — so the next owner receives
`session-recovery-required` rather than inferring safety from a pid, an elapsed
time, an empty transcript, or the lock being free. V1 exposes no recovery
operation.

The Deno and compiled hosts combine three things a single one of which would not
be enough: a process-local occupancy table, one non-blocking advisory lock, and
an ownership record atomically replaced and durably flushed — active before any
provider work, idle only after `quiesced()` and before unlock. They live in a
machine-wide namespace, because two processes resolving different roots would
each hold "the" session:

```text
~/.acpx/xmd-native-sessions/v1/
  leases/<sha256-of-canonical-key>.lease
  ownership/<same-digest>.json
  routes/<same-digest>.json
```

Directories are `0700` and files `0600`; lease sidecars are never unlinked. The
record is exactly `schema`, `keyDigest`, `state`, `ownerKind` and `operationId`,
and a record carrying any other member is refused rather than read partially.
It holds no instructions, credential, cwd, executable path, argv, environment,
transcript, or temporary path — the digest is the only name in the namespace.

Node and Bun build no coordinator. Neither runtime exposes a cross-process
advisory lock, and V1 emulates none: a pid, heartbeat, or stale-file timeout
calls a paused process dead and admits two owners. So every advertised
session, prompt, launch and incomplete replay refuses there with
`unsupported-capability`, before contacting an agent, while read-only resolution
and non-advertised ACP work are unaffected. A host missing only the route store
refuses an advertised agent that names its own sessions, on the same terms and
before any provider effect; an agent whose provider returns the identity is
unaffected, because it constructs nothing a route governs.

## Construction route

Ownership and construction answer different questions, and this contract keeps
them apart:

```text
construction route:  how this logical session was first constructed
session coordinator: who may act on it now
```

The coordinator remains the single live authority and owns crash behavior. A
route grants no right to ensure, prompt, detach, spawn or accept history. It
says only which kind of thing this session is, so a later operation cannot
quietly treat a conversation that already exists as one it may name.

The exact V1 record is:

```ts
type AgentSessionRouteV1 =
  | {
      schema: "session-route.v1";
      route: "acp-first";
      provider: string;
      agent: string;
      sessionKey: string;
    }
  | {
      schema: "session-route.v1";
      route: "client-native";
      provider: string;
      agent: string;
      sessionKey: string;
      nativeSessionId: string;
      identityProvenance: "client-allocated";
      instructionsDigest: string;
      launcher: string;
    };
```

Every member is exact. A path, version, executable digest, adapter command,
environment, argv, instruction text, credential, transcript, process fact or
temporary path is not a member, and a record carrying one is refused rather than
read partially. So are missing, malformed, unknown-schema, moved and
natural-key-mismatched records. Only a file that is not there means the session
has not been constructed yet.

The route shares the coordinator's namespace, natural key and digest, so one
session names one lease, one ownership record and one route. The route directory
is `0700` and records are `0600`. Publication is durably flushed and atomically
create-if-absent: the loser of a race reads and adopts the winner, and never
overwrites, deletes, converts or partially reads it.

Reconciliation happens while ownership is held, before any provider
construction effect:

1. a first `session()` or subscribed prompt publishes or adopts `acp-first`
   before ACP runtime creation, `ensureSession()` or a turn;
2. an ensure that fails or is interrupted afterwards leaves that route standing,
   because it may have created provider state before the caller observed the
   failure, and preserving the route is what stops that uncertainty from later
   being reclassified;
3. a launch by an adapter that names its own sessions reads both the route and
   existing durable ACPX state; existing state publishes or adopts `acp-first`,
   and otherwise the adapter allocates a candidate and publishes `client-native`;
4. a launch that adopts `acp-first` retains `identity-unavailable` at `prepared`,
   before allocation, private-file creation, detach or spawn;
5. a `session()` or subscribed prompt that meets `client-native` raises the
   provider's typed route error before runtime creation, ensure, turn, close or
   accepted history. It retains no launch failure, because no launch was asked
   for.

The resolved agent command is carried from placement through the coordinator
key, the route key and provider work. It is never resolved a second time inside
ownership, because a registry free to answer differently would name a different
session than the one this operation prepared.

V1 also holds one foreground-terminal lease for the root CLI execution. Two
native launches cannot concurrently own the same terminal, even when they name
different sessions. Sequential launches are ordinary document composition.

Cancellation interrupts the native foreground process, establishes that it can
no longer execute or hold the terminal, restores terminal state, and runs every
provider finalizer. A process that ignores the initial interruption is
terminated according to the host process adapter's bounded shutdown policy.
The adapter attempts to collect the native exit status, but a runtime-retained
defunct PID or a lost exit event is not live process ownership. After a fatal
signal was accepted, or the process was already absent, bounded settlement may
release the runtime handle without waiting for signal-zero reachability to
disappear. XMD never continues the document while the child remains live.

Normal native UI exit completes `Session.Launch`. An independent nonzero exit or
signal fails it. Cancellation from the parent remains cancellation rather than
being reclassified as an ordinary child failure.

## Durability and replay

The launch is one durable effect type, `agent_session_launch`, named from the
expansion identity `<Session.Launch>` derives. Its records contain preparation
and lifecycle phases rather than the native conversation:

```text
prepared -> detached -> launched -> exited
```

Each phase the launch completes is one retained record under that identity,
because the preparation has to be retained *before* ACP ownership is released.
A single record written when the whole launch settles would describe nothing at
all for the run that was interrupted between detach and spawn, which is exactly
the run that must not create a replacement session.

`launched` is the live state between the spawn and the child's exit, and is
deliberately not retained: an interrupted native process leaves `detached` as
the last retained phase, and resuming reattaches the native UI to that same
provider session.

For a session XMD named, the retained phase is what decides the only safe
continuation, because `detached` is retained before the exit phase is invoked:

- **`prepared` only** — the handoff never began, so native creation may still be
  owed. The replay creates under the same retained identity, from a new private
  file holding the exact retained instructions. It allocates nothing and
  publishes no route.
- **`detached`** — a process may already have started under this identity, so
  the replay resumes and never falls back to creating.
- **a later independent launch meeting a compatible route** — resumes, and
  allocates nothing at all.

Every incomplete replay requires exact agreement between its journal and its
route on identity, provenance, instruction digest and launcher before its first
live effect. Neither account repairs or republishes the other: a replay that
found a disagreement has discovered that the session it was going to continue is
not the session it prepared, and retains `identity-unavailable` without starting
a child. Equal instructions may resume the retained identity; different
instructions retain `instructions-refused` and replace neither the layer, the
route, the identity, nor any provider state.

A session XMD named takes its instruction layer from one invocation-private
file, mode `0600`, passed by path. The text appears in neither argv nor
environment, and the file and its directory are removed on success, ordinary
failure and cancellation alike, while coordinator ownership is still held.
Every private setup or child-creation failure is normalized before it crosses a
public or durable boundary: the retained class is `process-creation-failed` and
the message is fixed provider-owned text carrying no executable path,
instruction-file path, argv, environment, raw host message, credential or
provider-private state.

The provider does not write these records and cannot reach the thing that does.
It offers each phase as live work to the authority core delivered it; the
authority runs a phase only when the journal has none, retains what comes back
before the next live effect, and cross-checks the preparation against the exact
request that was routed — instructions and digest, agent, requested session,
cwd, directories, permission mode, and requested model. A record that changed
what was asked would make the journal describe a launch nobody authored, so it
is refused rather than retained.

That is the authority boundary. Middleware composed around the Agent Api may
observe a launch or refuse one; it cannot author a phase, and a completion it
returns settles nothing, because the route ignores returns and the result is
derived from the retained records alone.

At minimum the records retain:

```text
document target and component source
logical session key
provider and agent identity
provider-native session identity
created or resumed
instruction reconciliation outcome
prepared instructions and digest
instruction channel selected by the provider
primary cwd and ordered additional directories
requested and effective model, when reported
permission configuration
launch phase
native launcher identity
exit code or signal
```

Prepared instructions pass through the existing secret-detection gate before
persistence. Provider credentials, raw settings, environment, executable path,
and unfiltered CLI arguments do not enter the record.

A completed replay restores the terminal outcome and contacts no provider,
coordinator, terminal, or process. A partial replay reserves the terminal,
acquires session ownership, verifies the retained request against the live one,
reuses the recorded native session, and continues at the first incomplete phase. A partial replay whose native process
was interrupted reattaches the native UI to that same session; it never creates
a replacement or reconstructs state from a transcript.

XMD does not journal turns performed inside the native UI. The provider-native
session is authoritative for those turns, tool state, summaries, and transcript
history. The XMD journal remains authoritative for deterministic preparation,
the handoff identity, and whether the launch completed.

## Failure boundaries

Preparation failure creates or launches nothing on behalf of
`Session.Launch`. Provider availability already resolved by an enclosing
`Agent` remains an ordinary earlier effect.

Failure to configure instructions or directories leaves ownership with ACP and
does not spawn the native UI. Missing native-launch capability fails before
detach. Detach failure also prevents spawn.

Changing instructions on a retained session fails with `instructions-refused`
whenever the provider cannot replace the layer in place while preserving
identity and history. Nothing is discarded to make room for a layer, and an
empty cached transcript authorizes nothing: a session established eagerly by an
enclosing `<Session>` is refused by a launch carrying a different layer, exactly
as a session a native UI has been in is.

A launch that cannot take ownership retains `session-busy` or
`session-recovery-required` as its preparation and stops there. Both are
retained rather than raised bare, so a replay resumes from the phase that
actually happened, and both refuse before ACP ensure, detach, or spawn.

If detach succeeds but process creation fails, the durable provider session
remains the authoritative retained state. The launch fails and a later replay
uses that same identity.

If the native UI mutates its session and then exits unsuccessfully, both facts
remain true: the document fails and the provider session retains what happened.
XMD neither rolls back provider history nor substitutes its own account of it.

Provider teardown skips a handle already transferred to the native child. It
still attempts every unrelated cleanup. After the child exits, the provider
marks its old ACP handle stale so later Agent operations must reattach rather
than use a connection that predates native ownership.

## CLI and discovery

The existing target grammar is the complete role-selection UX:

```sh
xmd AGENTS.md --help
xmd AGENTS.md#Implementor --default-agent claude
xmd AGENTS.md#Implementor --default-agent codex
```

Help lists static role headings and their first static paragraph without
installing an Agent provider or testing native launch support.

The ordinary CLI host requires a terminal for `Session.Launch`. It refuses a
non-TTY invocation before the launch resolves an agent, so a piped run learns
it cannot launch without probing for an installed CLI first. Test and embedding
hosts can install a controlled launcher that needs no terminal; a host that
installs none — `xmd test`, document inspection, an embedder — refuses every
launch, which is what keeps help and inspection free of any of this.

`<TestAgent>` installs a controlled launcher for its own body, because a
scripted agent's native UI does not exist and the terminal a host would hand it
belongs to whoever is running the tests. That is what lets an authored
`<Session.Launch>` run under `xmd test`, where the host installs none, and it
means a launch under `<TestAgent>` never reaches the host's launcher.

Only the Deno and compiled hosts pass a session coordinator into the providers
they build. Node and Bun pass none and fail closed, as *Ownership and
concurrency* describes.

Provider, agent, and model remain runtime bindings. The target and logical
session name remain role and continuity identities. A document can explicitly
name an Agent where required, but no provider-specific executable or resume
syntax appears in `AGENTS.md`.

## Testing

The test-agent stack supplies deterministic provider state. A controlled native
launcher records the request, claims a known provider-native session ID, waits
on a test-controlled operation, and exits with a selected status. It never
starts Claude, Codex, or a model.

Focused tests prove:

1. help discovers roles and performs no preparation or launch;
2. selecting one role excludes sibling preparation;
3. rendered instructions exactly match the selected files and computations;
4. no Agent prompt occurs during preparation or launch;
5. directory, model, and permission configuration reaches the provider exactly;
6. a provider without native-launch capability fails before detach;
7. ACP release completes before the native child starts;
8. the native child receives only the provider-asserted native session ID;
9. raw instructions are absent from argv and environment;
10. the document remains suspended until controlled child exit;
11. cancellation proves the child can no longer execute or hold the terminal
    before cleanup completes, without treating a defunct PID as live;
12. a later Prompt reattaches ACP to the same provider session;
13. full replay launches no process;
14. partial replay resumes the same incomplete launch identity; and
15. concurrent launches cannot share one logical session or foreground
    terminal; and
16. instruction reconciliation installs a layer on a session the launch
    constructs, resumes an equal one, and refuses a changed one — including on a
    session established eagerly and never used, and with no discard on any
    path; and
17. ownership covers session, prompt, launch and incomplete replay under one
    natural key, contention refuses instead of queueing, a crashed owner leaves
    a recovery tombstone, and a host with no coordinator refuses before
    contacting an agent.

The authored half of this is one executable Markdown document,
`packages/test-agent/src/NativeSessionLaunch.test.md`, run whole. It authors the
launch, the prompt that proves no turn was spent, and the eager-`<Session>`
refusal directly — a `<Session.Launch>` written as `<Session.Launch>`, not
assembled from a TypeScript string. `<Session.Launch>` raises a launch failure
as an error segment whose cause carries `phase` and `failureClass`, so an
`<AssertThrows as="…">` binding can assert which refusal it was rather than the
wording of a message. TypeScript owns what Markdown cannot reach: ACP wire
traffic, the authority, locks, files, processes, and the journal.

Adapter contract tests use fake `claude` and `codex` executables to verify resume
argument construction and exit propagation. They start real children through the
production launcher, so what they prove is the argument vector a native CLI
receives, the status it propagates back, and that a cancelled launch leaves no
process holding the terminal.

Separate opt-in integration tests verify that each supported adapter's
ACP-created session is actually visible to the installed native CLI and that
prepared instructions affect its first native turn. A provider is not advertised
as launch-capable until that compatibility test passes, and none is advertised
on `main`.

## What this contract covers

The feature is `Agent.launch()` and the `Session.Launch` component; the opaque
launch request its public route carries and the invocation-owned authority its
installed provider receives; the `agent_session_launch` durable records with
their replay and secret scanning; the host-owned session coordinator and its
crash-conservative ownership record; an invocation-owned native-launch
capability in the ACPX provider;
provider-native identity that is either asserted by the provider or allocated by
the adapter before the provider exists, retained explicitly and never inferred;
a strict create-once construction route beside the coordinator's own records;
an inherited-terminal foreground child with cancellation and bounded reaping;
and the controlled TestAgent fixture that proves all of it without starting a
model.

Two things it does not yet have, and both fail closed rather than degrading:

- **No adapter is advertised.** `claude` and `codex` have command shapes and
  contract tests, and neither is launch-capable until its opt-in integration
  proves the seven claims under *Provider-native identity* against the
  installed CLI. A launch naming an unadvertised agent is refused with
  `unsupported-capability` before its ACP session is released.
- **`Agent.AddDir` is unbuilt**, so a launch declares no additional roots. The
  retained request says so explicitly — an empty ordered list — rather than
  omitting the fact, and no adapter maps a root it was never given.
- **ACP does not attach to a session XMD named.** A `<Session>` or `<Prompt>`
  meeting a `client-native` route raises the provider's typed route error rather
  than reattaching, because letting ACP and a native process jointly accept one
  identity as one history requires proving they are running the same build —
  which is deferred with #517 rather than approximated here.

Additional provider adapters land independently against the same core contract.
An adapter that cannot prove instruction injection before the first user turn
stays unsupported rather than weakening `Session.Launch` semantics.

Native UI event mirroring, XMD-rendered interactive chat, simultaneous terminal
sessions, automatic nested `AGENTS.md` discovery, bootstrap model turns, and
workflow role scheduling are outside this contract.

## Structural checklist

Implementation review checks these frozen invariants:

1. Only explicitly rendered `Session.Launch` content crosses as instructions.
2. Launch performs no model turn.
3. Provider-native identity is asserted, never inferred.
4. ACP and the native UI never concurrently own one session.
5. XMD remains the supervising parent and the document stays suspended.
6. Cancellation establishes that the native child can no longer execute or own
   the terminal before document continuation or teardown completion; a lost
   runtime exit event or defunct PID does not extend live ownership.
7. Completed replay launches nothing; incomplete replay uses the same retained
   provider session.
8. Native conversation history remains provider-owned and is never
   reconstructed from XMD output.
9. Raw prepared context does not appear in process arguments or environment.
10. Unsupported providers fail before ownership transfer.
11. Native launch never widens the admitted filesystem authority.
12. A changed instruction layer never discards persistent provider state: it is
    replaced in place with identity and history preserved, or refused before
    handoff.
13. Public launch routing is request-only: no return value, copy, superseded
    parent, foreign request, or repeated delegation authors a phase, and the
    authority reaches the installed provider directly.
14. Every operation that can act on an advertised session takes ownership under
    one natural key first, contention refuses rather than queues, and an owner
    that did not prove it stopped leaves the session owned.
15. A session is constructed once, by one mechanism, and its create-once route
    says which. Routes never convert, and the loser of a race adopts the winner
    rather than replacing it.
16. A session XMD named is created by the native process under an identity the
    adapter allocated inside ownership, from a private mode-0600 file whose text
    reaches neither argv nor environment.
17. Private setup and child-creation failures are normalized before they cross a
    public or durable boundary.

Item 12 is the 2026-08-20 architecture amendment. ACPX fixes `systemPrompt` at
session creation, while native turns are not authoritative in its cached
transcript. The amendment prevents transcript absence from authorizing loss of
provider-owned history or substitution of durable session identity — which is
why V1 removed the discard branch entirely rather than restricting it.
