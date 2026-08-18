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
| `suspended` | the workflow reached a deliberate durable wait | continues when the awaited input is available |
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

Issue #300 owns typed input delivery and scheduling. Its public correlation
boundary is the retained suspension ID and response schema. A validated answer
is not consumed until a separate durable answer event commits; a crash before
that commit leaves it eligible for the same request. Duplicate, late and
wrong-request delivery is refused. This suspension and executor-lock-release
contract folds issue #322 into #367; #322 is not a separate implementation
prerequisite.

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
caller can run today is `start` and `resume`, the three inspections, and the two
control actions:

```sh
xmd workflow start [--id=<run-id>] [--props-*=…] <definition>
xmd workflow resume <run-id>
xmd workflow status <run-id> [--json]
xmd workflow list [--status=<status>] [--json]
xmd workflow history <run-id> [--json]
xmd workflow cancel <run-id>
xmd workflow delete <run-id>
```

`cancel` and `delete` take the executor lock before they change anything, which
is what makes them safe to offer at all: a live workflow executor holds that
lock, and both refuse it rather than reaching past it (§3.6). Each
reports one line on standard output — `workflow cancel: <run-id> (<status>)` and
`workflow delete: <run-id> (<removed>)`.

`start` and `resume` stream the document's own output to standard output and
report two stable lines on standard error — `workflow run: <run-id>` once the run
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
- The document filesystem (§10.1) and Repository/Worktree/Dir composition (§6)
  are the capabilities a run has. Git operations, Agent, Worker Shell and native
  services are not: an inherited `API.Service` provider is refused rather than
  delegated to, and `temporaryDirectory` is refused rather than answered with a
  host directory.
- A function-component root is not supported in this subset and fails before the
  run executes.
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
than something inferred from a status column. Durable suspension is designed
above and unbuilt, and so is fork.

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
timestamps, document executions, current journal frontier and current Workspace
version. `list` reports visible runs newest-update first and optionally filters
by status. `status` and `history` require exactly one run ID; `list` accepts
none. A filter names exactly one of the six statuses. Fork ancestry belongs to
#368.

Both commands use immutable lifecycle snapshots. They do not obtain an executor
lock, replay, attach a Workspace, materialize a root, import a document,
contact an Agent, process or external provider, reconcile an effect, or append.
Human output is the default; `--json` returns the same data structurally.

`list` discovers the run-storage root directly; no registry can disagree with
it. Each run contributes one database candidate. Exact advisory-lock sidecars
use a distinct provider-owned namespace and are not candidates. Every database
candidate receives strict read-only recognition. A
foreign, incompatible, damaged or unparseable candidate fails the request and
is reported distinctly. The command does not return the healthy subset as
though it were complete, and it changes no candidate.

### 4.2 History

```sh
xmd workflow history release-1.4
xmd workflow history release-1.4 --forkable
xmd workflow history release-1.4 --json
```

`history --json` exposes every retained protocol event in append order and its
stable public event ID. `fork --at` later accepts eligible IDs under §11. Human
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
Workspace root associated with that row, and an optional normalized authored
source. Yield descriptions carry it under the stable namespaced
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
`--forkable` and forkability reasons belong to #368 rather than #367.

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
object ID and the repository-relative root document path. A repository locator
is not part of it. Where the definition can be fetched from, and where it is
checked out on one machine, are retrieval metadata: replaceable, free of
credentials, reauthorized by the host before use, and excluded from the
comparison that decides whether a reused run ID addresses the same run.

Compatible reuse compares the run ID, the whole descriptor including its
version, the base and the normalized props, canonically. Status, stop reason,
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

### 7.3 Commit

```md
<Git.Commit message={commitMessage} as="commit">
  <Git.Add paths="release/notes.md" />

Generated from validated release metadata.
</Git.Commit>
```

Commit expands its children before beginning its own effect, allowing nested
operations to prepare and stage state. With only `message`, that string is the
complete message. With only children, their rendered text is the message. With
both, `message` is the first paragraph and non-empty rendered child text follows
after one blank line. The combined message must be non-empty.

Commit writes only the staged index, fails when nothing is staged and returns
the full SHA through `as`. It has no `paths`, implicit staging, `allowEmpty`,
`amend`, signing, author or force controls initially. Git identity comes from
the Workspace provider. The Git object, ref/index mutation and SHA journal
result commit in one effect transaction.

### 7.4 Push

`<Git.Push />` has no props or result initially. It requires a current named
branch, pushes it to the Repository's primary remote and establishes upstream
tracking when necessary. The same remote commit is compatible completion.
Remote divergence fails; Push never force-pushes.

Push is explicit. Neither Commit nor PullRequest publishes implicitly.

### 7.5 Pull request

```md
<PullRequest
  title="Prepare release 1.4"
  base="main"
  draft={true}
  as="pullRequest"
>
Prepared from commit {commit}.
</PullRequest>
```

`title` is required. `base` defaults to the Repository's recorded initial
branch, `draft` defaults to false and rendered children form the body. The
contextual Repository selects the forge provider; its current named branch is
head and must exist remotely at the current local commit. PullRequest never
pushes. It returns the request URL through `as`.

There are initially no repository, head, provider, label, reviewer, merge or
implicit-push controls. Uncertain creation adopts only one compatible request
identified by stable effect provenance and head/base identity. It never rewrites
or adopts an unrelated incompatible request.

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

A Prompt may return an XMD fragment rather than an ad hoc file-operation schema:

```md
<Agent>
  <Agent.AddDir path={repository_api} />

  <Prompt as="changes">
Inspect the repository and return only an Executable.md fragment that performs
the required changes.
  </Prompt>
</Agent>

<Expand
  source={changes}
  allow={["Dir", "File", "DeleteFile", "Git.Add"]}
/>
```

The generated fragment is untrusted. Before its first effect, the evaluator:

- parses the complete source;
- resolves its allowlist to pinned component identities supplied by the trusted
  parent definition;
- refuses every component outside that set;
- refuses eval/exec code blocks, imports, native execution and arbitrary
  JavaScript expressions initially; and
- applies normal Workspace path authorization.

The Prompt response and exact filtered generated source are retained. Admitted
components then expand normally, each with its own effect identity and
transaction. Replay restores the response and expands the same source without
calling the Agent again.

The allowlist is authority, not prompting guidance. Generated source cannot
grant itself Push, PullRequest, secrets or another external provider merely by
naming a component. Trusted reusable Markdown components may be admitted
explicitly.

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
| Git.Add/Switch/Commit | restore transactional result |
| Git.Push/PullRequest | restore or reconcile stable external identity |

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

A completed root result returns without expanding the document or attaching
Workspace, Agent or external providers.

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

### 10.2 External effects

Prompt, Push and PullRequest cannot place provider-owned state in SQLite. Each
derives one stable effect identity from run and expansion, performs or observes
the provider operation and commits one local result transaction.

After interruption:

```text
definitely absent        → perform
definitely compatible    → adopt result
temporarily unobservable → explicit middleware may retry or suspend
conflicting              → fail
permanently ambiguous    → fail; never duplicate
```

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
  --props-release-channel=stable \
  corrected-release.md
```

The source run and `--at` select an inherited journal prefix and Workspace root.
The document supplies the new immutable definition. The new run inherits source
props by default; generated `--props-*` arguments may add or override values.
Any definition or prop change that alters expansion before the checkpoint
causes divergence.

Fork generates a new run ID unless `--id` is supplied, executes the new run in
the foreground and follows ordinary exit semantics. Reusing a caller-selected
fork ID is compatible only when source run, checkpoint, modified definition and
normalized props all agree.

Each completed journal event references the current copy-on-write logical
Workspace root. Nonmutating events reuse the previous root. Only committed
events are selectable checkpoints. Fork retains or cheaply clones the selected
root without copying the whole database.

Fork never rewinds external systems. Agent conversation state is present only
when the provider can fork or checkpoint that exact session at the selected
event. Otherwise that checkpoint is not forkable; XMD never substitutes a new
session or transcript.

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

Lifecycle settlement uses one compare-and-set SQLite transaction to finish the
document-execution record and publish the run status under the exact executor
lock. Inspection opens immutable snapshots and receives no executor lock or
writable database handle. History reads each existing
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
| transactional Git components (`Git.Switch`, `Git.Add`, `Git.Commit`) | `Git.Switch` built by #294, Deno provider only; `Git.Add` and `Git.Commit` defined here, unbuilt (#294) |
| lifecycle status/list/history | built by #367 |
| lifecycle cancel/delete and executor lock | built by #367 |
| durable suspension request and executor-lock release | defined for #367; unbuilt; typed input delivery belongs to #300 |
| history fork | defined here; unbuilt (#368) |
| read-only Agent materialization | defined here; proof required |
| generated-XMD constrained evaluator | behavior defined; public name/schema open |
| Deno-local DOFS persistence | POC proven by #349 / PR #350 |
| scoped Deno Worker Shell | containment proven by #351 / PR #353 and transactions by #357 / PR #362; production integration unbuilt |
| Worker JavaScript | deferred |
| bundled workerd local host | omitted; POC #347 / PR #348 retained as provider evidence |
