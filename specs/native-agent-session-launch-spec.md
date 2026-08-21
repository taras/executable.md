# Native Agent Session Launch

**Status:** Provider-neutral foundation built; client-allocated Claude binding
and advertisement unbuilt
**Related:** [Executable.md ACP Client](./acp-client-spec.md),
[Markdown Agents Vision](./markdown-agents-vision.md),
[Workflow Workspace](./workflow-workspace-spec.md),
[native session launch story](https://github.com/taras/executable.md/issues/517),
[future bootstrap prompts](https://github.com/taras/executable.md/issues/514)

## Purpose

An executable document can prepare a coding-agent session and then place the
user in that agent's native interactive UI. The document decides which context
the session receives and which filesystem roots it can use. The provider owns
the durable mapping from the logical XMD session to the native session, admits
either a provider-returned identity or an identity allocated through a proven
provider interface, and owns the command that creates or resumes it.

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
turns. A client-allocated Claude session also retains a filtered executable
build binding, so native Claude and every later ACP attachment accept its
history through the same proven build rather than through whichever executable
a provider happens to resolve later.

## Smallest example

```md
# Repository Agents

## Implementor

The implementor makes changes according to the approved plan.

<Agent>
  <Session.Launch session="implementor">
You are the repository implementor. Follow the supplied role contract,
architecture, and approved plan.

<File path=".agents/implementor.md" />
<File path="architecture.md" />
<File path=".xmd/approved-plan.md" />
  </Session.Launch>
</Agent>

## Architect

The architect reviews settled structural invariants.

<Agent>
  <Session.Launch session="architect">
You are the repository architect. Apply the supplied role contract and
authoritative architecture.

<File path=".agents/architect.md" />
<File path="architecture.md" />
  </Session.Launch>
</Agent>
```

The paragraphs outside `Session.Launch` remain documentation and rendered
output. Only the rendered body of `Session.Launch` becomes prepared agent
instructions. A file that exists in the repository is not selected merely
because the provider can read it.

The session is named on the launch rather than by an enclosing `<Session>`.
`<Session>` establishes its session eagerly, before its body expands, which is
ACP choosing how that conversation was constructed — and a session's
construction route never changes afterwards. A launch inside `<Session>` is
therefore asking to install an instruction layer on a session that already
exists, which no provider replaces, and a client-allocated launch there is
additionally asking to take over a conversation ACP created. Naming the session
on the launch is what lets the launch be the thing that establishes it.

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
- a missing or unresumable provider session fails rather than being replaced by
  transcript reconstruction; and
- durable native identity provenance and executable-build compatibility are
  provider-owned state, not authored document values.

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
  launch(
    instructions: string,
    options?: LaunchOptions,
  ): Operation<SessionLaunchResult>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}

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

`launcher` is a stable provider-assigned adapter identity such as `claude` or
`codex`, not an executable path. The result describes a successful normal exit;
nonzero exit, signal, and cancellation do not produce it. It contains only
filtered stable evidence and exposes no process handle, ACP client, credential,
raw environment, executable path, executable fingerprint, or argument vector.

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
  invoking a model; and
- otherwise the provider refuses with `instructions-refused` before detaching
  ACP ownership or starting a native process.

The ACPX provider has no in-place replacement, so every changed layer is
refused. It discards no persistent provider state to install one: an ACPX
session's transcript is empty whether or not the session was ever used, because
native turns are never mirrored back into it, so nothing available to the
provider distinguishes an unused shell from a conversation someone has been
having. Provider-local flags do not close that gap either — a record restored
from an earlier run reports no turns in the scope that reopened it.

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

Providers branch before ownership transfer:

- a provider-returned path prepares through ACP, accepts only the native
  identity the provider explicitly returns for the session it created, then
  detaches that ACP owner; and
- the client-allocated Claude path takes exclusive live ownership of the logical
  session, resolves and validates a live executable, allocates a UUID, publishes
  the client-native construction route, commits preparation, establishes that no
  ACP owner exists, then starts the exact executable with `--session-id` and a
  restrictive `--system-prompt-file`.

The client-allocated path is native-first. It does not create an ACP session to
obtain identity. A materialized session with equal instructions uses
`--resume`; later Agent work revalidates the retained executable binding and
attaches through ACPX with the same UUID as `resumeSessionId`.

## Construction route

A logical session is constructed once, one way, and never converts. The route
is durable state keyed by provider, resolved agent and resolved logical session
key, with two variants:

- `acp-first` — ACP owns construction. It carries no identity, binding,
  instruction layer or process state, because ACP-first construction has none
  of those to describe until it creates the session.
- `client-native` — XMD allocated the identity and a native UI created the
  conversation. It carries that UUID, `client-allocated` provenance, the
  instruction digest, the launcher, and the filtered executable binding.

The route is the cross-runtime construction fence, and it is claimed before
anything is established:

- `session()`, a first ACP prompt, and a provider-returned launch publish or
  adopt `acp-first` before any unbound `ensureSession()`;
- a fresh client-allocated launch publishes or adopts `client-native` before any
  provider session or native process exists;
- an ACP operation that observes `client-native` uses that exact retained UUID
  and executable binding, and never creates an unbound ACP session;
- a client-allocated launch that observes `acp-first` reports
  `identity-unavailable`; and
- malformed, unknown or conflicting route state refuses without replacement.

Publication is atomic and create-once: the first publication wins, an exact
retry adopts it, and every other candidate learns what it lost to. Concurrent
client-native candidates that agree on provider, agent, session, instruction
digest, launcher and build adopt the one published UUID; candidates that
disagree refuse, and no losing candidate publishes a second identity.

An `acp-first` claim stays ACP-first even when the first ensure fails or the
provider's own record later disappears. This is deliberately conservative: XMD
cannot prove that provider history was never materialized, so changing paths
under one logical name is not recovery. The reader names a different session
instead.

A `client-native` route authorizes resume only. It never authorizes ACP to
materialize a missing provider session under the retained UUID: an attachment
that cannot load that conversation refuses before a turn rather than creating a
replacement under the same name.

## Live ownership lease

The route decides which construction a session took. The lease decides who may
act on it now. A native coding-agent UI and an ACP turn are both live owners,
and neither can observe the other from its own side.

The lease is a contextual host capability with three answers: acquired for the
asking scope, busy because another owner holds it, or unavailable because this
host installs no implementation and therefore cannot answer the question at all.
Its key is a digest of the session's natural key, so the coordination namespace
holds no agent name, session name, path or authored value.

The Deno source entrypoint and the compiled binary install one implementation: a
non-blocking exclusive advisory lock on a deterministic empty sidecar beneath
the coordinator namespace, taken with the asynchronous `Deno.FsFile.tryLock`
operation. The file is opened for the lease scope and never unlinked — deleting
it would let a second process create a fresh file and lock that instead. Scope
teardown unlocks and closes it, and process death makes the kernel release it.

Node and Bun expose no core cross-process advisory file lock, and V1 emulates
none: a pid, timestamp, heartbeat or stale-file timeout calls a paused or reused
process stale and admits two owners. So those hosts keep every `acp-first` path
exactly as it is, and refuse a fresh native launch and an ACP attachment to a
retained `client-native` route with `unsupported-capability`, before any
provider work.

Acquisition never waits. A native UI can stay open for hours, and a queued run
would hold the reader's terminal while offering no way to reach the owner it
waits for. A contender records `session-busy`, changes no route, and performs no
ensure, detach, spawn or turn; running the same command again after that owner
exits succeeds. Provider-local FIFO queues remain what they were — ordering
helpers inside one provider, and not ownership authority.

The lease is held until the work it protects can no longer act:

- a native launch holds it from route reconciliation and preparation through
  child settlement, terminal recovery, instruction-file cleanup and
  cancellation — not merely until a cancellation signal is sent; and
- a bound ACP attachment holds it from route reconciliation through ensure, the
  whole turn, cancellation, permission cleanup and session cleanup.

Ownership order in one run is terminal first. `Session.Launch` renders its body,
reserves the run's foreground terminal and flushes output before it asks the
provider for anything, so a second launch contending for the terminal in one run
refuses there and performs no provider work at all. Only after terminal
admission does client-native provider work try the session lease, once.

## Native identity provenance and executable binding

Three identities remain distinct:

```text
logical XMD session key
ACPX record/session identity
provider-native session identity
```

Only an identity admitted by a proven provider adapter can cross the handoff
boundary. Its retained provenance is one of:

- `provider-returned`: the provider explicitly returns the identity of the
  session it created; or
- `client-allocated`: the adapter allocates an identity with its declared
  provider-specific allocator and supplies it through a supported
  session-creation input.

Client allocation admits no document or user supplied identifier. The adapter
validates the value against its declared identity schema and passes it unchanged
to native creation, native resume, and ACP reattachment. XMD never infers or
translates an ACP ID, ACPX record ID, UUID-looking string, CLI output, or
authored value into native identity.

For Claude V1, exact executable-build alignment is part of continuity for a
client-allocated session. Its filtered durable binding is:

```ts
interface ExecutableBuildBindingV1 {
  schema: "executable-build.v1";
  reportedVersion: string;
  executableDigest: {
    algorithm: "sha256";
    value: string;
  };
}
```

`reportedVersion` is the adapter's canonical parse of the exact executable's
supported `--version` output. The digest covers the bytes of its canonical
regular-file target. Equality requires the same schema, canonical version,
algorithm, and digest. Version equality alone and path equality alone are both
insufficient.

The executable path is an invocation-scoped live capability, not durable
identity. No absolute or relative path enters the launch journal, Agent-session
mapping, output, or public result. Raw version output, environment, and argv
remain non-durable. Moving an unchanged build is compatible; replacing the
bytes at an unchanged path is not. An adapter whose effective build includes
mutable external assets defines and proves a stronger provider-specific binding
before advertisement.

A native-launch-capable provider proves all of the following:

1. its admitted identity names durable state the native UI can resume;
2. identity provenance and, where required, executable binding are retained;
3. prepared instructions are effective on the first native user turn without a
   bootstrap model turn;
4. cwd, additional directories, model, and permissions survive the handoff;
5. the ACP owner can release the session before native attachment;
6. the native process can exit without deleting the resumable session; and
7. ACP can later reattach to the same session if document execution uses it
   again.

For the built-in adapters, the native commands are:

```text
claude --session-id <native-session-id> --system-prompt-file <private-file>
claude --resume <native-session-id>
codex resume <native-session-id>
```

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
9. The provider reads the durable construction route. A client-allocated launch
   that finds `acp-first` refuses `identity-unavailable` here, before anything
   is mapped, detached or spawned.
10. A client-allocated launch takes exclusive live ownership of the logical
    session, once and without waiting. A host that installs no lease refuses
    `unsupported-capability`; another owner makes it refuse `session-busy`.
    Ownership is held for the rest of the launch.
11. The provider selects its proven identity path. A provider-returned path
    claims `acp-first` and prepares through ACP. Client-allocated Claude
    resolves one canonical executable regular file, parses its version, hashes
    its bytes, and either adopts an exactly matching `client-native` route or
    allocates one UUID and publishes the route by natural key.
12. The provider applies the instruction layer and directory configuration. A
    fresh client-allocated Claude launch stages the instructions in an
    invocation-private restrictive file; a retained equal layer resumes without
    installing another copy.
13. XMD commits the prepared launch record, including identity provenance and
    any executable binding, before ownership transfer.
14. The provider establishes that no ACP owner exists. It releases a
    provider-returned ACP session it holds — releasing only, never discarding
    persistent provider state — and XMD commits `detached`.
15. The provider spawns the exact live executable as a foreground child. Fresh
    client-allocated Claude receives `--session-id` and the private instruction
    file; a retained or possibly interrupted session receives `--resume`.
16. `Session.Launch` suspends while the child runs and removes the private file
    during settlement.
17. The child handles prompts, tools, permission dialogs, rendering, and native
    transcript persistence directly.
18. When the child exits, XMD records its terminal outcome and releases the
    terminal lease and then the session lease.
19. Later Agent work takes the session lease, revalidates the retained
    executable build, selects or creates the runtime partition for that binding,
    and lazily reattaches ACP to the retained provider session with
    `resumeSessionId`.
20. Document execution continues after `Session.Launch`.

An enclosing `<Agent>` or `<Session>` resolves by its own contract, before
anything inside it runs, so a document that wraps a launch has already reached
its provider by step 6. That is an ordinary earlier effect: what step 6 stands
in front of is the launch, and no session ownership transfers before it. An
enclosing `<Session>` has also already claimed `acp-first` for that session,
which is why a client-allocated launch inside one refuses at step 9.

XMD spawns and waits; it does not replace itself with `exec`. Remaining the
parent preserves document cancellation, child-liveness settlement, exit-status
ownership, and continuation after the UI closes.

Executable resolution and validation happen before any provider-facing process
for that session starts and under a trusted host namespace stable through child
creation. Availability probes for a bound capability use that same live
binding. A host that cannot preserve the validated target through spawn refuses
rather than claiming exact-build continuity.

## Ownership and concurrency

One session has one active owner. Its states are:

```text
ACP-owned -> detaching -> native-UI-owned -> detached -> ACP-owned
```

The transition to native ownership occurs only after ACP release completes. The
provider never runs ACP prompts against a native-owned session.

Two mechanisms serialize that, and they are not the same thing. The provider's
own FIFO queue orders work inside one provider scope, and a launch holds its
session's queue slot until the native child exits. The host-supplied session
lease is what decides ownership between processes and between provider scopes
that share a coordination namespace; it is described above, and a provider-local
queue is never a substitute for it.

ACP runtimes are partitioned by agent command and retained executable build
binding. Every operation on a bound session routes to the runtime created for
that binding. Different bindings cannot share an adapter child; a stale handle
after native ownership never falls back to an unbound registry or default
runtime. Sessions with an equal binding may share only where the provider's
ordinary ownership and serialization rules permit it.

The live canonical path is passed directly to native launch and only as
`CLAUDE_CODE_EXECUTABLE` in the environment of the matching ACP adapter child.
Production code neither mutates nor consults process-global environment to
route a session. Creating or recreating an adapter child revalidates the build;
an already validated live child is not rehashed before every turn.

V1 also holds one foreground-terminal lease for the root CLI execution. Two
native launches cannot concurrently own the same terminal, even when they name
different sessions, and the second refuses at that lease before it asks the
provider for anything. Sequential launches are ordinary document composition.

Cancellation interrupts the native foreground process, establishes that it can
no longer execute or hold the terminal, restores terminal state, and runs every
provider finalizer. The session lease is released after all of that, never on
the strength of having sent a signal; the durable route it published survives,
and a later explicit invocation resumes under it. A process that ignores the initial interruption is
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

The provider does not write these records. It hands each phase's work to the
journal the invocation lends it, so a replay of that phase returns the retained
record and never runs the work again. That is also the authority boundary:
middleware composed around the Agent Api may observe a launch or refuse one,
but a `SessionLaunchResult` that arrives without those retained phases
describes a launch that did not happen, and is refused.

At minimum the records retain:

```text
document target and component source
logical session key
provider and agent identity
provider-native session identity
native identity provenance
filtered executable build binding, when required
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

A client-allocated session retains the same filtered provenance and executable
binding in two durable accounts: the `client-native` construction route keyed by
the logical session, and the launch invocation's `prepared` record. When both
exist, provider, agent, logical session, native identity, provenance,
instruction digest, launcher, and binding agree exactly. Missing, malformed,
unknown-schema, or conflicting state is refused; neither account repairs or
overrides the other.

Route publication and journal publication can straddle two durability systems,
so preparation reconciles by natural key. An exact XMD-owned route is adopted,
an absent route is published once, and a conflicting route is refused. A retry
after an interrupted append never allocates a replacement native identity. This
pre-release record shape is recognized strictly in place: a client-allocated
Claude record without provenance or binding is incomplete and has no inference
or migration reader.

The pre-amendment `native-session-mapping.v1` record is recognized as the
`client-native` route it always described. Recognized, not migrated: a reader
that rewrote it would be writing state it does not own, on behalf of a process
that may be doing the same thing at the same moment. Because that record was
written before routes existed, whatever the provider retained beside it was
never reconciled against this identity, so it is accepted only when the
provider's own session record names exactly the retained native identity.
Anything else is ambiguous, and ambiguous state refuses before ensure, detach,
spawn, turn or deletion — it is never repaired by deleting one of the two
accounts. Unknown route schemas refuse. V1 has no automatic route migration,
identity migration, executable rebind, or instruction-layer replacement.

A completed replay restores the terminal outcome and never resolves an
executable, reads a path, invokes `--version`, hashes a file, takes a session
lease, starts a provider, or launches a native UI. An incomplete launch takes
exclusive live ownership before it reconciles its retained preparation against
the route, and holds it for the rest of the attempt; a host that installs no
lease refuses before provider work. Before an incomplete launch starts any
native or ACP process, the provider resolves a live executable and requires
exact binding equality.

If `prepared` is the last retained phase, native spawn could not yet have
occurred and the retained client allocation may continue. If `detached` is the
last phase, native spawn may have occurred, so continuation uses `--resume` and
never reissues creation. An explicit no-session outcome fails closed; ambiguity
never authorizes replacement. Later ACP work supplies the retained UUID as
`resumeSessionId` only after the same validation.

An unchanged version and digest found at a different path is accepted. A
different version with equal digest, equal version with different digest, no
matching executable, an observation failure, and an unknown binding schema are
refused. V1 performs no automatic executable upgrade. Rebinding an existing
session requires a future explicit provider migration contract that proves
history compatibility and durably records the transition before the new build
accepts history.

XMD does not journal turns performed inside the native UI. The provider-native
session is authoritative for those turns, tool state, summaries, and transcript
history. The XMD journal remains authoritative for deterministic preparation,
the handoff identity, and whether the launch completed.

## Failure boundaries

Preparation failure creates or launches nothing on behalf of
`Session.Launch`. Provider availability already resolved by an enclosing
`Agent` remains an ordinary earlier effect.

Executable resolution, canonicalization, regular-file validation, version
parsing, hashing, and binding equality fail as
`executable-binding-refused` in phase `prepared`. The refusal occurs before ACP
detach, native spawn, ACP `ensureSession`, or ACP history acceptance. A partial
replay keeps its retained prepared record; a current live-binding refusal does
not append a detach or exit record.

A later `Prompt` reports the same stable provider cause before ACP session
creation or turn start. Diagnostics may name the launcher, expected and
observed canonical versions, and mismatch category, but never an executable
path, raw version output, environment, argv, credentials, or provider-private
state. There is no fallback to PATH, the adapter's SDK-bundled executable, an
unbound runtime, transcript reconstruction, or a successful empty continuation.

Failure to configure instructions or directories leaves ownership with ACP and
does not spawn the native UI. Missing native-launch capability fails before
detach. Detach failure also prevents spawn.

Changing instructions on a retained session fails with `instructions-refused`
when the provider cannot replace the layer in place while preserving identity
and history. The ACPX provider never discards persistent provider state to
install a layer, so every changed layer is refused there.

Asking a client-allocated launch to take over a session ACP constructed fails
with `identity-unavailable`, as does malformed, conflicting or ambiguous route
state. Contention for live ownership fails with `session-busy`, which is not
breakage: another owner holds the session, the route is unchanged, and running
the command again after that owner exits succeeds. A host that installs no
lease fails with `unsupported-capability`.

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
    terminal, and the launch that loses the terminal in one run performs no
    provider work at all;
16. instruction reconciliation resumes an equal layer and refuses a changed one,
    and no launch or reconciliation path discards persistent provider state,
    whatever the cached transcript says;
17. provider-returned and client-allocated identities retain distinct admitted
    provenance, and authored, ACP, and ACPX identities are refused;
18. version or digest mismatch, a missing executable, malformed or unknown
    bindings, and conflicting mapping/journal accounts refuse before ownership
    transfer or provider process creation;
19. the same build relocated to another path is accepted, while completed
    replay performs no executable observation;
20. retry adopts an exact natural-key mapping and never allocates a replacement
    after interrupted journal publication;
21. two concurrent build bindings use distinct adapter children and leak no
    path or environment across sessions; and
22. a stale handle reattaches through the runtime selected by its retained
    binding and passes the native UUID as `resumeSessionId`;
23. route publication is create-once across two provider scopes sharing one
    namespace: with ACP-first winning a barrier-decided race the native launch
    refuses and nothing is discarded, and with client-native winning it,
    concurrent ACP work refuses `session-busy` without establishing an unbound
    session, while a later explicit retry attaches with the exact retained UUID;
24. a client-native route is resume-only, so provider state that cannot be
    loaded refuses before a turn instead of being recreated;
25. a cancelled or failed launch releases live ownership only after its child
    and cleanup settle, and the route it published survives;
26. a pre-amendment record whose provider session names a different conversation
    refuses before ensure, detach, spawn, turn or deletion; and
27. Deno takes a real kernel advisory lock that two processes contend for and a
    killed owner releases, while Node and Bun keep every ACP-first path and
    refuse a fresh native launch and a retained client-native attachment before
    provider work.

Adapter contract tests use fake `claude` and `codex` executables to verify resume
argument construction and exit propagation. They start real children through the
production launcher, so what they prove is the argument vector a native CLI
receives, the status it propagates back, and that a cancelled launch leaves no
process holding the terminal.

The authored `Session.Launch` and role journey are executable Markdown tests.
TypeScript remains at provider-store, ACP transport, runtime-environment,
executable-resolution, PTY, and process boundaries the document cannot observe.

Separate opt-in integration tests verify that each supported adapter's admitted
identity and history cross native creation, native resume, and later ACP
reattachment through one installed executable build, and that prepared
instructions affect the first native turn. A provider is not advertised as
launch-capable until that compatibility test passes, and none is advertised on
the #519 branch.

## What this contract covers

The feature is `Agent.launch()` and the `Session.Launch` component; the
`agent_session_launch` durable records with their replay and secret scanning;
an invocation-owned native-launch capability in the ACPX provider;
provider-native identity taken from what an adapter asserts and never inferred;
an inherited-terminal foreground child with cancellation and bounded reaping;
and the controlled TestAgent fixture that proves all of it without starting a
model. It also covers client-allocated identity, the durable construction route
that decides which path a logical session took, the host-supplied lease that
decides who may act on it now, filtered executable binding in that route and the
launch journal, and fail-closed native and ACP continuation through the matching
live build.

Two things it does not yet have, and both fail closed rather than degrading:

- **No adapter is advertised.** `claude` and `codex` have command shapes and
  contract tests, and neither is launch-capable until its opt-in integration
  proves the claims under *Native identity provenance and executable binding*
  against the installed CLI. A launch naming an unadvertised agent is refused
  with `unsupported-capability` before its ACP session is released.
- **`Agent.AddDir` is unbuilt**, so a launch declares no additional roots. The
  retained request says so explicitly — an empty ordered list — rather than
  omitting the fact, and no adapter maps a root it was never given.

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
12. A changed instruction layer never discards retained or unobserved native
    history: it is replaced in place with identity and history preserved, or
    refused before handoff.
13. Client allocation is provider-owned and schema-validated; no authored,
    ACP, ACPX, or CLI-observed identity substitutes for it.
14. Native creation, native resume, and ACP reattachment accept a
    client-allocated Claude history only through the exact retained executable
    version and digest.
15. The filtered binding and provenance agree across the construction route and
    launch journal, while path, raw environment, and argv remain live and
    non-durable.
16. Bound ACP runtimes are partitioned without process-global environment or
    cross-session leakage.
17. A missing, changed, malformed, or unknown build refuses before detach,
    spawn, ACP ensure, or history acceptance; completed replay observes no live
    executable.
18. One logical session has one construction route, claimed atomically before
    anything is established on it and never converted. A client-allocated launch
    that finds `acp-first` refuses; an ACP operation that finds `client-native`
    resumes the retained identity and never creates under it.
19. Live ownership of a client-native session comes from a host-supplied
    kernel-released lease, never from a provider-local flag, queue, pid file,
    heartbeat or stale-file timeout. A host that installs none refuses.
20. Acquisition is non-blocking and terminal-first: a contender records
    `session-busy` without changing the route or reaching a provider, and a
    launch that loses the run's terminal never reaches a provider at all.
21. The lease is released only after the work it protects can no longer act, and
    the durable route survives cancellation, failure and process death.
22. No launch or instruction-reconciliation path discards persistent provider
    state, and ambiguous pre-amendment state refuses rather than being repaired
    by deleting one of its two accounts.

Item 12 is the 2026-08-20 architecture amendment. ACPX fixes `systemPrompt` at
session creation, while native turns are not authoritative in its cached
transcript. The amendment prevents transcript absence from authorizing loss of
provider-owned history or substitution of durable session identity.

Items 13-17 are the 2026-08-21 executable-binding amendment. A reproduced
Claude 2.1.235/2.1.232 split accepted the UUID and completed an ACP turn while
losing native history; exact build alignment recovered it. The binding is
therefore retained compatibility identity, while its host path remains a live
capability.

Items 18-22 are the 2026-08-21 native-session concurrency amendment. Reading a
store and then establishing a session are two steps, and a sibling provider can
create and prompt the session in between — so nothing observed after the fact
distinguishes a shell this provider made from a conversation someone else is
having. The route moves that decision to an atomic publication before anything
exists, and the lease moves live ownership to the kernel, which is the one
authority a paused or crashed process cannot misreport.
