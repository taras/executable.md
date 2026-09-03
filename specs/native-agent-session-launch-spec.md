# Native Agent Session Launch

**Status:** Built
**Related:** [Executable.md ACP Client](./acp-client-spec.md),
[Markdown Agents Vision](./markdown-agents-vision.md),
[Workflow Workspace](./workflow-workspace-spec.md),
[native session launch story](https://github.com/taras/executable.md/issues/517),
[future bootstrap prompts](https://github.com/taras/executable.md/issues/514)

## Purpose

An executable document can prepare a coding-agent session and then place the
user in that agent's native interactive UI. The document decides which rendered
context the session receives; the host's Agent context determines its filesystem
authority. The provider owns the mapping from the logical XMD session to the
durable native session and the command that resumes it.

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

A session constructed that way is still a conversation, and a document can join
it afterwards. A `<Session>` or `<Prompt>` naming one attaches through ACP under
the identity the route already carries, so the same named session continues
where the native UI left off. Attachment is never conversion: the route stays
`client-native`, the coordinator remains the single live authority, and the
provider's own history remains authoritative for what was said.

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

`Agent` keeps provider selection separate from role identity. With no authored
agent name, the current/default-agent rule in the ACP Client specification
selects Claude Code, Codex, or another compatible agent without changing what
`Implementor` means.

## Existing semantics

The feature reuses these contracts unchanged:

- a static heading target is the role entry point, and sibling targets do not
  execute;
- document help discovers targets without executing authored effects;
- ordinary XMD components gather, parse, and transform preparation inputs;
- `Agent` selects the coding agent lexically, and is the availability boundary
  for what it wraps;
- `Session` identifies stateful continuity lexically;
- under ordinary `xmd run` ACPX placement, the contextual cwd participates in
  the resolved logical session key;
- the Agent provider belongs to `DocumentExecution` and finishes teardown before
  the document completes;
- completed durable effects restore without contacting their external provider;
  and
- a missing or unresumable provider session fails rather than being replaced by
  transcript reconstruction.

No behavior depends on the filename `AGENTS.md`. Any executable document target
can launch a prepared native session.

## The launch operation

The ACP Client specification owns the complete five-operation `AgentApi`, the
caller-facing `launchAgentSession(instructions, options)` operation, and the
shared `LaunchOptions` and `SessionLaunchResult` types. Native launch adds no
second Agent or Session hierarchy. Its launch-specific routed request is:

```ts
interface AgentLaunchRequest {
  readonly instructions: string;
  readonly agent: Agent;
  readonly session?: string | Session;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly permissionMode: PermissionMode;
  with(changes: {
    instructions?: string;
    agent?: Agent;
    session?: string | Session;
  }): AgentLaunchRequest;
}
```

`launchAgentSession(instructions, options)` is the canonical operation and the
only owner of what a launch settles on: it reserves the terminal, normalizes
the request, mints its durable identity, retains every phase, and derives the
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

`launchAgentSession()` is distinct from `prompt()`:

- `prompt()` performs one model turn through ACP and returns the agent response;
- `launchAgentSession()` performs no model turn, transfers the session to a
  native UI, and returns only after that UI exits.

The base `Agent.launch(request)` routing handler fails. A provider must install
the route explicitly; availability of `agent()`, `session()`, and `prompt()`
does not imply native-launch support.

`Session.Launch` renders its body before invoking `launchAgentSession()`. An
empty body is valid and prepares no additional instructions. Its optional
`agent` and `session` props mirror `Prompt`; omitted props use lexical `Agent`
and `Session` configuration. Omitting the `name` prop from an enclosing
`<Agent>` uses the current/default-agent rule from the ACP Client specification;
launch defines no default of its own.

## Prepared session request

Core hands the provider a normalized request containing:

```text
agent
logical session
prepared instructions
primary cwd
ordered additional directories (the empty list in V1)
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

The prepared text and filesystem authority are different capabilities:

- the contextual cwd determines what the V1 native agent can access;
- prepared instructions determine text supplied to the model as instructions;
- neither one implies the other; and
- unreferenced repository files are not injected as text.

`Agent.AddDir` is not an existing semantic this launch consumes. The ACP Client
specification defines the current contract: no directory-registration component
exists, and every V1 launch carries the explicit empty ordered
`additionalDirectories` list. A later directory feature is a prerequisite to
launching with another root and must define ordering and access modes before an
adapter can map one. Until then the launcher neither receives nor grants one.

The stateful Agent/Session surface likewise defines no V1 model-selection prop
or launch option. Native launch uses the provider session's model configuration
and does not create a launch-only model selector. A provider-reported current
model may be retained as observational evidence; it is not a request and does
not participate in launch identity or authority.

Raw prepared instructions never appear in process arguments or environment
variables. A provider uses its session API or an invocation-private file with
restrictive permissions and removes any temporary during cleanup.

## Provider-native identity

Four identities remain distinct:

```text
logical XMD session key             which session was requested
construction route                  how it was first constructed
provider-native session identity    which provider conversation exists
ACPX record/session identity        how the ACP client arranges attachment
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

What an adapter must prove before it is advertised follows its identity
provenance, because the two constructions make different claims.

A **provider-returned** adapter proves all seven of the following:

1. session creation materializes durable state the native UI can resume;
2. its returned native ID names that exact state;
3. prepared instructions are effective on the first native user turn without a
   bootstrap model turn;
4. cwd and permissions survive the handoff without being widened;
5. the ACP owner can release the session before native attachment;
6. the native process can exit without deleting the resumable session; and
7. ACP can later reattach to the same session if document execution uses it
   again.

A **client-allocated** adapter proves less, because it asks less: no ACP session
is created, so there is nothing for ACP and a native process to agree about, and
claims 1, 2, 5 and 7 are about a handoff it does not make. It creates the
session directly and resumes it by the same name, and what it proves is exactly
that:

1. the launch that *creates* the session has its identity allocated by the
   adapter, inside ownership and before any process exists, and nothing else
   supplies or replaces it;
2. the native process creates that exact conversation from a private
   mode-`0600` instruction file, with the text in neither argv nor environment;
3. those prepared instructions are effective on the first native user turn,
   with no bootstrap model turn in front of them;
4. a later independent invocation resumes the same identity and reaches the
   history the first one made, allocating nothing and never falling back to
   creating;
5. a session left without a conversation turn behaves the same way — the same
   identity comes back, or the provider refuses that exact identity and XMD
   fails closed;
6. every process the launch started is gone when it ends, and so is the private
   instruction file and the directory holding it; and
7. no path substitutes an identity, converts a construction route, or creates a
   replacement conversation.

Claim 6 is about what a launch is not allowed to outlive, and it is deliberately
narrow. The construction route and the `agent_session_launch` records **stay**:
they are how the next invocation knows which conversation this session is, and
removing them is what claim 4 forbids. A proof that removes them is cleaning up
after *itself*, which is a different act — see *Testing*.

Both lists are proven against an installed CLI and neither is proven by
inspection. An adapter proves the list its provenance names, and nothing is
advertised on the strength of the other one.

For the built-in adapters, the native commands are:

```text
claude --session-id <native-session-id> --system-prompt-file <private-file>
claude --resume <native-session-id>
codex resume <native-session-id>
```

### Executable build binding

A client-allocated identity means one thing only while the build that accepted
it can be recognized later. Two builds of one provider accept the same identity
and disagree silently about what it names, so a new client-allocated session
retains which build accepted it:

```ts
interface ExecutableBuildBindingV1 {
  readonly schema: "executable-build.v1";
  readonly reportedVersion: string;
  readonly executableDigest: { readonly algorithm: "sha256"; readonly value: string };
}
```

Every member is exact, and equality requires all of them to agree. The digest is
the lowercase SHA-256 of the canonical executable target; `reportedVersion` is
the adapter's canonical parse of what that exact target reports. That parse
accepts exactly one canonical line: output naming no build is unrecognized, and
output naming several is a list of builds rather than an answer — taking the
first would be choosing one, which is the question a binding exists to settle.
Neither is repeated in a diagnostic. A matching build
reached at another path is the same build; a changed build at the same path is
not. A path is never a member: it says where a build was, which stops being
true, and it names host layout besides.

The host supplies an executable observer directly to the provider, alongside the
coordinator and the route store. It resolves the launcher command through the
host's real execution environment, canonicalizes the target, requires an
executable regular file, hashes that target, and asks that same file its
version. It is deliberately not a Context, contextual Api, Agent operation,
component or middleware value: executable validation decides which retained
history may be accepted, and a resolver document middleware could replace could
point the observation at one binary while the run spawns another. A controlled
test substitutes the whole observer through the same constructor seam.

One observation yields two kinds of value:

```text
durable: the executable build binding
live:    the canonical executable path
```

The live path exists only in the operation that observed it. Native creation and
resume replace the adapter command's first argv member with it, and the matching
Claude ACP child receives it through `CLAUDE_CODE_EXECUTABLE` in a transient
child-process environment. It enters no route, journal, ACPX session option or
record, public result, diagnostic, `process.env`, or provider partition that
outlives its last handle.

A session established before any build was recorded is legacy-unbound. It keeps
exactly the native-only behavior that released it: resume works, nothing is
observed, and no binding is invented for it. It never authorizes ACP attachment
and is never upgraded in place, because a build observed today says which build
is installed now, not which one established the conversation.

### Attachment capability

Native launch and client-native ACP attachment are separate trusted-host
choices, and neither is inferred from the other or from an adapter's shape. An
adapter may be proven to hand a session to a native UI without being proven to
join that conversation afterwards.

`claude` is advertised for both. Its attachment claim was proven by
`packages/acp/src/ClaudeNativeToAcp.test.md`: one native turn planted a random
marker, a checked-in marker-free ACP `<Prompt>` recovered it under the same
identity and the same observed build, and an independent route naming an absent
identity refused before a turn without creating history in its place.

Those command shapes are adapter implementation details, not authored document
values. A custom ACP agent without a declared native launcher fails with an
unsupported-capability error before XMD releases its ACP session.

Knowing a command shape is not the same as being launch-capable. Advertisement
is separate: an adapter becomes launch-capable only once an opt-in proof runs
the claims its provenance names against the installed CLI. Until then
`<Session.Launch>` refuses that agent before anything of the session moves —
before a provider-returned adapter's ACP session is released, and before a
client-allocated adapter allocates an identity or writes a private file. That is
the failure this contract asks for rather than a hopeful spawn.

`claude` is advertised. Its client-allocated claims were proven through the
production CLI against **Claude Code 2.1.241 on macOS arm64**, which is the
compatibility point the advertisement stands on. `codex` is unadvertised: its
command shape and adapter contract tests exist, and nothing has run its
provider-returned claims against an installed Codex.

## Runtime sequence

Given `xmd AGENTS.md#Implementor`:

1. XMD resolves the selector to one exact canonical document target.
2. The CLI installs the selected Agent provider and native process launcher.
3. Target projection excludes sibling roles.
4. XMD expands the target and renders `Session.Launch` content completely.
5. File reads, captures, parsing, and deterministic evaluation finish or fail.
6. `Session.Launch` takes its applicable terminal lease. At the document root
   this is the run's foreground-terminal lease; inside `<Terminal>` it is that
   pane's lease through the pane-scoped native launcher. A host with no
   applicable terminal refuses here — before an agent is resolved, so learning
   that this invocation cannot launch anything costs no availability probe.
7. The host flushes what that terminal has pending, so the native UI does not
   open over half-written output.
8. The provider resolves the logical Agent and Session against the contextual
   cwd, and takes exclusive ownership of that session.

Steps 9 to 12 are where the two provenances part, because they are about a
session one of them constructs through ACP and the other does not.

**Provider-returned.** ACP owns the session first and has to hand it over:

9. The provider creates or resumes the durable provider session and applies the
   prepared instruction layer and contextual cwd configuration.
10. The provider verifies a native-resume capability and obtains the exact
    native session ID.
11. XMD commits the prepared launch record before releasing ownership.
12. The provider closes or detaches the ACP session and waits for that owner to
    terminate, and XMD commits that too.

**Client-allocated.** Nothing is created through ACP at all, so there is no
owner to release — what has to be settled first is which conversation this is:

9. The provider reads both durable accounts under ownership and refuses rather
   than converting: a session ACP already established, or a route that
   disagrees about the instruction layer or the launcher, ends the launch here.
10. The build is observed before an identity is made, so a build this run
    cannot name ends the launch before anything durable is written, and a route
    that already names a different build ends it with
    `executable-binding-refused`. A legacy unbound route is the exception: it
    observes nothing, resumes under the launcher name, and gains no binding.
    Whether an identity is needed at all is decided next. An existing compatible
    `client-native` route already names this conversation, so its retained
    identity is adopted and **nothing is allocated** — a second candidate for a
    conversation that already exists is a value with nowhere to go. Only where
    no route names it yet does the adapter allocate one, inside ownership and
    before any process exists; nothing else supplies or replaces it.
11. A launch that allocated publishes the bound V2 `client-native` route
    create-once, and
    what it publishes against is authoritative — whoever published first
    described the session that exists. Four outcomes, and no other:
    - this launch's own candidate won — `created`;
    - a compatible `client-native` route won — its identity is adopted, no
      replacement is allocated, and the launch is `resumed` under it;
    - an `acp-first` route won — the session already has an identity of its own,
      so the launch refuses with `identity-unavailable`, converting nothing;
    - a `client-native` route disagreeing about the instruction layer or the
      launcher won — neither account repairs the other, so the launch refuses
      the same way.
    A `created` or `resumed` record is built from the compatible winning route
    rather than from this launch's candidate, so the two accounts agree by
    construction rather than by comparison. A refusal is not: it prepared no
    identity, so it retains the failure the authoritative winner produced
    without mirroring that route's identity or provenance — no session id, and
    the weaker provenance claim, because nobody chose one. It is retained at
    `prepared` and reaches no private file, no detach and no spawn.
12. The prepared instructions are written to a private mode-`0600` file. Detach
    still happens as a phase — it is the point after which a spawn may happen —
    and succeeds trivially, because no ACP session was ever open.

From there both rejoin:

13. The provider spawns the native UI as an interactive child with the selected
    root or pane terminal inherited — resuming the native session ID for a
    provider-returned adapter, and for a client-allocated one creating it under
    the allocated identity from the private file, or resuming it by the same
    name when the route already named it.
14. `Session.Launch` suspends while the child runs.
15. The child handles prompts, tools, permission dialogs, rendering, and native
    transcript persistence directly.
16. When the child exits, XMD records its terminal outcome, removes the private
    file and its directory while ownership is still held, and releases the
    selected terminal lease. The route and the retained phases stay: they are
    what the next invocation resumes from.
17. Later Agent work depends on the route again. On an `acp-first` session it
    lazily reattaches through ACP to the same provider session. On a bound
    `client-native` route advertised for attachment, `<Session>` and `<Prompt>`
    follow *ACP attachment on a bound route* below and join the same provider
    conversation. A legacy unbound route or an unavailable attachment
    capability refuses before a turn and creates no substitute conversation.
18. Execution continues after `Session.Launch`: in root document flow outside a
    grid, or in the sequential flow of its paired pane inside one.

An enclosing `<Agent>` or `<Session>` resolves by its own contract, before
anything inside it runs, so a document that wraps a launch has already reached
its provider by step 6. That is an ordinary earlier effect: what step 6 stands
in front of is the launch, and no session ownership transfers before it.

XMD spawns and waits; it does not replace itself with `exec`. Remaining the
parent preserves document cancellation, child-liveness settlement, exit-status
ownership, and continuation after the UI closes.

### ACP attachment on a bound route

A `<Session>` or `<Prompt>` naming a session a native process constructed runs
this sequence, and every step happens while the coordinator holds the session:

1. Resolve placement without creating a runtime or probing availability, so
   nothing touches the provider session before the route has been read.
2. Acquire the same machine coordinator, non-blockingly.
3. Read and classify the route. `acp-first` follows the existing ACP path; a
   session with no route at all is constructed as `acp-first` here, which is
   what makes a nested client-native launch refuse afterwards.
4. A legacy unbound `client-native` route refuses with
   `executable-binding-refused`, and an agent this host has not advertised for
   attachment refuses with `unsupported-capability`.
5. Reobserve the executable and compare the binding exactly.
6. Inspect any retained ACP arrangement without creating one: absence may enter
   exact resume, because exact resume is the operation being attempted; a
   record must assert this route's identity and nothing else.
7. Select the live runtime for `(resolved agent command, binding)` and give the
   observed path only to that runtime's child environment.
8. Ensure with `resumeSessionId` equal to the route's identity.
9. Require the provider's canonical assertion to equal it. Absence or
   disagreement closes the handle and refuses before a turn.
10. Only then return a `Session`, or start the subscribed turn.

Runtime partitions are scope-owned. Different bindings never share an ACP child,
a managed handle remembers the partition that created it, and every turn, close,
detach, cancellation and stale-handle release goes through that same partition.
When a bound partition's last handle closes it is removed and torn down; a later
attachment reobserves and builds another.

A partition is kept exactly as long as something is standing on it, and two
different things can be: a handle nobody has closed, and work that has claimed
the runtime and not yet produced one. An ensure in flight is the second kind.
Eviction requires both to be zero — a partition removed while either is nonzero
is one a concurrent operation rebuilds, which is a second child for a build the
first is still talking to.

Electing a partition is one step. Everything that suspends — resolving the
directory an Agent runs in among it — happens first, so an operation arriving to
a map that already names its partition crosses that suspension too rather than
answering from a stale read. What follows does not suspend at all: the map is
read, an entry is published *already claimed* if this is the first work to want
one, and the ensure is started. Publishing an entry and claiming it across a
suspension would leave it in the map standing on nothing, which a sibling giving
up its own claim would evict — and the caller would then hold a runtime the map
no longer names while the next operation built a second child for the same
build.

That, and what follows, is how items 8, 10 and 14 of the structural checklist
are met rather than a further invariant beside them:

- **Claimed work that produced no handle releases its claim.** The runtime is
  built before the ensure that would use it, so a rejection would otherwise
  strand a partition holding a live path for work that never happened — and a
  binding compares a version and a digest, so the same build found somewhere
  else is the same partition key and a different file to run. Success transfers
  the claim into ownership of the handle instead, in one step: a moment where
  neither count is held is a moment another operation could evict.
- **Cancellation observes the ensure it started, and settles it before
  quiescence.** Starting an ensure is not the same as owning it: the call runs
  whether or not anybody is still waiting, so a cancellation is not the end of
  the story. The claim and the answer are settled by scope-owned cleanup rather
  than by a `catch`, which a cancellation does not run at all, and that cleanup
  is registered before the claim is taken and before the call is made — a
  cancellation delivered while the call is still on the stack is exactly the
  case where something is in flight and nobody is left to observe it. A
  cancelled operation therefore waits for the answer: a rejection releases the
  claim, and a handle is adopted, closed through the runtime that made it, and
  only then does the operation acknowledge quiescence. A close that fails there
  keeps the handle, keeps the partition, withholds quiescence and leaves both
  for teardown, exactly as a failed close does anywhere else.
- **Every handle-producing path keeps one account.** From the moment ensure
  returns — on an attachment and on a provider-returned launch alike — the
  handle belongs to this provider and is bound to its creating runtime, before
  the identity comparison, before the host is asked to retain the session, and
  before status is read. Each of those can fail, and a handle only a caller-
  facing map knows about is one teardown cannot close through the runtime that
  made it.
- **Quiescence consults that account.** A handle whose validation failed never
  became a usable session, so nothing a caller can reach names it — and it is
  still a live thing this owner started. An operation acknowledges quiescence
  only when no unreleased handle for the session remains, whether or not it ever
  became usable.
- **A settled close leaves only the session's name behind.** What a returned
  `Session` value still resolves to is placement metadata; the handle and the
  runtime that made it are gone from everything this provider can reach. A
  runtime carries the transient child environment, and therefore the canonical
  executable path, so a released session that still named one would be that path
  outliving the operation it was observed for. The next use of that value
  re-ensures, which reattaches to whatever holds the session now.
- **A close that failed released nothing.** It does not decrement the
  partition, evict it, forget the handle, detach the placement, or let the
  operation acknowledge quiescence. The refusal is still raised; what differs is that this
  scope still has something to answer for, and the handle stays reachable for
  teardown.
- **Teardown attempts every owned close**, does the release bookkeeping only
  after a close settles, and reports what it could not settle rather than
  claiming that partition finished.

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
establishing the session, subscribing a prompt stream, attaching to a session a
native process constructed, launching, and resuming an incomplete launch. Coverage follows the agent's capability, not the
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

### Terminal-grid composition

Terminal ownership and Agent-session ownership remain independent when a launch
is written inside `<Terminal>`:

```text
grid foreground lease
  ├─ pane 0 lease ─ native launch for logical session A
  ├─ pane 1 lease ─ native launch for logical session B
  └─ pane 2 lease ─ default shell

session coordinator
  ├─ natural key for logical session A
  └─ natural key for logical session B
```

The grid owns the root foreground-terminal lease. The terminal authority mints
one private one-use claim per authored pane ordinal, and core installs a native
launcher in each pane scope that closes over that claim. `Session.Launch` uses
the launcher already in scope; it receives no pane prop, token, identifier, or
mode. The launcher validates the claim through the host's direct terminal
authority and reserves that pane for the launch. A claim from another grid,
provider installation generation, pane ordinal, or completed invocation
authorizes nothing.

Different pane claims do not contend, so native launches in different panes can
hold their terminals concurrently. One pane remains exclusive: a second launch
cannot begin while the first is live there, and sequential launches work after
the first releases it. Release requires the child, its observable descendants
and process-group members, and every other holder of that pane terminal to be
gone; the pane remains busy if the launcher cannot establish those facts. A
root launch and a terminal grid contend for the root foreground lease, so
neither can overlap the other.

None of that changes the coordinator key or acquisition. Two panes naming the
same provider, agent, and logical session still ask for one natural-key owner;
one succeeds and the other receives `session-busy` without waiting. Two distinct
sessions may be owned concurrently. A terminal claim grants no permission to
ensure, detach, create, resume, prompt, or attach to an Agent session, and a
session lease grants no terminal.

The pane-scoped launcher keeps the same launch request and provider authority
division as the root launcher. Core closes it over the terminal composite and
authored pane ordinal. After the claim admits the launch and pane output is
flushed, the launcher calls the composite's required provider-neutral
`launch(ordinal, request, spawned)` operation. It does not delegate to the root
foreground launcher. The ordinal remains in that live closure and never enters
the native request.

Public middleware installed nearer the authored launch can route, wrap, refuse,
or short-circuit before delegating, but cannot settle the claim, replace the
pane, or mint a launch. Once it delegates, the pane launcher is the physical
terminal endpoint. A composite that cannot execute the request refuses rather
than falling through to the root terminal. Root `Session.Launch` retains its
existing foreground-launch route. Provider-specific grid or pane identities
never enter the `AgentLaunchRequest`, terminal result, `agent_session_launch`
record, construction route, ownership key, diagnostic, or private instruction
file.

The grid's readiness barrier observes the launch only at the existing successful
interactive-child start boundary. Session preparation, route publication,
private-file creation, and detach do not make a pane ready. If spawn fails, the
launch keeps the durable phases its contract already completed, fails the pane's
startup, and participates in the grid's atomic hidden teardown. The grid does
not roll those phases back. A child that successfully starts and exits before
the other panes become ready has nevertheless crossed readiness and retains its
ordinary exit outcome.

The pane claim carries a private one-use readiness latch. The native launcher
acknowledges it from the runtime's child-spawn event and before waiting for
exit; allocating a PID or observing output is not readiness, and a startup error
never acknowledges. A root launch carries no such latch. It is not added to
`AgentLaunchRequest`, `AgentLaunchResult`, the public Agent Api, a retained
launch phase, or a process handle, so readiness composition changes neither the
launch's authored nor durable contract.

Under the tmux provider the pane-scoped launcher sends exact argv, cwd, and
environment values over a private authenticated socket to the persistent pane
worker. The worker, not a tmux command line, creates the native child with all
three standard streams inherited from the pane terminal. It forwards the spawn
event, writes pane display without reading input, and refuses a concurrent
launch. It uses Effection's `run()` rather than `main()` so Effection does not
convert terminal `SIGINT` into worker exit 130 while the foreground child is
handling job control.

The composite's `shell()` path remains separate. It chooses the current host's
default shell as live policy; it does not accept or reinterpret a native launch
request supplied by an Agent provider.

After the grid is visible, a nonzero native exit fails its pane flow but does
not cancel sibling panes. Core keeps that failure as the pane's status and
selects the first failed pane in authored order when the reader closes the grid.
Grid-initiated close cancels a still-live launch through the ordinary launch
cancellation path, awaits session quiescence and native-child teardown, and does
not reclassify that cancellation as an independent pane failure. Parent
cancellation remains parent cancellation for the entire grid.

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

Two schemas are readable. The exact V1 record is:

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

V2 exists only for `client-native`, and adds the one fact V1 never had:

```ts
interface AgentSessionRouteV2 {
  schema: "session-route.v2";
  route: "client-native";
  provider: string;
  agent: string;
  sessionKey: string;
  nativeSessionId: string;
  identityProvenance: "client-allocated";
  instructionsDigest: string;
  launcher: string;
  executableBinding: ExecutableBuildBindingV1;
}
```

There is no V2 `acp-first`: ACP-first construction gained no fact, and a second
schema for it would be a version number with nothing behind it. New
client-native construction publishes V2 and observes the build before it
allocates an identity. Serialization preserves the schema it was given, so
nothing here upgrades a route.

Every member of both schemas is exact. A path, adapter command, environment,
argv, instruction text, credential, transcript, process fact or temporary path
is not a member, and a record carrying one is refused rather than read
partially. A binding beside a V1 record is such a member, which is what keeps a
V1 record from being read as a V2 one. So are missing, malformed,
unknown-schema, moved and natural-key-mismatched records. Only a file that is
not there means the session has not been constructed yet.

A V1 `client-native` route is legacy-unbound. It remains valid for native resume
under the contract that created it, authorizes no ACP attachment, and is never
overwritten, supplemented or upgraded. A user who needs attachment creates a
differently named logical session under the bound contract.

The route shares the coordinator's namespace, natural key and digest, so one
session names one lease, one ownership record and one route. The route directory
is `0700` and records are `0600`. Publication is durably flushed and atomically
create-if-absent: the loser of a race reads and adopts the winner, and never
overwrites, deletes, converts or partially reads it.

Reconciliation happens while ownership is held, before any provider
construction effect:

1. a fresh `session()` publishes nothing. It places the session — validating the
   agent and where the session will live — and constructs nothing, so the first
   operation that consumes that placement is what chooses the route. A
   `session()` on a placement that is already established reconciles its route
   eagerly, as it always has;
2. the first subscribed prompt on a pending placement publishes or adopts
   `acp-first` before ACP runtime creation, `ensureSession()` or a turn, and a
   turn that fails, is interrupted, or is never accepted by the backend
   afterwards leaves that route standing: provider state may exist before the
   caller observed the failure, and preserving the route is what stops that
   uncertainty from later being reclassified. An `acp-first` route by itself is
   not establishment;
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

At the root, V1 holds the foreground-terminal lease for the CLI execution. In a
terminal grid, the grid holds that root lease and a launch holds only its current
pane lease. Two launches cannot concurrently own the same root or pane terminal,
even when they name different sessions. Launches on distinct panes may run
concurrently, and sequential launches on one terminal are ordinary composition.

Cancellation interrupts the native interactive process, establishes that it can
no longer execute or hold its root or pane terminal, restores that terminal's
state, and runs every provider finalizer. A process that ignores the initial
interruption is terminated according to the host process adapter's bounded
shutdown policy.
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
because the preparation has to be retained *before* anything of the session
moves — before ACP ownership is released where ACP holds it, and before a
native process exists where the adapter named the session itself.
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

A prepared record carries `executableBinding` exactly when the route it agrees
with is bound. It is optional for compatibility: the client-allocated path was
released before any build was observed, so a record without it is legacy history
— readable, and resumable only under the native-only contract that wrote it. A
provider-returned preparation carries none, and a refusal that prepared no
identity invents none.

Every incomplete replay requires exact agreement between its journal and its
route on identity, provenance, instruction digest, launcher and build binding
before its first live effect, and then requires the live build to equal that
binding. Neither account repairs or republishes the other: a replay that
found a disagreement has discovered that the session it was going to continue is
not the session it prepared, and retains `identity-unavailable` without starting
a child. Equal instructions may resume the retained identity; different
instructions retain `instructions-refused` and replace neither the layer, the
route, the identity, nor any provider state.

An incomplete replay of a legacy unbound client-allocated launch retains
`executable-binding-refused` before any live work: nothing available to it can
show which build has that session's history, and resuming anyway would answer
the question by ignoring it. A **completed** replay of the same launch reads its
journal and nothing else, exactly as before — it performs no live validation and
contacts no route store, observer, ACP runtime or process.

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
cwd, the V1 empty additional-directory list, and permission mode. A record that
changed what was asked would make the journal describe a launch nobody
authored, so it is refused rather than retained.

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
primary cwd and the empty V1 additional-directory list
provider-reported current model, when observed, as non-configuring evidence
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

When the launch is a pane child, completed replay of the enclosing completed
grid claims the whole structured region before this operation is reached, so it
also contacts nothing. Partial grid replay restores a completed launch as a
settled pane status. An incomplete launch is reached under a newly created live
pane terminal and follows the same phase rules above; neither the new provider
layout nor the pane ordinal changes its retained launch or logical-session
identity.

Those are operation/runtime replay semantics: they define how an execution
behaves when an embedder, a test, or a future retained execution host supplies
the launch's durable history again. They do not create a public continuation
command. Diagnostic persistence remains `xmd run --journal`, and the ordinary
run command exposes no resume UX; only `xmd workflow resume` is a current public
CLI continuation mechanism, under the separate constrained workflow profile
that does not provide native launch.

XMD does not journal turns performed inside the native UI. The provider-native
session is authoritative for those turns, tool state, summaries, and transcript
history. The XMD journal remains authoritative for deterministic preparation,
the handoff identity, and whether the launch completed.

## Failure boundaries

Preparation failure creates or launches nothing on behalf of
`Session.Launch`. Provider availability already resolved by an enclosing
`Agent` remains an ordinary earlier effect.

Failure to configure instructions or the contextual cwd leaves ownership with
ACP and does not spawn the native UI. Missing native-launch capability fails
before detach. Detach failure also prevents spawn.

Changing instructions on a retained session fails with `instructions-refused`
whenever the provider cannot replace the layer in place while preserving
identity and history. Nothing is discarded to make room for a layer, and an
empty cached transcript authorizes nothing: a session an enclosing `<Session>`
placed and a `<Prompt>` then established is refused by a launch carrying a
different layer, exactly as a session a native UI has been in is. A `<Session>`
that only placed one has established nothing, so a launch inside it constructs
the session it named rather than meeting one.

A build this run cannot show is the build behind the session fails with
`executable-binding-refused`. Resolution, canonicalization, executable-file
validation, version parsing, digesting, schema recognition, equality, and a
session established before any build was recorded all end there. The diagnostic
names the stable class, the launcher, and the two canonical versions being
compared; it carries no executable path, raw version output, host error, argv,
environment, credential, instruction text or provider payload.

An attachment that reaches the provider and cannot open the conversation the
route names fails with `identity-unavailable`: missing provider history, an
adapter that cannot resume by name, a retained provider arrangement asserting
another conversation or none, and a returned identity that differs from the
route's are one answer, and none of them creates a substitute conversation.

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

The Deno source host and compiled binary install the first terminal-grid
provider for an ordinary foreground run when a TTY and the required tmux
capability are available. The provider prepares one invocation-private tmux
server and one persistent initial worker per pane. Its per-pane sockets live in
a short mode-0700 directory and admit one connection through a mode-0600 token
that is removed after authentication. It keeps tmux commands, socket paths,
tokens, session, window, pane, process, and control-client identifiers private.
It derives an explicit layout and swaps panes into authored row-major order,
because tmux does not honor pane IDs embedded in layout leaves. Its visible
inherited-stdio client and no-output control client remain distinct, and loss of
the root terminal becomes structured cancellation. A missing prerequisite
refuses the grid before pane start.

Node and Bun validate and catalog the same `<Terminal.Grid>` and `<Terminal>`
syntax but install no grid provider. Installing a grid provider advertises no
new Agent, launch adapter, session-construction mechanism, or attachment
capability; each `<Session.Launch>` still passes the existing independent
advertisement gates.

`<TestAgent>` installs a controlled launcher for its own body, because a
scripted agent's native UI does not exist and the terminal a host would hand it
belongs to whoever is running the tests. That is what lets an authored
`<Session.Launch>` run under `xmd test`, where the host installs none, and it
means a launch under `<TestAgent>` never reaches the host's launcher.

Only the Deno and compiled hosts assemble machine-wide agent sessions: a session
coordinator, a construction-route store and an executable observer, all rooted
together, plus the two advertised capability sets this host has proven. Node and
Bun keep the same advertised names and assemble none of the answers, so every
advertised operation refuses before provider work rather than acting while a
native UI may be in the conversation — as *Ownership and concurrency* describes.

Only ordinary `xmd run` receives that assembly. Every other command receives
none, and a host profile whose session authority differs from ordinary `xmd run`
states its capability sets explicitly rather than inheriting the provider
package's. The workflow Agent profile selects both sets empty and installs no
native foreground launcher, so `Session.Launch` is unsupported there without
weakening the workflow sandbox.

Provider and agent remain runtime bindings. The target and logical session name
remain role and continuity identities. V1 defines no stateful-Agent model
selection. A document can explicitly name an Agent where required, but no
provider-specific executable or resume syntax appears in `AGENTS.md`.

## Testing

The test-agent stack supplies deterministic provider state. A controlled native
launcher records the request, claims a known provider-native session ID, waits
on a test-controlled operation, and exits with a selected status. It never
starts Claude, Codex, or a model.

Terminal-grid tests additionally install a controlled provider that is not
tmux. It exposes readiness, independent pane settlement, reader close, provider
failure, parent cancellation, and teardown completion as test-controlled
operations while using the same core terminal authority and pane-scoped native
launchers. Separate tmux integration evidence exercises the production adapter;
core semantics are not inferred from tmux identifiers or process behavior. The
tmux evidence covers exact argv over private IPC, the runtime spawn boundary,
display that cannot become child input, real terminal job control, explicit
layout, atomic attach, independent close signals, cancellation phases, and the
bounded descendant, process-group, and terminal-holder teardown proof. It also
exercises pane reuse after terminal-holder quiescence; a process that has
already started a new session, closed the terminal, and lost its parent is
recorded as outside the observable host boundary.

The pane-native route has an explicit physical-terminal regression. A paired
pane delegates through any nearer launcher middleware to its composite endpoint;
the production tmux adapter delivers the unchanged command vector, cwd, and
environment to the authenticated worker for that authored ordinal, while a
root-launcher sentinel proves the foreground endpoint was not entered. Two pane
endpoints launch concurrently. Cancellation remains pending until worker
settlement and pane-terminal quiescence are observed. A separate root launch
still reaches the root foreground launcher.

Focused tests prove:

1. help discovers roles and performs no preparation or launch;
2. selecting one role excludes sibling preparation;
3. rendered instructions exactly match the selected files and computations;
4. no Agent prompt occurs during preparation or launch;
5. cwd, the explicit empty additional-directory list, and permission
   configuration reach the provider exactly;
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
    session a prompt established and never used again, and with no discard on
    any path; and
17. ownership covers session, prompt, launch and incomplete replay under one
    natural key, contention refuses instead of queueing, a crashed owner leaves
    a recovery tombstone, and a host with no coordinator refuses before
    contacting an agent;
18. a build binding is read and compared exactly — a moved matching build is
    accepted, a changed build is not, and an inexact record refuses rather than
    being read past;
19. new client-native construction observes the build before it allocates,
    publishes a bound V2 route, and retains a preparation that agrees with it,
    while a legacy V1 route resumes natively under the launcher name and gains
    nothing;
20. a `<Session>` or `<Prompt>` on a bound route supplies the route identity as
    the exact resume identity, delivers the observed path only to the matching
    child's transient environment, and refuses before ensure on a missing
    attachment gate, a missing observer, build drift, a disagreeing retained
    arrangement or a returned identity that is not the route's; and
21. ACP runtimes are partitioned by resolved agent command and binding, a handle
    is closed by the partition that created it, the last close evicts a bound
    partition, and provider teardown settles what remains;
22. claimed runtime work that produced no handle releases its claim, a partition
    is evicted only with no handles and no work in flight, a handle that came
    back survives every later refusal bound to its creator whichever path
    created it, a cancellation waits for an ensure already in flight and closes
    what it answers with before acknowledging quiescence, and a close that
    failed releases nothing and withholds quiescence; and
23. a canonical version parse accepts exactly one matching line, and refuses
    zero or several without repeating the output; and
24. launches on distinct pane terminals run concurrently while launches in one
    pane remain exclusive, the same logical Agent session still contends across
    panes, pane readiness occurs only after successful native-child start, grid
    close awaits launch cancellation and session quiescence, and completed and
    partial grid replay preserve the launch's existing identity rules.

The authored half of this is one executable Markdown document,
`packages/test-agent/src/NativeSessionLaunch.test.md`, run whole. It authors the
launch, the prompt that proves no turn was spent, and the refusal a launch meets
on a session an earlier prompt established, directly — a `<Session.Launch>` written as `<Session.Launch>`, not
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

Separate opt-in proofs run the real production command against an installed
CLI, and each proves the claims its adapter's provenance names under
*Provider-native identity* — an ACP-created session the native CLI can see for a
provider-returned adapter, direct creation and same-identity resume for one that
names its own sessions. A provider is not advertised as launch-capable until its
own list passes.

Claude's are `packages/acp/src/ClaudeNativeLaunch.test.md`,
`packages/acp/src/ClaudeZeroTurnExit.test.md` and
`packages/acp/src/ClaudeNativeToAcp.test.md`. They are authored documents, run
whole and independently of each other, and what they run is
`xmd run AGENTS.md#Implementor --default-agent claude` through the built binary
in a byte-for-byte copy of the checked-in role document — never Markdown a test
assembled. The first spends exactly two model turns; the second spends none and
lives apart so that correcting it can never respend them.

The third is the attachment proof, and it spends two of its own: one native turn
that plants a random marker, and one marker-free ACP turn — a checked-in
`<Session name="implementer"><Prompt>` document, run verbatim from the same
directory — that has to recover it. Equal identities are not the claim: two
accounts agreeing about a UUID say nothing about whether the conversation behind
it is the one the native turn happened in, so the marker exists only in that
first user turn and in the harness's own memory, reaching no instruction file,
argument vector, environment, session key, durable record, executed document or
reported field. Its independent, zero-turn half publishes a bound route naming a
fresh absent identity in a directory of its own and requires
`identity-unavailable` before a turn: a provider that quietly created empty
history there would make every recovery above unfalsifiable. Both are opt-in and
refuse before starting any provider process without it. TypeScript owns only the
pseudo-terminal, the child lifecycle, the argument vector the CLI received, file
modes, the structured route and journal reads, and exact-path cleanup; the
documents own the schemas, the assertions and everything an operator reads, and
no verdict may carry terminal output, argv, environment, prepared text, the
history marker or a private path.

A proof also removes what it created, and that is the harness's own act rather
than anything the product does. Production keeps the construction route and the
retained phases — a launch that deleted them would break the continuity claim 4
asserts. A proof reads those exact records for its own natural key, reduces them
to filtered evidence, and only then removes those exact paths, together with its
temporary project through the provider's own path-scoped purge. It never sweeps
the shared coordination namespace and never removes a record it did not create.
It also runs the command with an operator's environment rather than its own: a
proof nested inside another coding-agent session inherits markers that change
what the provider does, and would then be reporting on itself.

## What this contract covers

The feature is `launchAgentSession()` and the `Session.Launch` component; the
opaque launch request its public Agent route carries and the invocation-owned
authority its installed provider receives; the `agent_session_launch` durable
records with their replay and secret scanning; the host-owned session
coordinator and its crash-conservative ownership record; an invocation-owned
native-launch capability in the ACPX provider;
provider-native identity that is either asserted by the provider or allocated by
the adapter before the provider exists, retained explicitly and never inferred;
a strict create-once construction route beside the coordinator's own records,
in a released unbound form and a bound one; the host-owned executable observer
and the build binding it produces; ACP attachment to a bound client-native
session under its exact retained identity, through runtime partitions keyed by
agent command and build;
an inherited root- or pane-terminal interactive child with cancellation and
bounded reaping; composition with the terminal grid's independent pane leases
without changing session ownership or durable launch identity;
and the controlled TestAgent fixture that proves all of it without starting a
model.

The following capabilities remain outside V1 and fail closed rather than
degrading:

- **Only `claude` is advertised**, and separately for each capability. It is
  client-allocated, and its proofs ran the applicable claims under
  *Provider-native identity* against Claude Code 2.1.241 on macOS arm64. `codex`
  has a command shape and contract tests and is not launch-capable, because
  nothing has proven its provider-returned claims against an installed Codex. A
  launch naming an unadvertised agent is refused with `unsupported-capability`
  before anything of the session moves, and so is an attachment naming an agent
  advertised only for native launch.
- **`Agent.AddDir` is unbuilt**, so a launch declares no additional roots. The
  retained request says so explicitly — an empty ordered list — rather than
  omitting the fact, and no adapter maps a root it was never given. The ACP
  Client specification is the prerequisite owner for a future ordering and
  access-mode contract.
- **Stateful-Agent model selection is unbuilt.** `Agent`, `Session`, `Prompt`
  and `Session.Launch` expose no model prop or launch option. A provider may
  report the current model as observational evidence, but native launch neither
  selects nor changes it.
- **Executable upgrade migration is unbuilt.** A V2 route freezes one build for
  that logical session, and a later build refuses with
  `executable-binding-refused` rather than modifying the route or the provider's
  history. Rebinding old provider history to a new build is a separate design.
- **A legacy unbound client-native session never attaches.** It was constructed
  before XMD recorded which build accepted its identity, so nothing available
  now can show this run is talking to that build. It keeps native resume and
  refuses ACP attachment; a session that needs attachment is created anew under
  a different logical name.

Additional provider adapters land independently against the same core contract.
An adapter that cannot prove instruction injection before the first user turn
stays unsupported rather than weakening `Session.Launch` semantics.

Native UI event mirroring, XMD-rendered interactive chat, simultaneous root
foreground sessions outside a terminal grid, automatic nested `AGENTS.md`
discovery, bootstrap model turns, and workflow role scheduling are outside this
contract.

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
18. A new client-native session is bound to one observed executable build, and
    every later create, resume, attachment and incomplete replay reobserves and
    compares before a process, an ensure or a turn.
19. The canonical executable path is live only: it enters no route, journal,
    retained provider state, public result, diagnostic or global environment,
    and no partition that outlives its last handle.
20. Attachment supplies the route's exact identity as the resume identity, and
    the provider's canonical assertion must equal it before the first turn.
21. Native-launch advertisement and client-native attachment advertisement are
    separate trusted-host choices, and neither is inferred from the other.
22. A released V1 route and a completed legacy journal remain readable, and
    neither authorizes ACP attachment or incomplete live replay.
23. A failed acquisition retains no partition and no live path; a partition is
    evicted only when it holds no handle and no work in flight; every
    handle-producing path enters one ownership account bound to its creator the
    moment its handle exists; a cancellation observes and settles an ensure it
    already started before quiescence; quiescence is answered from that account;
    and a close that failed releases nothing and acknowledges none.
24. A terminal grid holds the root foreground lease while each launch holds only
    its current pane lease; distinct panes do not contend for terminal ownership,
    and one pane remains exclusive until observable processes and terminal
    holders from the prior launch are gone.
25. Pane terminal ownership never replaces or weakens natural-key Agent-session
    ownership, so two panes naming one session still contend without waiting.
26. A pane is ready only at the runtime child-spawn event; preparation, PID
    allocation, route publication, detach, private-file creation and first
    output are not readiness, and a failed spawn rolls none of them back.
27. Grid cancellation reaches every live launch, awaits its child teardown and
    session quiescence, and exposes no provider-specific layout identity in an
    authored, durable, result, or diagnostic surface.
28. The tmux provider creates native children only through authenticated
    persistent pane workers, preserves byte-exact argv outside tmux parsing,
    keeps worker display out of child input, distinguishes reader detach from
    control loss and server stop, and proves the bounded process and terminal
    teardown before pane reuse and grid settlement.
29. A paired pane's native launcher terminates at the required composite
    operation for its authored ordinal: the exact native request reaches that
    pane's authenticated worker, the root foreground launcher is not entered,
    distinct panes launch concurrently, cancellation awaits worker settlement
    and pane quiescence, and root launch routing remains unchanged.

Item 12 is the 2026-08-20 architecture amendment. ACPX fixes `systemPrompt` at
session creation, while native turns are not authoritative in its cached
transcript. The amendment prevents transcript absence from authorizing loss of
provider-owned history or substitution of durable session identity — which is
why V1 removed the discard branch entirely rather than restricting it.
