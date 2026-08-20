# Workflow Workspace Specification

- **Status:** Design contract for #218
- **Audience:** Workflow host, provider and component implementors

This specification defines the observable contract of `xmd workflow`: a
provider-neutral retained environment in which readable Markdown procedures run
as repeatable workflows. It complements `architecture.md`, which owns the
implementation invariants. The executable MDX specification continues to own
parsing, expansion, bindings, error modes and ordinary component behavior.

The public spelling of the constrained generated-XMD evaluator remains open.
Examples call it `<Expand>` so the rest of the contract can be reviewed without
mistaking that placeholder for a final component name.

## 1. First workflow

The document describes the procedure. The command selects the execution
environment:

```md
---
props:
  repository:
    type: string
    default: https://github.com/acme/project.git
---

# Prepare a release

<Repository name="project" url={props.repository}>
  <Git.Switch branch="release/1.4" />

  <File path="release/version.txt">1.4.0</File>
  <Git.Add paths="release/version.txt" />

  <Git.Commit message="Prepare release 1.4" as="commit" />
  <Git.Push />

  <PullRequest title="Prepare release 1.4" as="pullRequest">
Prepared by the release workflow from commit {commit}.
  </PullRequest>

Pull request: {pullRequest}
</Repository>
```

```sh
xmd workflow start prepare-release.md
```

The host creates a WorkflowRun, gives it an implicit Workspace, streams the
rendered document output and retains enough state to continue after the process
exits.

## 2. Two execution environments

### 2.1 `xmd run`

`xmd run document.md` executes against the current environment.

- Filesystem and process operations use the installed host capabilities.
- The host makes no promise to restore or reattach the environment.
- `--journal` remains a diagnostic trace and is not continuation input.
- Agent permissions remain caller-selected.

### 2.2 `xmd workflow`

`xmd workflow` executes supported operations against a retained constrained
environment.

- Every run owns an implicit root Workspace.
- The Workspace supplies contextual filesystem, repository, process and
  working-directory capabilities.
- Completed durable effects restore from the journal.
- Partial replay reattaches the same Workspace and continues at the frontier.
- Unsupported operations fail instead of falling back to unrelated host
  filesystem or process behavior.
- Agents inspect the Workspace read-only and cannot mutate it directly.

The same declarative components work in both environments. Durability comes
from the workflow host, not from another spelling of `<File>` or `<Git.Commit>`.

## 3. Workflow lifecycle

The immutable workflow definition is the source repository, pinned commit and
root document path established by the workflow-run contract. It is not an
implicit Repository inside the Workspace. Repository components may therefore
open two or more unrelated repositories without changing definition or run
identity.

When the definition names one **document target**, that exact canonical target
is part of it and therefore part of definition identity. A run of one section
and a run of the whole document are different runs, as are runs of two different
sections, so a resume is a resume only when it names the same exact target. The
selector a caller wrote never occupies that field: identity is the resolved
answer, so resuming re-enters the section the run actually executed rather than
whatever the same glob would name against a later checkout.

A root may also close itself over a **component bundle**, and that bundle is
part of the definition too. The root declares it in its own frontmatter:

```yaml
workflow:
  components:
    InstructionFiles: ./InstructionFiles.md
    Discovery: ./Discovery.md
    UserCheckpoint: ./UserCheckpoint.md
    Planning: ./Planning.md
    Implementation: ./Implementation.md
```

`workflow` is one closed member, `components`, holding a non-empty mapping from
a component name to a relative POSIX Markdown path beside the root. Each path is
normalized against the root's own directory in the same pinned commit and read
from that commit; the blob's own object ID is the component's source hash. A
root that declares no `workflow` member is a run with no bundle and keeps the
version 1 descriptor exactly; an explicitly empty mapping is refused rather than
becoming a second spelling of the same thing. A declaration may not claim
structural syntax, a component the engine supplies, or a name the host reserved.

Because the hash is identity, changing what a component says changes the
definition. A run of one bundle and a run of another are different runs, exactly
as two document targets are, and a run closed over a bundle is never the same run
as one closed over none.

The bundle is what the names in that run resolve to, and the only thing they
resolve to. The component search path stays empty, so a same-named file beside
the definition in a mutable checkout answers nothing, and an undeclared name
resolves to nothing at all. Components the engine supplies stay available
underneath the bundle; the bundle adds names rather than replacing them.

### 3.1 Start and resume stream in the foreground

Starting the same definition twice creates two runs:

```sh
xmd workflow start prepare-release.md
xmd workflow start prepare-release.md
```

Each invocation streams its rendered document output to standard output while
executing. Run identity and lifecycle metadata go to standard error.

`resume` names the exact retained run and supplies neither the document nor its
root props again:

```sh
xmd workflow resume run_01J...
```

An answer names the run, the wait inside it, and one JSON value:

```sh
xmd workflow answer run_01J... 9f2c... '{"approved":true}'
```

An inspection names no document and reads no definition: `status`, `list` and
`history` reach neither Git nor the working tree.

`start` executes until completion, failure, suspension or interruption.
`resume` continues an interrupted or ready suspended run under its retained
definition and normalized props. A document path locates a definition; it never
selects a previous run implicitly.

A machine-readable execution mode is a streamed event format. It does not
replace foreground execution with one final JSON object.

### 3.2 Root props use generated arguments

`workflow start` uses the same generated prop arguments as `xmd run`. There is
no generic `--prop` option:

```sh
xmd workflow start \
  --props-api-repository=https://github.com/fork/api.git \
  --props-api-base=feature/new-schema \
  --props-sdk-repository=https://github.com/fork/sdk.git \
  --props-sdk-base=main \
  sync-sdk.md
```

Repository locators are ordinary validated inputs. A value such as `"sdk"`
does not resolve through a hidden repository alias registry. Inputs request
state; the host separately authorizes access and supplies credentials.

### 3.3 Callers may select a run ID

Without `--id`, the host generates an opaque public ID. Automation may provide
an authorized stable ID:

```sh
xmd workflow start \
  --id=github-acme-project-release-1.4.0 \
  prepare-release.md
```

Starting an unused ID creates its run. Compatible reuse addresses the same run.
The immutable definition and normalized props must agree; incompatible reuse
fails. A completed compatible run performs a full replay and emits its retained
output without attaching the Workspace or external providers.

Only one workflow executor advances a run. It acquires one scope-owned executor
lock before stale recovery, beginning a document execution, attaching the
Workspace, reading replay history or importing the root. Another caller follows
the active execution when the host supports following or receives an
already-running result. The initial local CLI reports the active workflow
executor; it never executes the run concurrently.

The executor lock is an exclusive host lock, not a time lease. It has no
duration, expiry, renewal, heartbeat, watcher, generation record or liveness
poll. The operating system releases the local lock when the workflow executor
exits.

After acquisition, a new start atomically creates the immutable run, retrieval
metadata, empty Workspace, first document-execution record and `running` state.
Beginning a resumable existing run atomically creates its next execution record
and publishes `running`. Replaying a completed or failed root creates its
execution record while preserving the terminal run status, because the replay
does not make that outcome mutable again. Settlement is a later transaction
that atomically finishes the record and publishes the resulting status.
Inspection cannot observe half of either transition.

The executor lock stays in the trusted host's lifecycle scope and is not a
document provider. The host validates its exact in-process `ExecutorLock`
object inside every lifecycle mutation. A completed replay may hold the lock
for its execution record, but the run remains `completed` and
cancellation remains refused. Canonical execution returns before preparation
or root expansion and attaches no
Workspace, Files, Service, Agent, process or external provider.

An unfinished execution left after its host dies is not stale because time
passed or a PID disappeared. A new workflow executor proves staleness by
acquiring the released executor lock. For a `running` run it atomically closes
the exact execution and publishes `interrupted` before beginning another when
retained history has no root Close. A Close restores its canonical terminal
state. A `cancel` command that acquires the executor lock instead publishes
`cancelled` without beginning another execution, also only when no root Close
already won.
For a replay whose terminal run status was preserved, recovery closes the
execution as `interrupted` while leaving the completed or failed run state
unchanged. An old workflow executor or invalidated executor lock cannot
publish a later status.

The host validates namespace authority. There is no separate public
idempotency-key concept; every run-oriented command uses the public run ID.

### 3.4 Status vocabulary

The initial statuses are:

| Status | Meaning | `resume` |
| --- | --- | --- |
| `running` | one workflow executor is active | follows or reports the active executor |
| `suspended` | the workflow reached a deliberate durable wait | continues on the next explicit resume, from the answer delivered for that wait |
| `interrupted` | the workflow executor stopped outside an authored wait | allowed |
| `completed` | the root result completed | full replay only |
| `failed` | an uncaught failure escaped the root | refused |
| `cancelled` | a caller intentionally terminated the run | refused |

Expected transient recovery belongs in document middleware or an effect policy.
An uncaught root failure is terminal. Reusing its compatible ID replays the
retained failure rather than silently retrying it. A corrected document starts
a new run or an eligible history fork. A host-settlement failure may have no
root Close; compatible reuse reports that retained failed state and reason
without entering replay. Neither kind is advanced under the same ID.
A cancelled run reports its retained state without entering replay under either
command.

### 3.5 Suspension releases the executor lock

A document or middleware suspends through the provider-neutral workflow
operation:

```ts
interface WorkflowSuspensionRequest {
  request: Json;
  responseSchema: JsonObject;
}

suspendFor(request: WorkflowSuspensionRequest): Operation<Json>
```

The engine assigns one opaque suspension ID. The caller cannot select it. One
ordinary durable `suspension_request` event retains that ID, the request and the
response schema after the existing journal security filter. The event's result
means the request was published; it never means the wait was answered. The
run's stop reason references that event instead of copying its request.

The operation reaches the workflow executor across separately loaded package
copies through stable contextual routing. That route carries a suspension
notice, not an answer: a middleware handler may refuse or suppress its own
descendant's call, but returning a value cannot make an unanswered
`suspendFor()` continue. The executor accepts a notice only at the exact current
durable position of the matching retained request.

With no delivered input, `suspendFor()` remains pending while the workflow host
halts the document execution as structured control flow. It throws no document
failure and creates no root Close. After every child and live attachment has
torn down, one lifecycle transition finishes the document-execution record and
publishes `suspended`; only then does the host release the executor lock,
report the run ID and reason on standard error and return control to the caller.
No Agent,
process or Workspace attachment remains alive.

Pending input belongs to the suspending operation. For example, an Elicitation
provider records a schema-validated response. `resume` accepts neither
replacement root props nor an untyped generic answer. The host may schedule
resumption when input arrives, or a caller may invoke `resume`. If input remains
absent, replay restores the same request event, performs no earlier effect,
publishes no duplicate request, and returns incomplete again after teardown.
Providers remain lazy and are not contacted for replayed effects.

#### Typed answer delivery

Delivery is an operation separate from execution. Its public correlation
boundary is the retained suspension ID and response schema:

```sh
xmd workflow answer [--secret-detection|--no-secret-detection] <run-id> <suspension-id> <json>
```

`answer` records one pending answer and nothing else. It acquires no executor
lock, starts and resumes no document execution, attaches no Workspace, fetches
no definition, inserts no document-execution record, appends no journal event,
changes no run status and publishes no `workflow status:` line. On success it
writes one line to standard output:

```text
workflow answer: <run-id> (<suspension-id>)
```

A value is accepted only when the run is `suspended`, its stop reason names a
retained `suspension_request` event carrying the supplied suspension ID, and the
value satisfies the response schema that request retained. Secret detection
applies to the retained state and the answer event it would become, on the same
terms as durable journal persistence, and is on unless `--no-secret-detection`
disables it for that delivery. Duplicate, consumed, wrong-run, wrong-request,
late, invalid, cancelled-run and missing-run delivery is refused, and a refusal
leaves the run's storage unchanged. A refusal retains neither the rejected value
nor a secret match in its diagnostic.

`resume` keeps its grammar: exactly one run id, no answer flag and no untyped
generic answer. On a later explicit resume, `suspendFor()` continues only from
retained pending answer state for the exact current unanswered request, and
publishes one ordinary durable `suspension_answer` Yield before returning the
value to the document. Consuming that pending state and appending that Yield are
one database transaction: a crash or an injected failure before it commits
leaves the answer pending and publishes nothing, and replay after it commits
restores the retained answer event without consuming or publishing again.

This suspension and executor-lock-release contract folds issue #322 into #367;
#322 is not a separate implementation prerequisite. Scheduling — automatic
resume, watchers, unattended iteration and remote host selection — remains
blocked on #301.

### 3.6 Interruption and cancellation differ

Interrupting foreground execution, including with Ctrl-C, releases the current
executor lock and leaves the run `interrupted` and resumable.

```sh
xmd workflow cancel release-42
```

Explicit cancellation makes a run without a live workflow executor terminal.
It retains the journal and Workspace for inspection, training and an eligible
history fork. It does not undo completed local or external effects.

Cancellation follows the retained status:

- `running` with a live workflow executor refuses without mutation and tells
  the caller to interrupt the foreground process;
- stale `running` acquires the executor lock and becomes `cancelled` when no
  retained root Close already proves completion or failure;
- `suspended` and `interrupted` acquire the executor lock and become
  `cancelled` without starting an execution;
- `cancelled` succeeds idempotently; and
- `completed` and `failed` refuse because their terminal outcome already won.

The released advisory lock is the only stale-execution proof. The cancellation
transition validates the exact acquired executor lock, finishes an
unfinished stale execution when one exists, and publishes `cancelled`
atomically. No live scope is halted, watched or polled by another process, and
there is no request or
acknowledgement to outlive either process. A lifecycle storage refusal leaves
the retained state unchanged and reports no uncommitted terminal status.

Ctrl-C remains foreground interruption: the workflow executor attempts every
finalizer, publishes `interrupted` and releases the executor lock. A teardown
failure follows the ordinary foreground settlement rules; it is never converted
into explicit cancellation.

### 3.7 Exit status

Only foreground execution that reaches `completed` exits zero. Suspended,
failed, interrupted and cancelled executions have distinct nonzero outcomes so
shell automation cannot mistake an incomplete workflow for completion:

| Status | Exit |
| --- | --- |
| `completed` | 0 |
| `failed` | 1 |
| `suspended` | 2 |
| `cancelled` | 3 |
| `interrupted` | 130 |

A request the command refuses rather than runs — bad grammar, a missing run, an
incompatible reuse, damaged storage, an unsupported host — exits 1 and publishes
no status line.

**A status line says what was retained**, so a lifecycle transition storage
refused publishes none. Finishing the document-execution record and publishing
the run state are one transaction; no command observes one without the other.
What a refusal costs the exit code depends on when it happened:

- **Ordinary settlement.** The document finished and there is still an outcome
  to return, so a refused settlement transition exits **1**. The
  refusal is reported; a document failure that also occurred is reported too.
- **Signal-driven interruption.** SIGINT begins orderly teardown and the process
  exits **130**, and a refused interruption write does not change that: by the
  time a finalizer discovers it, the outcome the signal chose is already the
  process's. The refusal is still reported, and no status storage rejected is
  ever claimed — an interrupted run whose last write failed says nothing about
  `interrupted` rather than saying something untrue about it.

In both cases the refusal is authoritative and stops what depends on it. Only
the status and a categorical host reason are retained; a storage diagnostic
reaches the caller and is never written into the run.

Management commands report their own request. `workflow cancel <id>` exits zero
when cancellation succeeds even though the durable run status is `cancelled`.

### 3.8 The lifecycle is host-neutral

`start`, `resume`, `status`, `list`, `history`, `cancel`, `fork` and `delete`
form a provider-neutral control surface. The initial CLI exposes no remote-host
selector. The contract nevertheless contains no public SQLite access, local
process path or other assumption that prevents a later host from owning the
same run lifecycle remotely.

### 3.9 What is shipped

The lifecycle above is the whole design, including §3.7's rule that a status
line is published only once its atomic lifecycle transition has persisted. What a
caller can run today is `start`, `resume` and `fork`, the three inspections, and
the two control actions:

```sh
xmd workflow start [--id=<run-id>] [--props-*=…] <definition>
xmd workflow resume <run-id>
xmd workflow fork <source-run-id> --at=<event-id> [--id=<run-id>] <definition> [--props-*=…]
xmd workflow status <run-id> [--json]
xmd workflow list [--status=<status>] [--json]
xmd workflow history <run-id> [--forkable] [--json]
xmd workflow cancel <run-id>
xmd workflow delete <run-id>
```

`cancel` and `delete` take the executor lock before they change anything, which
is what makes them safe to offer at all: a live workflow executor holds that
lock, and both refuse it rather than reaching past it (§3.6). Each
reports one line on standard output — `workflow cancel: <run-id> (<status>)` and
`workflow delete: <run-id> (<removed>)`.

`start`, `resume` and `fork` stream the document's own output to standard output
and report two stable lines on standard error — `workflow run: <run-id>` once the run
has been created or found, and `workflow status: <status>` once the execution
settles.

A status line is published only after the transaction that finishes the
document-execution record and publishes the run state has committed. What a
refusal costs the exit code is §3.7's; what it costs the *record* is the same
everywhere: neither half is retained, the unpersisted status is neither
published nor claimed, and a document failure that also occurred is still
reported.

A refusal after the document finished is that refusal — never a host
interruption, and a completed or failed document is never relabelled
`interrupted` on the way out.

**A run that ended is not a run to continue.** `resume` admits `interrupted`,
`suspended` and (as a full replay) `completed`; `failed` and `cancelled` are
refused with exit 1 — before the definition is fetched from Git, before the
executor lock is acquired, before stale recovery, before a document-execution
record is begun, before a Workspace is attached, and before anything is
appended. Reusing a
compatible id through `start` is a separate rule: it replays a failed run's
retained failure, and that does not make the run eligible for `resume`.

- `start` takes exactly one Markdown definition path. There is no generic
  `--prop`, no `--journal`, no inline `--eval`, no agent option and no host
  selector. Without `--id` the host generates an opaque cryptographically random
  identifier, so starting the same document twice makes two runs; the local
  caller may supply any storage-valid non-empty identifier, and hashing is what
  keeps it from becoming a path.
- `resume` takes exactly one run id and nothing else. A document path, a
  generated property argument and the aggregate property forms are each refused
  rather than ignored.
- `fork` takes the run it continues, the committed event it continues from and
  the definition it continues with, and every one of the three is required. Its
  generated `--props-*` arguments are the candidate definition's and merge over
  the props the source retained, and `--at` belongs to it alone (§11).
- The document filesystem (§10.1) and Repository/Worktree/Dir composition (§6)
  are the capabilities a run has. Git operations, Agent, Worker Shell and native
  services are not: an inherited `API.Service` provider is refused rather than
  delegated to, and `temporaryDirectory` is refused rather than answered with a
  host directory.
- A function-component root is not supported in this subset and fails before the
  run executes. A bundled component is Markdown for the same reason: a `.ts`
  module, an extensionless path, a directory, a glob, a URL, a package
  specifier, an absolute path and a path that walks the tree are each refused
  rather than repaired.
- A declared component the pinned commit does not hold as readable Markdown
  refuses the `start` before storage is created and before any component code
  runs.
- The command exists on every runtime and the capability on one: the Deno
  entrypoint and the compiled binary own the local run store, and Node and Bun
  refuse before creating or executing anything.

Runs live beneath `~/.xmd/runs` unless `XMD_WORKFLOW_RUNS` names another
absolute directory. Where a run's database is on a host is arrangement, not
identity (§5.2).

Status, list and history are built (§4), and so are cancel and delete.
Repository, Worktree and Dir are built (§6); the Git operations of §7 are not.
The executor lock and the atomic lifecycle transitions built on it are #367's,
and they replace the opportunistic orphan closure that preceded them: liveness
is now an advisory lock the operating system releases when a host dies, rather
than something inferred from a status column. Durable suspension is built on the
same stack: a run that reaches `suspendFor()` retains one request, settles
`suspended`, releases its lock and exits 2, and every later resume reaches that
same wait. Typed answer delivery is what ends such a wait, and `xmd workflow
answer` is built by #300; scheduling is not, so a wait ends when somebody
resumes the run rather than on its own. Fork is built (§11): a run's history can
be continued under a changed definition from any committed checkpoint the
retained events allow.

The component bundle is built: a root declares one, `start` establishes it from
the pinned commit, the definition retains it, and `resume` and completed replay
reconstruct it. The adversarial implementation loop those five
stage names describe is not — its scheduling and unattended continuation belong
to the durable-suspension stack, and generated-XMD admission (§8.4) is unbuilt.

## 4. Inspection commands

### 4.1 Status and list

```sh
xmd workflow status release-1.4
xmd workflow status release-1.4 --json
xmd workflow list
xmd workflow list --status=interrupted
xmd workflow list --status=completed --json
```

`status` reports identity, status, immutable definition, normalized props,
timestamps, document executions, current journal frontier, current Workspace
version, and — for a forked run — the source run, checkpoint and Workspace root
it was admitted from. `list` reports visible runs newest-update first and
optionally filters by status. `status` and `history` require exactly one run ID;
`list` accepts none. A filter names exactly one of the six statuses.

Both commands use immutable lifecycle snapshots. They do not obtain an executor
lock, replay, attach a Workspace, materialize a root, import a document,
contact an Agent, process or external provider, reconcile an effect, or append.
Human output is the default; `--json` returns the same data structurally.

`list` discovers the run-storage root directly; no registry can disagree with
it. Each run contributes one database candidate. Exact advisory-lock sidecars —
the executor lock and the recovery coordination sidecar — use a distinct
provider-owned namespace and are not candidates. Every database
candidate receives strict read-only recognition. A
foreign, incompatible, damaged or unparseable candidate fails the request and
is reported distinctly. The command does not return the healthy subset as
though it were complete, and it changes no candidate.

A run whose host was lost mid-transaction is reported like any other. Its
database carries a rollback journal that only a write-capable connection can put
back, so `status`, `list` and `history` copy the database and that journal into
a private scratch directory, let SQLite recover the copy, and read the answer
from it. The retained pair is unchanged, still awaiting its next write-capable
owner, and the copy is removed before the answer is observable. `list` processes
at most one such candidate at a time. Recovery grants nothing else: these
commands still obtain no executor lock and no lifecycle authority, and a copy
that cannot be produced or removed is reported as its own refusal rather than as
damage to the run.

### 4.2 History

```sh
xmd workflow history release-1.4
xmd workflow history release-1.4 --forkable
xmd workflow history release-1.4 --json
```

`history --json` exposes every retained protocol event in append order and its
stable public event ID. `fork --at` accepts eligible IDs under §11. Human
history presents durable operations without repeating protocol event kinds:

```text
EVENT                                 OPERATION       SOURCE            RESULT     WORKSPACE
0f2c…                                 workspace_file  release.md:18:3   completed  9a1b…
1a7d…                                 agent_prompt    release.md:21:3   completed  9a1b…
2b8e…                                 exec            release.md:24:3   completed  4c5d…

Outcome: completed at 3c9f…, Workspace 4c5d…
```

The identifiers are the retained event and Workspace-root identities, shortened
here for the page. A row with no authored source shows that it has none rather
than a location the command derived.

Each entry contains the exact retained event ID and protocol event, the
Workspace root associated with that row, its forkability, an optional normalized
authored source, and — for a row a fork inherited — the source run and source
event it came from. Yield descriptions carry it under the stable namespaced
`"executablemd.source-position"` field before the event crosses the security
filter. Close events, root import and trusted-host preparation may have no
authored source; absence is explicit. History never parses an expansion ID or
reopens the definition to guess one. A namespaced field that is present but
does not parse makes the entry unreadable rather than source-less, and its value
is not repeated in the diagnostic.

The protocol event supplies the phase, operation and normalized evaluated
arguments where they exist, and its result or normalized error. JSON contains
the full already-filtered structured event. Human output may summarize long
values, presents each Yield as its durable operation, and renders the root
Close as the canonical outcome footer instead of another operation row. If
structured execution produces child Closes, their terminal results remain
visible with the corresponding coroutine. A suspended, interrupted or
cancelled run with no root Close says that no canonical document outcome was
recorded. History never reconstructs a filtered value from the Workspace or
provider, materializes the associated root, mixes rendered stdout into the
trace, removes a retained event from JSON, or synthesizes a journal event.

`--json` always includes `forkability`, and `--forkable --json` returns the same
JSON. `--forkable` adds `FORKABLE` and `BLOCKERS` to human output and keeps
every row:

```json
{
  "forkability": {
    "forkable": false,
    "blockers": [{ "code": "agent-state-unavailable", "eventId": "<event-id>" }]
  }
}
```

Forkability is cumulative through the checkpoint, and `blockers` is empty
exactly when `forkable` is true. Each blocker names the earliest event that
introduced it, under one of four stable codes: `workspace-root-unavailable`,
`agent-state-unavailable`, `external-state-unavailable` and
`unsupported-effect`. An effect type is inheritable because it is recognized,
never because it failed to match something, so history a later build wrote
reports `unsupported-effect` rather than a checkpoint this build is guessing
about. Blocker output carries stable codes and retained event IDs and nothing
else: no filtered values, props, provider diagnostics or secrets. Candidate
definition and prop divergence are reported by `fork`, not here.

History is read-only. Event IDs are host-public run-history identifiers, not
SQLite row numbers.

## 5. Workspace structure and identity

One WorkflowRun owns one root Workspace:

```text
WorkflowRun run_01J...
├── filtered journal and effect results
├── root Workspace
│   ├── run-level files and Agent configuration
│   ├── named Repositories
│   └── named Worktrees
└── provider-session mappings
```

The Workspace is neither a Repository nor a Worktree. One Workspace may hold
several repositories and run-level files. Logical component identities do not
depend on attachment-specific absolute paths:

```text
Repository identity = Workspace identity + Repository name
Worktree identity   = Repository identity + Worktree name
Agent session       = WorkflowRun + Agent/Session expansion identity
```

Bindings expose Workspace-relative path strings. Provider attachments map them
to live paths without changing logical identity.

The run's SQLite database is one physical backup and retention boundary for
logically separate journal, filesystem, Git metadata and Agent-session tables.
Co-location does not make arbitrary filesystem content journal data.

### 5.1 What the run record holds

The run's own record is the part of that database the lifecycle reads. It holds
the immutable definition, the definition base and the normalized props;
the current status and its stop reason; one document-execution record per start
and per resume; replaceable retrieval metadata; and the filtered journal.

The immutable definition is a versioned descriptor naming an object format, an
object ID and the repository-relative root document path. It also carries the
component bundle when the root declares one: an array sorted by component name,
each entry holding that name, its canonical repository-relative path inside the
pinned commit, and the blob's object ID under the descriptor's own object
format. The bundle is a member of that descriptor rather than a version past it,
so a definition retained before bundles existed parses unchanged and identifies
a run closed over no components; an empty array is not a second spelling of that
and is refused. A repository locator is not part of it. Where the definition can be fetched from, and where it is
checked out on one machine, are retrieval metadata: replaceable, free of
credentials, reauthorized by the host before use, and excluded from the
comparison that decides whether a reused run ID addresses the same run.

Compatible reuse compares the run ID, the whole descriptor including its
version and its component bundle, the base and the normalized props,
canonically. A changed component name, canonical path, source hash or component
set conflicts as `definition`, and the refusal names that field rather than any
value behind it. Status, stop reason,
retrieval metadata, timestamps, document executions and journal records are
excluded, so a completed run asked for again is found rather than refused.

A stop reason is a categorical host code or a reference to an already-filtered
journal event. Arbitrary failure text is not retained beside the journal that
filtered it, and `history` therefore exposes no value the journal's security
policy has not already seen.

A suspension request is one such filtered journal event. Its opaque suspension
ID, request and response schema live in the event description; no pending-input
table or executor identity is added to the run record. Single-executor
enforcement uses only the provider-owned advisory-lock sidecar. Complete schema version 1
therefore remains one exact shape for #367.

Document-execution records are not attempts. An attempt is one execution of a
retried operation or region and belongs to the journal.

### 5.2 Storage is described, never replaced

A run is found by its public ID alone, without consulting a second registry.
The database's location on a host is arrangement rather than identity, so the
run ID is also retained inside the run and checked: storage holding a different
run than its location implies is reported as a distinct failure.

Absent, conflicting, foreign, version-incompatible, damaged and unparseable
storage are separate reported conditions. None of them is repaired in place: an
incompatible or damaged database is described and left exactly as found, and a
lookup that finds nothing creates nothing. A host never claims to continue a
run whose history it has just replaced.

## 6. Repository and Worktree

`<Repository>`, `<Worktree>` and `<Dir>` are ordinary registered defaults that
the workflow host installs for a live or partial execution, alongside the
document filesystem. A repository-local component with one of those names is
chosen ahead of them. A completed root replay installs neither them nor the
provider behind them.

**These components describe known refusals; document-authored regions decide
whether to print and continue.** A refusal one of them recognizes — a locator
that cannot be used, a base that names no commit, a branch another checkout
holds, a name reused for a different configuration, a Worktree with no enclosing
Repository, an invalid `<Dir>` — is reported with a fixed, sanitized diagnostic
and then fails the operation it is part of, so later siblings do not execute. An
authored `<PrintErrors>` region prints that refusal once and continues under the
region's ordinary policy. None of these components declares that recovery on an
author's behalf: doing so would decide it for every failure the invocation owns,
including invalid props, a provider that is not installed, and an answer that
does not parse, none of which is something a document asked for.

Two things stay outside that rule, in opposite directions. A stale-state failure
(§9) is a durability failure and is fatal through every printing boundary,
authored or not. A failure of the content a caller projected belongs to the
region that text is written in, exactly as it would through any other
component.

### 6.1 Repository

`<Repository>` owns an authorized Git locator, shared object storage, remote
metadata and one primary non-bare checkout.

```md
<Repository
  name="api"
  url={props.apiRepository}
  base={props.apiBase}
>
  <File path="openapi.json" as="schema" />
</Repository>
```

Initial props:

| Prop | Required | Meaning |
| --- | --- | --- |
| `name` | yes | durable Workspace-local identity |
| `url` | yes | authorized HTTPS, SSH or other Git-supported locator |
| `base` | no | initial branch or ref; remote default branch when absent |
| `as` | no | ordinary binding of the Workspace-relative checkout path |

There are initially no public `path`, `provider`, `remote` or credential props.
Workspace owns placement; the host owns authorization and credentials.

When first reached, Repository authorizes the locator, resolves `base` or the
remote default branch, pins the resulting commit and creates or reconciles the
named primary checkout on that branch. Resolution happens once. Replay does not
query a moving branch again.

The checkout is ordinary named-branch Git state, not detached HEAD. Lexical
Repository installs it as contextual cwd while expanding children. A
self-closing Repository with `as` creates or restores it and binds its stable
Workspace-relative path.

When `base` resolves only to a tag or a bare commit rather than a branch, the
checkout is created on a deterministic provider-owned branch and that branch is
what the record names. HEAD is never left detached, because a detached checkout
gives a later Switch, Commit or Push no branch to mean anything against.

A locator is admitted before it is used, and admission is an allowlist: an
`https`, `http`, `ssh`, `git` or `file` URL carrying no userinfo, Git's
`user@host:path` form, or an absolute local path. A locator carrying a
credential is refused rather than rewritten, because rewriting it would retain a
run nobody asked for. What is retained beside the record is the admitted locator
itself; what travels through the journal, a binding or a diagnostic is its
fingerprint.

Reusing a Repository name is compatible only when the admitted locator and the
requested base both agree; an incompatible reuse is refused and repoints
nothing. Refusals are reported with a fixed vocabulary — the locator could not
be used, the base names no commit, the remote has no default branch, the name is
already this run's for a different configuration — and never carry a Git message
or a host path.

### 6.2 Additional Worktrees

`<Worktree>` creates an additional linked checkout inside an enclosing lexical
Repository:

```md
<Repository name="api" url={props.apiRepository}>
  <Worktree
    name={props.candidateName}
    branch="feature/new-api"
    base="main"
  >
    <File path="openapi.json" as="candidateSchema" />
  </Worktree>
</Repository>
```

Initial props:

| Prop | Required | Meaning |
| --- | --- | --- |
| `name` | yes | durable Repository-local identity; expressions are allowed |
| `branch` | yes | named branch checked out by this Worktree |
| `base` | no | starting ref only when the branch must be created |
| `as` | no | ordinary binding of the Workspace-relative checkout path |

With no `base`, a missing branch starts from the primary checkout's current
commit. An existing compatible branch is checked out rather than recreated.
Reusing a Worktree identity with incompatible configuration fails. A branch
already checked out by another checkout fails instead of moving it or silently
using detached HEAD.

Worktree has no repository locator, placement, force or detached-head controls.
Its lexical and self-closing path behavior matches Repository. A branch the
remote published counts as existing, so naming one checks it out rather than
recreating it at another commit.

The pairing that both binds a path and renders descendants is a self-closing
Worktree captured with `as`, followed by a lexical `<Dir>` inside the enclosing
Repository:

```md
<Repository name="project" url={props.repository} base={props.base}>
  <Worktree name="implementation" branch={props.branch} as="worktree" />
  <Dir path={worktree}>
    <!-- stages and final report -->
  </Dir>
</Repository>
```

A lexical Worktree written with `as` keeps ordinary generic capture semantics:
its rendered descendants are captured and suppressed, and it does not bind the
checkout path while also rendering them.

### 6.3 Directory context

`<Dir>` has one meaning: lexical cwd.

```md
<Dir path={repository_api}>
  <File path="openapi.json" as="schema" />
</Dir>
```

It restores the previous cwd after its children finish. Self-closing `<Dir />`
is invalid. A Prompt sent to an already-established Agent does not acquire a new
cwd merely because its invocation appears inside a later Dir.

## 7. Git operations

Git operations require a contextual Repository or Worktree checkout. They use
the transactional Workspace Git implementation, not an implicit host command.

A checkout's own configuration is a file the run retains, not an instruction to
it. Several ordinary Git settings name a *program* — a hook directory, a signing
helper, a file-system monitor — and a `.git/config` inside the Workspace is
something a document can write and a replay restores. Any of them running would
put work outside the effect's transaction: a `post-commit` hook in particular
runs after a commit has succeeded, so every check made about the object would
pass with the hook's work already done, and it is not one `--no-verify` skips. So
those settings are fixed by the provider for every command it runs, where they
outrank the repository's own configuration, and a commit is unsigned. What
decides a Git object is the operation's admitted input, the checkout's state and
the run's own identity and time — never what the checkout asks for.

### 7.1 Switch

```md
<Git.Switch branch="feature/new-schema" base="main" />
```

`branch` is required. Creation-only `base` is optional and defaults to current
HEAD. Existing branches switch without reset; missing branches are created. A
branch the repository's remote published counts as existing, so naming one
checks it out rather than creating another. `base` is therefore consulted only
when the branch must be created. Compatible local changes may carry, changes Git
would overwrite fail and a branch checked out elsewhere fails. There are
initially no path, detached, force or discard controls. `<Git.Checkout>` remains
absent until its broader commit/path-restoration behavior has a distinct
contract.

Which checkout moves is decided by where the element is written: the enclosing
`<Repository>` supplies the Repository and the contextual working directory
supplies the place, so the same element inside a `<Dir>` at a Worktree moves that
Worktree. A directory *inside* a checkout selects that checkout — a Git operation
written in `<Dir path="packages/core">` still operates on the whole checkout that
directory belongs to, and that directory is only where the operation runs.

Neither observation carries authority. The Repository is compared with the row
the run retained under that name, member for member, and the working directory
has to be a real directory inside one of the checkouts the run retains for it.
No enclosing `<Repository>` at all, a Repository that is not the retained one, a
directory inside no retained checkout, and retained state that no longer agrees
with the identity naming it are failures of the run rather than outcomes: no Git
runs, nothing is published, and `<PrintErrors>` cannot print them. The same is
true of a native Git failure the provider has no word for — the refusals are a
closed set, and an unrecognized one is infrastructure rather than the nearest
word.

Switch renders nothing, binds nothing and takes no content. What it retains is
evidence: the checkout it ran in, the requested and resolved branch, the
requested base and the commit a created branch actually started from, and the
branch, commit, HEAD tree and index tree the checkout held before and after.

A retained result is read back for the invocation that recorded it, and one whose
identity, branch, base or transition does not describe that invocation is damage
rather than history. A Worktree's name and its path are one identity, held to the
placement that produced them; and switching to the branch a checkout is already
on moves nothing, so a result whose commit, HEAD tree or index tree changed
across it describes a transition Switch does not make.

### 7.2 Add

```md
<Git.Add paths="release/notes.md" />
<Git.Add paths={["packages/core", "packages/cli", "deno.lock"]} />
<Git.Add paths="." />
```

`paths` is a required non-empty Git pathspec string or array. Matching new
files, modifications and deletions are staged. Omission never means all paths;
`"."` is explicit. Add returns no value and initially has no `all`, `update`,
`patch`, `force` or `intentToAdd` props.

One string is the one-entry array, and an array is passed to Git as written:
order, repetitions, spelling and Git's own pathspec magic all survive, because
each of them changes what is staged. The whole array is one command and one
effect. An empty string, an empty array and an empty entry are refused rather
than read as "here" or as "everything".

A pathspec must be well-formed text. A string is UTF-16 code units and need not
be well-formed, but the way to Git is UTF-8, and an unpaired surrogate becomes
U+FFFD in transit — so what Git received would differ from what the run
retained. A pathspec holding one is refused as malformed input, before any effect
exists and before Git runs, wherever the request enters: a document's element and
a direct call on the composition Api are held to the same boundary. Nothing is
normalized or respelled to make one fit, and every well-formed string — U+FFFD
included, along with newlines, separators, repetitions and pathspec magic —
reaches Git exactly as written.

`paths` is a pathspec, not a way of choosing a checkout. Which checkout is
staged is decided the way §7.1 decides it, and every pathspec is read relative to
the working directory the element was written in — so `<Git.Add paths="." />`
inside a `<Dir path="packages">` stages that directory rather than the checkout
that contains it.

Add renders nothing, binds nothing and takes no content. What it retains is
evidence: the checkout it ran in, the pathspecs exactly as they were given, and
the branch, commit, HEAD tree and index tree the checkout held before and after.
Staging moves the index and nothing else, so a retained result whose branch,
commit or HEAD tree changed describes a transition Add does not make, while its
index tree may have moved or not — staging what is already staged changes
nothing. What Git matched is not enumerated: naming files it discovered would put
content beyond the document's own pathspecs into retained history.

Failure follows §7.1, with four refusals of its own. A pathspec that matched no
files, one that selects an ignored path — Add has no force control — one that
leaves the checkout, and one whose Git pathspec magic is invalid are each
something the document asked for and did not get, so each is a failed durable
result against a Workspace root that did not move, replayed exactly. Any other
native failure is infrastructure: the run fails and nothing is published.

Native Git is not all-or-none here. A command naming an ignored path stages
everything else it matched before refusing, so an Add is all-or-none because the
effect makes it so: nothing is imported, the materialization is discarded, and
the attempt is rolled back, leaving no partial staging in the Workspace. No
refusal names a path, quotes Git, or reports a file Git discovered.

### 7.3 Commit

```md
<Git.Commit message={commitMessage} as="commit">
  <Git.Add paths="release/notes.md" />

Generated from validated release metadata.
</Git.Commit>
```

Commit expands its content completely before describing an effect of its own, so
a nested operation is its own expansion, its own effect and its own transaction,
finished before a commit exists to include it. Which checkout it commits in is
decided the way §7.1 decides it, and neither observation carries authority.

Unlike Switch and Add it produces a value, so it renders nothing and is written
with `as`: the binding is the full object id of the commit.

**The message.** With only `message`, that string is the whole message. With only
content, the rendered child text is. With both, `message` comes first, one blank
line separates them, and the non-empty rendered child text follows. Content that
renders no text — a staging child — contributes nothing, so a `message` prop
written beside one is the whole message. A message with no text in it is refused.

The child text is never trimmed on its own. The composed message is canonicalized
once, and once only: CRLF and bare CR become LF, whitespace is removed from the
end of the complete message, and exactly one final newline is added. Everything
before that end survives unchanged — including the blank lines a rendered body
begins with, which are part of what that content is. Those bytes are what Git
commits, verbatim — Git's own message cleanup is disabled — and what it wrote is
read back and compared before anything is published.

A message must be well-formed text, on the same terms and for the same reason as
a pathspec in §7.2, and a message that is not already canonical is refused where
it reaches the composition Api directly rather than quietly rewritten: what the
run retains is a digest of the bytes it committed.

**Time.** The provider captures one instant while the effect runs, truncates it
to whole seconds and records it as both author and committer time. There is no
prop and no caller-supplied time, and a replay restores the retained second
rather than reading a clock.

**What it commits.** Exactly the index. There is no `paths`, no implicit staging,
no `allowEmpty`, no `amend`, no signing and no author or force control, so
unstaged and untracked work stays where it is. Git identity comes from the
Workspace provider. The Git object, the branch and index it moves and the journal
result commit in one effect transaction.

Commit renders nothing and retains no message text. What it retains is evidence:
the checkout it ran in, where the message came from and the digest and UTF-8 byte
length of its exact bytes, the parent, tree and commit object ids, the second it
recorded, and the branch, commit, HEAD tree and index tree the checkout held
before and after.

A retained result is read back for the invocation that recorded it. Beyond that
evidence it describes an object graph a commit of the index can have: exactly one
parent, which is the commit the checkout was on; a tree that is the one the index
described; and a checkout that ends on that commit with both HEAD and the index
describing that tree, on the branch it began on. A merge, an amend-like
transition, a message that came back different or a time that is not the captured
one is infrastructure — the run fails, the materialization is discarded and
nothing is published.

Failure follows §7.1, with one refusal of its own. An index that already holds
what HEAD holds is nothing to commit, which is something the document asked for
and did not get: it is decided from the checkout's own state, so no command runs
and no object is written, and it is a failed durable result against a Workspace
root that did not move, replayed exactly.

### 7.4 Push

```md
<Repository name="project" url={props.repository}>
  <Git.Switch branch="release/1.4" />
  <Git.Add paths="release/notes.md" />
  <Git.Commit message="Prepare 1.4" as="commit" />
  <Git.Push />
</Repository>
```

`<Git.Push />` takes no props. There is nothing to name: the remote is the
Repository's own `origin`, the branch is the one the selected checkout is on,
and the commit is the one that branch points at. Which checkout that is, is
decided the way §7.1 decides it, so the same element inside a `<Dir>` at a
linked worktree publishes that worktree's branch instead. There are initially no
`remote`, `branch`, `refspec`, `path`, `force`, `upstream`, `provider` or
credential props: publishing somewhere other than where the checkout is takes an
explicit contract this component does not have.

It renders nothing, binds nothing and takes no content, and it exposes no
component result. That is a statement about what a document can read, not about
what the run retains — the filtered reconciliation record below is durable.

**Where the remote sits.** The branch this publishes to belongs to a Git host,
which no local transaction can enclose, so Push reconciles through §10.2 rather
than through the Workspace transaction. It observes the destination before it
mutates: a destination that already holds this exact commit is compatible
completion and is adopted with nothing performed, a destination proven absent is
published to once, and a destination holding another commit is a conflict. Push
never force-pushes, resets, merges or rebases, and it never creates or changes
`branch.<name>.remote` or `branch.<name>.merge` — on success, on refusal, on
cancellation, on crash and on replay alike.

Push is explicit. Neither Commit nor PullRequest publishes implicitly.

**The one refusal of its own.** A checkout whose HEAD names no branch has
nothing to publish. It is decided from the checkout's own state, before a
Git-host effect exists and before any remote is contacted, and it is a
`unnamed-branch` refusal a document can act on. Failure otherwise follows §7.1:
no Repository in scope, a Repository that is not the retained one and a
directory inside no retained checkout are failures of the run.

**What reaches the Git host, and how.** The network operation never runs through
the selected checkout's own `.git/config`. That file is inside the Workspace the
run retains, so a document can write one, and `remote.origin.pushurl`, a
`url.<base>.pushInsteadOf` rewrite, a `pre-push` hook, a credential helper and a
signing program are all things it could then name. The provider instead runs the
transport in a disposable repository of its own, configured by nothing but its
own creation, which reads the selected checkout's object database through a
read-only alternate — the authenticated private object-source attachment of
§10.2. The transport destination is the exact private retained locator, not a
mutable `remote.origin.url` or `pushurl`, and the push carries one explicit
refspec, no upstream option and no force option.

Pointing that alternate at the object database says where Git starts reading,
not where it stops. An object database names further ones in
`objects/info/alternates` and Git follows that chain transitively, and a symbolic
link anywhere under `objects/` redirects a read before Git reports anything about
it — both are files inside the Workspace, so both are things a document can
write. Everything Git may traverse is therefore proven to resolve inside the
object database this run authenticated, before the first remote observation and
after every local authority check.

That chain is read the way Git reads it, spelling included. An entry beginning
with `"` is a C-style quoted path Git unquotes before resolving anything, so the
same bytes name an external database to Git and a relative path with quote
characters in its name to anything comparing spellings — and a directory of that
literal name, planted inside the authenticated database, would answer for a
traversal that never goes there. Quoting Git itself rejects is ordinary text to
Git and to this proof alike. An entry whose exact path cannot be named is
refused rather than approximated. A graph that leaves it is rejected rather than
repaired: deleting an authored alternate would publish from a database the run
edited on the author's behalf, and ignoring one would publish from a database
that is not the one it verified. The refusal is a boundary failure — nothing is
observed, nothing is performed, nothing is published, and the run fail-stops —
and it repeats no path an author wrote. A linked worktree shares the
Repository's object database, so one proof covers both kinds of checkout.

**What it retains.** One filtered Git-host reconciliation record: the filtered
Repository identity — its name, locator fingerprint, requested base, creation
commit, primary branch and object format, and never its checkout path — the
remote `origin`, the branch, the full destination ref `refs/heads/<branch>`, the
refspec `<commit>:<destination>`, the local commit, the observed remote commit,
and the reconciliation decision. No host path, locator, credential, Git object
content or provider output appears in it. The natural key is that Repository
identity with the remote and the destination ref: the external resource is the
Repository's origin branch, while the complete request and its durable
fingerprint still discriminate a changed source commit.

A retained record is read back for the invocation that recorded it. Beyond the
shape it describes a reconciliation this operation can reach: the remote is
`origin`, the destination is that branch's ref, the refspec is that commit
published to that destination, the observed commit is the one published, and the
decision agrees with the pre-state — `performed` follows proven absence and
`adopted` follows a destination that already held the commit.

### 7.5 Pull request

```md
<Repository name="project" url={props.repository}>
  <Git.Push />
  <PullRequest
    number={props.pullRequestNumber}
    title="Prepare release 1.4"
    base="main"
    draft={true}
    as="pullRequest"
  >
Prepared from commit {commit}.
  </PullRequest>
</Repository>
```

`title` is required. `number` defaults to none, `base` defaults to the
Repository's recorded initial branch, `draft` defaults to false and the rendered
content is the body, verbatim — nothing trims or reflows what a document wrote,
and content that renders nothing is an empty body. Which checkout the pull
request belongs to is decided the way §7.1 decides it, so the head is the branch
that checkout is on and there are no `repository`, `head`, `remote`, `provider`,
`token`, `label`, `reviewer`, `merge` or implicit-push controls.

Content expands first and completely. A body that never finished rendering stops
everything this component owns, before a Repository is observed, a checkout is
selected, retained history is read or a Git host exists in the story.

**PullRequest is an upsert over one explicit pull-request identity.** Without a
number the document asks for a pull request from this head to this base: one is
created, or the compatible one an interrupted earlier attempt already created is
adopted rather than duplicated. With a number it asks for that exact pull
request: its title, body, draft state and base are brought to what the
invocation says, and when they already say it the effect records a no-op. The
head is never rewritten — a numbered pull request whose head is not already this
run's head branch and commit is a conflict, as is one that belongs to another
repository, was opened from a fork, or is no longer open. Nothing is reopened,
merged, closed or commented on.

**PullRequest never pushes.** Direct remote observation is not a substitute for
authorization to create or update one: the run must already hold its own
successful `Git.Push` result for the same Repository identity, head branch, full
destination ref and head SHA. That admission reads this run's own successful
Git-host records and is closed — a record of another kind and a Push of another
Repository or destination are ignored; a relevant Push at another commit is
conflicting; and a successful Git-host record whose natural key, inputs and
result do not describe one publication is unreadable, because a record that
cannot be read as one whole thing cannot be shown to be about something else.
Missing, conflicting and unreadable evidence are three fixed local refusals:
each names its category and, where there is one, its remedy, quotes no journal
content, and happens before the Git host is observed. So do a missing or
replaced Repository context, a working directory inside no retained checkout,
and a checkout whose HEAD names no branch. None of them is printable: a later
sibling must not run as though a pull request had been opened or updated.

**The `as` result is stable evidence of what the effect settled on**, not a live
pull-request snapshot. It is exactly the filtered Repository identity — name,
locator fingerprint, requested base, creation commit, primary branch and object
format — the provider's own stable pull-request identity, the number, the URL,
the state `open`, and the head and base SHAs of the snapshot the reconciliation
finished at. Reviews, comments, checks, labels, reviewers, merge state and later
title, body, draft or branch movement are separate reads or effects rather than
freshness smuggled into the result. Once the local record commits, later
movement cannot change what it retains, and a completed replay hands it back
without contacting a provider.

**Reconciliation.** The natural key is one of two shapes, because the two modes
name different external resources:

```text
{ mode: "create", repository, headBranch, baseBranch }
{ mode: "update", repository, number }
```

The complete request fingerprint covers every input, so a changed title, body,
draft flag, base, head commit or number diverges at the durable position rather
than consuming the result retained for another question. In create mode, a
branch pair with no open pull request and no closed or merged one is absent and
is created once; one whose single open pull request agrees with every field the
request names is adopted; one that disagrees, or holds a closed or merged pull
request, is a conflict; more than one open pull request is ambiguous, even if
one of them fits. In update mode, the numbered pull request is fetched exactly:
one that already holds every requested field is adopted as a no-op, and one that
differs in a mutable field is the requested completion being absent, with the
existing pull request retained as the pre-state that a performed update
describes itself against.

**The first adapter** works over `github.com`, on direct same-repository pull
requests. It is selected from the private retained locator — the admitted
credential-free HTTPS, SSH-URL and `git@github.com:owner/repository` forms, with
an optional terminal `.git` — and a Repository this adapter does not recognize
is refused as an unsupported effect kind from observation, before any remote
work. The credential is read from `GH_TOKEN`, then `GITHUB_TOKEN`, only after
local authority succeeds; stored `gh auth` credentials are not read and no
credential is inherited by a child process. Creation is one REST creation; an
update is one REST field change and, when the draft state differs, one GraphQL
draft transition, each issued at most once per attempt and followed by exactly
one observation that decides the outcome. A rejected mutation, a partial
multi-call update, a transport failure and an unreadable answer are all
temporary unavailability rather than failure of the effect: nothing is repeated
inside the attempt, and a later explicit attempt observes what is now there and
finishes only what is left. A page walk that cannot be completed — a next
relation this adapter will not follow or cannot read — is unavailability too,
and never an empty candidate set. The locator, the endpoint, the credential and
every raw response stay inside the per-invocation provider closure: public
routing middleware receives the frozen JSON request of §10.2 and nothing else,
and the journal holds the normalized record alone.

### 7.6 Multiple repositories are explicit composition

There is no transaction spanning repositories:

```text
API Commit completes
        │
        ▼
SDK Commit starts
        │
        ✕ interruption
```

Each Commit, Push and PullRequest owns its effect identity and durability.
Document structure expresses ordering, retry and failure policy. It never makes
two Git repositories one atomic domain.

## 8. Agents inspect; XMD mutates

### 8.1 Directory registration

`<Agent.AddDir>` explicitly adds a read-only path to its enclosing Agent
session:

```md
<Agent>
  <Agent.AddDir path={repository_api} />
  <Prompt>Review the API repository.</Prompt>

  <Agent.AddDir path={repository_sdk} />
  <Prompt>Compare the API and SDK.</Prompt>
</Agent>
```

It is invalid outside Agent. No first directory is special. Registrations are
sequential and may occur between Prompts. A provider incapable of updating the
same session with the complete ordered directory set fails; XMD neither starts
a replacement session nor reconstructs one from transcript.

ACP `additionalDirectories` is the complete ordered list on session lifecycle
requests rather than an in-place add-directory RPC. An adapter accumulates the
list before first Prompt and later loads or resumes the same provider session
with the updated list only when the provider advertises that capability.

### 8.2 Agent configuration is ordinary composition

`workflow start` does not invisibly seed `.codex` or `.claude`. A reusable
component writes defaults explicitly:

```md
<DefaultAgents />
```

Those files are ordinary durable Workspace effects. The provider maps the run
root to its native configuration discovery boundary. Configuration required by
a session exists before session creation; active sessions need not reload later
changes. Configuration influences behavior but cannot raise host authority and
must contain no retained credentials.

### 8.3 Workflow Agent authority

Workflow Agents are mandatorily read-only. Enforcement has three layers:

1. the permission bridge allows only read/search operations and denies mutation;
2. the provider runs with its native read-only sandbox; and
3. registered Workspace paths are presented as read-only filesystem views.

`<ApproveAll>` and provider configuration cannot exceed that host ceiling. A
provider that cannot enforce it fails before Prompt execution. Provider caches
and session state may use separate writable storage that is never imported back
into the Workspace.

The authoritative SQLite Workspace is materialized to disposable ordinary
directories for native Agent inspection. A later Prompt receives a view of the
current logical root. The derived view has no sync-back or conflict-resolution
path and may be discarded and recreated.

### 8.4 Generated XMD

A Prompt may return an XMD fragment rather than an ad hoc file-operation schema.
The fragment is untrusted input: it carries data, never authorization. Only the
trusted workflow host installs the admission, and it does so by handing the
evaluator values it holds — never through a context, a registration, a document
prop or a component name.

#### Read-only observation admission

The host supplies the exact candidate source, the retained Workspace roots the
run has and which one is selected, an immutable allowlist of pinned
observation-only component identities, and the exact requests each of those may
perform. Before the first effect, the evaluator:

- parses the complete source;
- walks every element and every element's content;
- resolves each admitted name to the exact pinned definition the host supplied,
  never to a component search path, a registration, or the workflow component
  bundle;
- refuses executable code blocks, expression props, interpolation that reads a
  binding, a result binding, and every component the host did not admit; and
- refuses a request that is malformed, or that does not normalize to one the
  host stated exactly.

A refusal ends the whole fragment. Its diagnostic names the construct class, and
so does what the run retains of it, so a rejected fragment publishes nothing —
including a credential a rejected element carried. A malformed request is
refused on the same terms as an unadmitted one: the ordinary component reports a
bad URL, header or timeout by quoting it, and a generated request may not be
quoted anywhere. The host's own ceilings are a different kind of value —
normalized before the admission, and reported as themselves when the host
states one it cannot mean.

Admission is the line. Before it nothing of the candidate is retained; after it
the exact source is retained deliberately, so an ordinary expansion diagnostic
naming part of the fragment discloses nothing the journal does not already
hold.

One ordinary durable `generated_xmd` event records the decision. An admission
carries the exact source, the retained roots and the selected one, the pinned
identities the fragment named, and the normalized request policy it ran under; a
refusal carries the construct class and nothing else. The whole event crosses
the journal's secret filter like any other, and it commits before the first
admitted observation. The observations themselves are retained by their ordinary
effects — `fetch` for `<Fetch>` (§10.1) — so a partial continuation restores the
admission and every committed observation rather than performing them again, and
a completed replay restores the run's result without asking the Agent or a
server anything.

An interruption before an observation's own record commits retains no partial
observation; a later continuation may perform that read once more under the same
retained admission.

#### A continuation is held to the ceilings it was admitted under

A retained admission is a grant, and it resumes only under the ceilings it was
granted with. Durable replay matches an effect by its type and name, and what a
description carries is stored rather than compared, so the normalized policy is
retained in the admission's own result. Before one generated component is
invoked or one request is performed, a continuation compares the retained policy
to the one the run now states — whole and exactly. Changed retained roots, a
changed selected root, a changed pinned identity behind an unchanged name, and a
widened or otherwise altered request ceiling are each refused, with a fixed
diagnostic that names none of what it compared.

The fragment is decided inside that durable effect rather than before it. So a
continuation restores what was admitted without parsing the current candidate at
all: a later caller holding different source changes nothing about what expands,
and what expands is the source this run admitted.

`Fetch` is admitted only as core's pinned identity, and only for an exact
bounded request: the scheme, host, path, method, normalized headers and
effective timeout must all equal one the host stated. Anything else is refused
before `API.Fetch` is reached, with no request performed. A repository component
that takes the name `Fetch` is not the pinned identity and satisfies no
admission.

Ownership splits at the same line everywhere else does. Core owns parsing,
whole-fragment preflight, exact invocation, the durable admission record and
replay. The trusted workflow host owns the ceilings — which roots exist, which
identities are admitted, and which requests are allowed — because those are
decisions about what this run is for.

#### Mutation-proposal admission

Mutation admission extends the same boundary with a separate allowlist of pinned
mutation component identities, and is unbuilt. Admitted File, Git and Git-host
effects then execute through their ordinary contextual providers and durability
contracts; generated source receives no special mutation API. A mutation
proposal may be subject to authored supervision before admission, and admission
never implies unattended approval.

The allowlist is authority, not prompting guidance. Generated source cannot
grant itself Push, PullRequest, secrets or another external provider merely by
naming a component. Trusted reusable Markdown components may be admitted
explicitly; generated XMD admits none of them yet.

The live Agent request/result loop, `<Agent.AddDir>`, ACP `additionalDirectories`
and workflow-bundled Markdown component admission are also unbuilt.

### 8.5 Agent session continuity

The filtered workflow journal and provider-owned Agent session are separate
retained assets. The journal preserves observable prompts, responses, tool
events and outcomes for replay and training. It does not claim to reconstruct
provider-internal summaries, hidden context or tool state.

Each logical Agent session is identified by WorkflowRun and Agent/Session
expansion identity, independent of a materialized view's absolute path. The
retained mapping records provider and agent identity, provider session ID,
Workspace-relative primary directory and ordered registered-directory set.

Partial replay attaches lazily. Completed Prompts restore without contacting the
provider. Before a later live Prompt, the adapter resumes the same provider
session and maps its logical directories to the current read-only
materialization. A missing, corrupt or unresumable provider session fails; XMD
does not silently start another session or inject a transcript while claiming
conversation continuity. Full replay never attaches the provider.

## 9. Replay and continuation

Replay rehydrates the Effection tree. Ephemeral structure executes again;
durable observations and mutations restore.

| Construct | Partial replay behavior |
| --- | --- |
| implicit Workspace | reattach the same run-owned Workspace |
| bundled component import | restore the retained `{ kind: "workflow", path, sourceHash, content }` selection and reconstruct the component from that exact source, resolving no name and reading no file |
| lexical Dir/Repository/Worktree | reinstall contextual cwd and live facade |
| Agent provider/session | attach lazily before the first live Agent operation |
| Agent.AddDir | re-register in document order |
| Repository base/default resolution | restore pinned result |
| Repository/Worktree creation | restore the retained creation record, then reattach and verify the retained Git state without recloning |
| File read | restore historical content |
| File write/delete | restore completion without mutating again |
| Glob | restore historical path set |
| Prompt/Sample | restore response |
| suspension request | restore its filtered request; with no input, settle the new execution `suspended` and release the executor lock again |
| suspension answer | restore the delivered value without reaching the live controller and without consuming retained delivery state again |
| Git.Add/Switch/Commit | restore transactional result |
| Git.Push/PullRequest/Issue | restore the retained reconciliation record, or observe the Git host again under the same external identity and adopt only a proven compatible completion |

Reads restore historical values even when current frontier state differs.
Replay never uses a guard such as current file existence to infer whether an
earlier effect completed.

Reattaching a Repository or Worktree is ephemeral and happens on every partial
execution: it rebuilds the live checkout from the Workspace root the journal
selected and verifies that what is there is the checkout the record names.
Readable is not enough — a valid checkout of an unrelated repository is
perfectly readable — so the creation identity the record claims is read back out
of the checkout itself: the locator it was cloned from, the algorithm it names
objects with, and the presence of the commit it was created at. A Worktree
additionally proves that its checkout is a worktree of the retained Repository
it belongs to, rather than a repository of its own standing in its place.

What attachment deliberately does not require is that HEAD or the current branch
equal creation state. Those move, transactionally, when a Git effect moves them;
creation identity does not. Missing, damaged or conflicting retained state is a fatal
stale-input condition: children and later siblings do not begin, `<PrintErrors>`
cannot print it, and nothing is recloned or repaired.

Before any of that, a run closed over a component bundle reconstructs it: `resume`
reads every retained component from the retained commit and verifies each blob
against the retained source hash under the executor lock, before a
document-execution record is begun, before a Workspace is attached and before
anything is appended. The working tree and the current `HEAD` are not consulted.
The reconstructed bundle then holds the retained history to itself — a recorded
import naming a component the bundle does not declare, or holding a different
path, hash or source, appends nothing and invokes nothing.

A completed root result returns without expanding the document or attaching
Workspace, Agent or external providers. It still reconstructs the bundle and
still applies that admission, so retained output is accepted only for a history
this run is a run of.

A partial replay that reaches a completed Git-host effect may still reconstruct
what that effect needed locally — a Push rebuilds its checkout from the Workspace
in order to name the request it is asking about — and then hands back the
retained record without selecting a provider, contacting the host or appending
anything. The object-source attachment such a reconstruction produces is never
durable and never reaches routing middleware.

A suspended root has no Close and is partial history. Resume reconstructs only
the ephemeral structure reached on the path back to the request. Earlier
durable effects, including the request publication, restore without contacting
their providers. If input is still absent, no request or answer event is added;
the new document execution tears down and retains `suspended` again.

## 10. Effect transactions

### 10.1 Workspace-local effects

One local expansion produces one effect and one SQLite transaction:

```text
BEGIN
  apply local mutation
  publish logical Workspace root
  append filtered journal result
COMMIT
```

A crash commits all three or none. Nothing runs after a killed host dies — no
cleanup, no commit, no rollback — so the operating system closes its connection
and releases its locks, and the next connection recovers the database to the
last committed state, exposing neither the mutation, the root, the pointer
change nor the result. Another connection never sees them while that
transaction is uncommitted either. Nested child effects finish before the
parent's effect transaction begins. Direct filesystem operations and
declarative Git operations use this boundary.

### 10.2 Git-host effects

A **Git host** is an external service that owns remote Git repositories and
associated collaboration objects such as branches, pull requests and issues.
GitHub is one Git-host adapter. A Git host is distinct from the local Git
capability of §7 and from the trusted workflow host.

Prompt, Push, pull request and issue creation cannot place provider-owned state
in SQLite. Each derives one stable effect identity from run and expansion,
performs or observes the provider operation and commits one local result
transaction.

The three Git-host mutations — Push, pull-request creation and issue creation —
share one reconciliation of that boundary. `reconcileGitHostEffect(request)` is
the state machine each runs through, so a new Git-host effect kind supplies a
request and a provider rather than a replay policy of its own. Prompt is not one
of them: it derives identity the same way and commits its result the same way,
but it reaches the Agent provider under §8's own contract and is unchanged by
what follows.

A Git host need not implement every kind. A plain Git server may support Push
and support neither pull requests nor issues; it says so from observation,
before any remote work, and the boundary refuses that effect without performing
or recording anything. There is no capability discovery and no negotiation:
routing selects among installed adapters, and an unsupported kind is a refusal
like any other.

**The request.** Identity is the run ID and the expansion ID, derived by the
shared operation. Neither the document nor the provider supplies either member.
The effect supplies a non-empty `kind`, JSON `inputs` and a JSON `naturalKey` —
what the provider looks the effect up by when no local result exists.
Credentials are not inputs and stay inside the provider. The durable operation
is journaled under the type `git_host_effect` and named by a SHA-256 fingerprint
of the complete detached request, so a changed kind, input or natural key
diverges rather than consuming the result retained at the same journal position.
There is no schema change, migration or compatibility reader: the filtered Yield
is the local record.

**The decision.** One live attempt observes before it mutates:

```text
definitely absent        → perform, once
definitely compatible    → adopt the observed result
conflicting              → fail
permanently ambiguous    → fail; never duplicate
temporarily unobservable → fail as itself; explicit middleware may retry or suspend
```

Proven absence is the only state that performs, and one attempt performs at most
once. Temporary unavailability is neither absence nor conflict, and never
authorizes a mutation: a later explicit attempt starts again at observation.

**The record.** A decision publishes one journal result holding the request, the
normalized pre-state, the normalized observations, the decision — `adopted` or
`performed` — and the normalized result. Replaying it contacts no provider and
installs none, and the retained record is parsed and compared with the request
being made before it is accepted. Conflict, permanent ambiguity and temporary
unavailability publish the same effect's failed result and replay as the same
fixed local failure, rebuilt from its closed name rather than recognized across
loaded copies.

**Routing.** There is exactly one contextual operation,
`executablemd.workflow.git-host`, and it routes. It is request-only: public
middleware receives one frozen, one-use routing request describing the complete
detached request, may read it, refuse by throwing, install narrower policy, or
delegate that exact request, and the value it returns is ignored. It receives no
credential, no capability, no answer operation and no phase evidence.

There is one surface rather than two on purpose. A design that selected a
provider on one surface and coordinated the invocation on a second let public
middleware read a credential from the first, take an invocation capability from
the second, and answer a phase itself — and the journal then retained a
completion no provider had produced. Two individually harmless public surfaces
composed into completion authority, so there is now nothing to compose.

**Who may author an outcome.** Only an answer the invocation's own terminal
accepted. Each phase builds its own API descriptor under that same stable name:
sharing the name shares the middleware chain, while owning the descriptor owns
the default, and that default is the terminal. The selected provider's handler
is installed at the terminal end of the chain, so its own continuation is the
only route to it; through that continuation the handler has the terminal inspect
the exact request, calls the provider, and submits the answer, which the
terminal parses before recording. A short circuit, a forged return, a
substituted or replayed request, a look-alike private message and a
reconstruction of the stable name all reach the provider's handler or the public
refusing default, and complete nothing. A throw after an accepted answer cannot
replace it.

A conflict, an ambiguity or an unavailability so accepted is the effect's
recorded failure. Everything else that can raise on the way — routing
middleware, the provider handler, the provider's own body, an unsupported effect
kind — is the boundary failing: it publishes nothing, activates the run's
fail-stop fence, and is reported as one fixed cause-free failure that repeats no
message, payload, cause or stack from whatever raised it. Which of the two a
raised failure is, is decided by the attempt's own record of what it authored,
by object identity, never by a name or a class received from replaceable code —
otherwise a routing handler could raise a conflict and retire the effect as
conflicted without a Git host ever being asked. Fail-stop rather than a bare
refusal, because a live operation that appended nothing would leave the next one
to append at its journal position. A malformed value actually submitted to the
terminal remains the distinct local protocol failure, which likewise publishes
nothing.

**What the provider may be given that the request does not carry.** A Git-host
effect sometimes needs live local access the frozen request cannot describe. A
Push needs the Git objects its commit is made of, and the destination it is
authorized to reach. Both travel as an **object-source attachment**: adapter-private
composition data the trusted host builds for exactly one reconciliation, holds in
the selected provider's own closure, and disposes with that invocation.

An attachment is authenticated against the retained identity it belongs to
before it exists — the observed Repository record is compared with the retained
row member for member, every retained row is held to the identity naming it, and
the exported checkout is proven to be the one that record claims. What it grants
access to is authenticated too, and separately: the local state behind an
attachment can name further state, so the graph a provider could traverse through
it is proven contained before the attachment is first used. That proof is the
live provider's first act and happens on no other path — a completed replay
reaches no provider, so it derives and parses its retained record without
performing it. A graph that leaves what the run authenticated is a boundary
failure like any other: it publishes no outcome, exposes no authored path, and
activates fail-stop.

An attachment is never a durable input, never part of the natural key, and never
visible to routing: the public surface carries the frozen JSON request and
nothing else, so no middleware receives a locator, a host path, a credential, an
object database or a function.

**No transaction spans the Workspace and the host.** The Workspace transaction a
Git-host effect opens is read-only and is closed before the host is observed, so
a network round trip never holds the run's database. Nothing is claimed across
the two: the local record commits on its own, and reconciliation — not a
distributed transaction — is what makes an interrupted attempt reach the host
once.

**Cancellation.** Cancellation tears down the provider call, publishes no
invented completion, and is never reported as Git-host unavailability.

**The journal.** Every description and result crosses the existing
pre-persistence secret filter. There is no side journal, table, raw provider
log, payload cache or alternate persistence route, and no schema change: the
filtered Yield is the local record.

No separate local `started` and `completed` journal protocol is required. A
missing result causes reconciliation under the same deterministic identity.

### 10.3 Worker Shell

Worker Shell means Cloudflare's Workspace Shell capability implemented by
`just-bash`, Cloudflare's Workspace filesystem adapter and a Deno Worker
availability boundary. It is neither native Bash nor native process execution.

Worker Shell belongs to the first production capability set. One invocation
owns one effect identity, one immediate SQLite transaction and one
`shell_mutations` savepoint. DOFS operations use nested savepoints inside that
caller-owned transaction.

Successful zero-status execution releases `shell_mutations`, appends the
already-filtered successful result and commits. Nonzero exit, interpreter
error, timeout, cancellation or Worker termination rolls back
`shell_mutations`, appends one failed result in the same outer transaction and
commits. A host crash rolls back the still-open transaction and leaves neither
published filesystem mutations nor a result event.

Every filesystem request carries the effect ID and a per-invocation token. The
host refuses missing, foreign, cancelled, completed and stale or late requests.
Cancellation forcefully terminates a CPU-bound interpreter before publishing
the failed result; graceful shutdown that cannot regain control is
insufficient.

The capability exposes no host PATH, native execution or host filesystem.
Network is denied unless explicitly authorized. A committed result restores
without starting a Worker; an effect interrupted before commit executes again
against its pre-effect Workspace root.

## 11. History forks

Normal resume always uses the same immutable definition, normalized props,
journal and current Workspace frontier. Intentional definition changes create a
new run:

```sh
xmd workflow fork release-42 \
  --at=E17 \
  --id=release-42-corrected \
  flows/release.md \
  --props-release-channel=stable
```

The source run and `--at` select an inherited journal prefix and Workspace root.
The document supplies the new immutable definition. Generated `--props-*`
arguments follow the positionals, as they do for `start`: they are declared by
the document rather than by the command, so option parsing stops at the first
one and a positional written after it would not be read.

The new run inherits the source's retained normalized props by default. Explicit
generated `--props-*` arguments add or override values, property by property,
and the merged result is validated against the candidate definition before
anything is created — a property the source retained and the candidate does not
declare is refused here rather than reported later as divergence. Those merged
props are what the preflight replays under, what the fork is admitted with, what
the run retains, and one of the terms a reused fork ID is compared on.

Fork generates a new run ID unless `--id` is supplied, executes the new run in
the foreground and follows ordinary exit semantics. Every option that applies to
`start` and `resume` applies to `fork`; read-only commands accept neither props
nor `--at`.

### 11.1 What a fork retains

A fork is a new immutable WorkflowRun identity. It holds a new run ID, the
supplied definition with its base, pinned commit and complete component bundle,
the merged normalized props, its lineage, and a journal made of two records it
writes for itself followed by everything it inherited.

The two records are its own `workflow_run` and its own root import. The first is
what its journal is held to: a history carrying two run records describes two
runs, so the source's stays behind as lineage. The second holds the document's
own text, and replay restores the document from it — a fork that inherited the
source's root import would run the source's definition whatever document the
caller named.

Everything after them travels unchanged. An inherited event keeps its public
event ID, its filtered result, its authored source position and its Workspace
root reference, and carries the source run and source event it came from. Events
appended after the checkpoint are the fork's own and receive fork event IDs.
During compatibility replay and live execution `getWorkflowRun()` observes the
fork identity, never the source's.

The fork owns retention of what it inherited. The Workspace roots the prefix
names and the selected checkpoint root are copied into the fork's own storage,
so deleting the source after admission leaves the fork's history readable and
its roots loadable.

### 11.2 What compatibility means

Any definition or prop change that alters expansion before the checkpoint causes
divergence. A durable effect's identity is its type and its name, and an
authored effect's name carries where it was written — so a candidate is
compatible through the checkpoint only when the elements before it are written
at the same path and the same offsets. In practice that is the same document,
edited after the checkpoint.

Compatibility is decided before any storage the host would recognize as the new
run exists. The candidate replays the inherited prefix against a staged copy of
the fork — the whole run, assembled where nothing discovers it, so a document
resolves its paths through the Workspace the fork will actually have. The replay
ends at the checkpoint: a guard stops it on the last inherited event, before the
stored result is handed back, so the first effect after the checkpoint is never
entered, no host service is reached and nothing is appended. A candidate that
diverges, that finishes before consuming the prefix, or that goes live inside it
is refused, and the refusal names the inherited event where the disagreement
began.

### 11.3 Reading the source, and admitting the fork

Fork admission reads an immutable committed source snapshot ending at the
selected event. It does not acquire the source executor lock and never writes
the source run. Concurrent source appends after the selected checkpoint do not
alter the admitted prefix or root.

Before recognizable new-run storage exists, the source, the checkpoint, the
selected root, the candidate definition, the component bundle, the normalized
props, forkability and compatibility replay are all validated. Missing, corrupt,
unsupported or divergent input fails with no new run and no live effects.

After preflight succeeds, only the new run's executor authority is acquired. One
atomic durable commit records the fork run, its lineage, the inherited prefix
with its provenance, the copied Workspace roots, the selected current root and
the first document execution. Failure before that commit leaves no fork. Failure
or death after it leaves a valid fork under ordinary lifecycle and recovery
rules. Live document execution begins only after that commit.

Reusing a caller-selected fork ID is compatible only when the source run, the
checkpoint, the definition including its component bundle and pinned commit, the
base and the normalized props all agree. A request differing in any one of them
is refused before anything is written, and the refusal names the term that
differs rather than collapsing them into one cause.

### 11.4 What a fork never rewinds

Each completed journal event references the current copy-on-write logical
Workspace root. Nonmutating events reuse the previous root. Only committed
events are selectable checkpoints, and the run's own canonical outcome is not
one: a prefix that contains it leaves nothing to continue.

Fork never rewinds external systems, and it never repeats one either. What
decides an external effect is what the history holds about it.

A completed Git-host reconciliation record carries the pre-state, the
observations, the decision and the result, and replays without installing or
contacting a provider. A fork inherits it: the remote was mutated once, by the
source, exactly as the record says, and consuming the record asks nobody
anything. The record keeps the identity it was written under — a fork does not
rewrite an inherited event as its own — so the effect at that position is named
by the identity the record holds, while every live attempt is named by the run
performing it. That is what keeps the fork the authority for what it does next
without making it the author of what it inherited.

That identity is established once, when the engine admits the run's retained
snapshot, and published beside the run itself — where every physical copy of the
workflow package reads it. A second copy loaded from disk reconciles through the
same operation name, and a fork whose Git-host history replayed for one copy and
diverged for another would accept different history depending on which module
object asked.

What makes an answer safe is not where it came from but what happens to a wrong
one, and what authorizes live execution is not that answer at all. A run that walked away
from retained history it never consumed performs no Git-host effect at all: it
asks the Git host nothing and appends nothing. The engine's own account of the
coroutine decides that, and it holds for every operation after the one that
diverged rather than only at that one — so removing, replacing or forging the
transported identities cannot buy a live effect. It can only make the effect
replay correctly or refuse. On replay the record consumed is
additionally held to the request being made, so an identity that is not that
record's own is a refusal too.

It belongs to the exact retained event it came from, at the position that event
occupies. One element may ask for more than one Git-host effect, so the records
are offered in order: a call may take only the next one not yet taken, and only
when that record asks exactly what the call asks. Anything else leaves the
inherited prefix behind for good.

Falling through to live is final in the same way. A request named by a retained
record that reaches live execution — a mismatch earlier in the history, and a
divergence policy that chose to run live, are enough — performs nothing. It asks
the Git host nothing, appends nothing, and fails, because the run that may
perform it is the one this journal belongs to. An inherited identity therefore
never reaches an observation, a performance or an appended event.

A Git-host event that settled into no such record is the other case. The run
stopped without establishing what happened at the remote, so continuing across
it would mean asking a provider the question the source could not answer, and
the checkpoint is not forkable.

Agent conversation state is present only when the provider can fork or
checkpoint that exact session at the selected event. No supported provider can,
so a checkpoint at or after an Agent turn is not forkable; XMD never substitutes
a new session or transcript.

## 12. Retention, deletion and training

Every run status is retained by default. The local host has no automatic
expiration. A deployment may impose an external storage- or age-based policy.
Lexical scope cleanup releases live attachments but does not delete run-owned
state.

```sh
xmd workflow delete release-42
```

Delete targets one authorized run ID, accepts no wildcard and prompts for no
additional confirmation. It first acquires the executor lock. A live workflow
executor is refused; every status without one may be deleted, including a stale
`running` record after acquiring the executor lock proves staleness. The command
removes the local database and run-owned retained provider-session records, and
reports those categories. An empty advisory-lock sidecar may remain because it
is host arrangement rather than retained run state. An absent run is an error rather
than idempotent success. A host pruning operation may select explicit statuses
and ages. Documents cannot delete workflow runs.

Deletion does not undo pushes, pull requests or other remote effects. Forks and
retained runs keep the Workspace roots they reference; garbage collection may
remove an unreferenced historical root only after those references disappear.

The journal security policy filters arguments, results, errors and generated
XMD before insertion. Retention makes filtered history available for deliberate
training ingestion. It does not authorize ingestion of the database's arbitrary
filesystem content. Secrets remain ephemeral host-owned bindings and never
belong in retained Workspace configuration.

## 13. Local topology

The initial local host uses Deno-local SQLite with Cloudflare's DOFS layer for
the authoritative filesystem. It keeps journal and Workspace state together so
the provider can implement effect transactions. It requires no writable FUSE,
native subprocess bridge or bundled `workerd`.

One host-owned DOFS connection is authoritative for each workflow database, and
Workspace-local effect transactions execute serially on it. Worker JavaScript
is outside the initial local capability set; Worker Shell follows §10.3. A later
Cloudflare-hosted or workerd-backed provider may install the same Workspace and
lifecycle contracts; documents do not choose that topology.

The local lifecycle adapter owns a non-blocking exclusive advisory lock on one
deterministic sidecar per run. The open file belongs to the workflow executor's
scope and the operating system releases it when the process exits. The exact
in-process `ExecutorLock` is the private mutation capability. The lock file
is ephemeral host arrangement: it is neither SQLite schema nor run identity,
journal or history. No owner descriptor or cancellation-request file exists.

The same adapter owns a second, separate advisory lock: a waiting exclusive
lock on its own deterministic sidecar, which serializes the two callers that
act on a database and its rollback journal as a pair. Every write-capable
connection holds it for as long as it is open, because any read through it can
be the one that recovers a journal a later crash left; read-only inspection
holds it to copy a still-crashed pair, and therefore waits while this host has
such a connection open. Waiting is
cooperative rather than a blocking host call, so a cancellation and the owner
being waited for both keep making progress. It is not the executor lock, shares
no sidecar name with it, produces no capability and authorizes no transition.

Lifecycle settlement uses one compare-and-set SQLite transaction to finish the
document-execution record and publish the run status under the exact executor
lock. Inspection opens immutable snapshots and receives no executor lock or
writable database handle — including when it recovers a private copy of a
crashed run, which is read on read-only connections of its own and removed
before an answer is observable. History reads each existing
`workspace_root_id` with its event and does not invoke the Workspace
materializer.

The Deno provider's adapter-private proof operation already coordinates one
real DOFS mutation savepoint, immutable root publication and filtered durable
Yield in the caller-owned transaction. Replaceable Workspace context selects a
provider through a non-operational identity and never receives the
live executor, publisher, failure activator or journal provenance. The live
call retains those values in an execution-owned capability associated with a
same-named contextual invocation operation. This operation composes with a
provider installed by another loaded package copy without a module registry;
provider selection creates a one-use route and a separate credential, and the
terminal provider handler consumes that route before calling the credentialed
capability directly. Inspection, execution, publication, failure activation and
completion never traverse the contextual continuation, including at minimum
priority. The capability records completion only after the exact published
result returns from the provider. The durable operation resumes from that
record, never from a middleware-supplied response. Before opening the
transaction, the provider requires that capability's proof executor and journal
provenance to carry the selected WorkflowRun's exact provider-owned authority.
A trusted secret filter preserves that provenance explicitly at its wrapping
site; an ordinary guard does not. The transaction body calls the
execution-owned publisher directly
and cannot return until the exact Result has been appended and recorded. Its
supported filesystem calls use synchronous pinned DOFS primitives, leaving no
asynchronous continuation after mutation teardown. It distinguishes a documented filesystem
refusal from infrastructure failure and cancellation, and activates the durable
fail-stop fence for infrastructure failures. `<File>`, `<Glob>` and every other
`API.Files` operation route to it through the transaction-bound Files provider.
Workflow start, resume and the history commands do not reach it in this slice.

That boundary holds across processes as well as within one. A host killed
between the mutation and the commit publishes nothing, and a process that
opens the database afterwards finds the last committed filesystem, current
root, retained roots and ordered event-to-root associations. Reopening replays
recorded effects instead of performing them, and the adapter-private
materializer reconstructs an older event's root from that root's retained DOFS
manifests and blobs.

Native Git runs against directories, and the authoritative Workspace is a
database, so the Deno provider exports a checkout into a disposable host
materialization, runs Git there and imports the result back inside the same
effect transaction. **Native Git operates only on that export**, and what enforces that is a
distinction between two kinds of retained entry.

*Content* is what a commit records. A symbolic link among a checkout's tracked
files is content whatever it points at: it is retained and restored verbatim,
nothing resolves it, and a target outside the Workspace makes it no less a
faithful copy of what Git produced.

*Git's control plane* is the small set of entries that decide which repository
native Git is operating on — a checkout's `.git`, the `.git/worktrees`
administration, each slot within it, and the `gitdir` pointers a linked worktree
is made of. The operating system resolves these before Git reports anything
about them, so indirection here is not data: a `.git` linked to a compatible
external repository answers every identity question in §9 correctly while every
command runs outside the export, and a relative or traversal-shaped pointer
reaches an administration directory outside it with no link at all. Reading
`.git/worktrees` to discover pointers is itself a write, because localization
writes back to what it found.

The control plane is therefore validated rather than trusted. A checkout root
and a `.git` must be real directories, a linked worktree's `.git` a real regular
file, each administration slot and pointer a real entry of its own kind, and
every retained pointer value must name one place beneath the Workspace root —
relative, empty, dot-segmented and traversal-shaped values are refused rather
than resolved. The pointers of an exported pair must name each other. All of it
is decided before any administration path is rewritten and before any Git
command runs, because both are what would otherwise trust it, and any violation
is fatal stale retained state: nothing is repaired, recloned or adopted. Bytes, modes and symbolic-link targets carry both ways. The
absolute paths Git writes into a linked worktree's administration are reduced to
Workspace paths before capture and reconstructed only inside a live
materialization, so nothing retained is specific to the machine that created it.
Deleting a materialization costs time and nothing else. Git runs with a built
environment rather than an inherited one — no user configuration, no credential
helper, no terminal prompt, and a fixed workflow identity — so a clone does not
vary with whoever ran the host. The narrower retention invariant is about paths:
a provider-generated disposable materialization path is never retained, and
never accepted as a control path. Content is retained as Git produced it,
including absolute symbolic-link targets a commit happens to record.

SQLite is a host implementation detail. The CLI deliberately exposes no remote
host-selection option yet, while retaining a control surface that can be
delegated without changing the document language.

## 14. Contract inventory

| Contract | Status at this design revision |
| --- | --- |
| workflow-run and expansion identity | built by #289 / PR #341 |
| retained run record and filtered journal | built by #291 |
| caller-owned storage transaction | built by #291; Workspace mutations join it in #365 |
| provider-backed retained Workspace | document filesystem built by #366 and repository composition by #293; process capabilities unbuilt (#218) |
| `xmd workflow start` / `resume` | built by #366, Deno entrypoints only; both acquire #367's executor lock |
| `<Repository>`, `<Worktree>` and `<Dir>` composition | built by #293, Deno provider only |
| transactional Git components (`Git.Switch`, `Git.Add`, `Git.Commit`) | built by #294, Deno provider only |
| lifecycle status/list/history | built by #367 |
| lifecycle cancel/delete and executor lock | built by #367 |
| durable suspension request and executor-lock release | built by #367 |
| `xmd workflow answer` and the `suspension_answer` effect | built by #300 |
| workflow scheduling (watchers, unattended iteration, remote hosts) | blocked on #301 |
| history fork | built (§11); Deno provider only |
| read-only Agent materialization | defined here; proof required |
| generated-XMD observation admission | built by #369, through `@executablemd/core/host`; the workflow policy wrapper is internal |
| generated-XMD mutation-proposal admission | defined here; unbuilt (#369 slice 2) |
| Deno-local DOFS persistence | POC proven by #349 / PR #350 |
| scoped Deno Worker Shell | containment proven by #351 / PR #353 and transactions by #357 / PR #362; production integration unbuilt |
| Worker JavaScript | deferred |
| bundled workerd local host | omitted; POC #347 / PR #348 retained as provider evidence |
