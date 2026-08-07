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

Only one executor owns a run. Another caller follows the active execution when
the host supports following or receives an already-running result. It never
executes the run concurrently.

The host validates namespace authority. There is no separate public
idempotency-key concept; every run-oriented command uses the public run ID.

### 3.4 Status vocabulary

The initial statuses are:

| Status | Meaning | `resume` |
| --- | --- | --- |
| `running` | one executor owns live execution | follows or reports active ownership |
| `suspended` | the workflow reached a deliberate durable wait | continues when the awaited input is available |
| `interrupted` | the executor disappeared outside an authored wait | allowed |
| `completed` | the root result completed | full replay only |
| `failed` | an uncaught failure escaped the root | refused |
| `cancelled` | a caller intentionally terminated the run | refused |

Expected transient recovery belongs in document middleware or an effect policy.
An uncaught root failure is terminal. Reusing its compatible ID replays the
retained failure rather than silently retrying it. A corrected document starts
a new run or an eligible history fork.

### 3.5 Suspension releases the executor

A durable suspension records its pending operation and Workspace frontier,
reports the run ID and reason on standard error and returns control to the
caller. The foreground process, Workspace attachment and Agent process need not
remain alive.

Pending input belongs to the suspending operation. For example, an Elicitation
provider records a schema-validated response. `resume` accepts neither
replacement root props nor an untyped generic answer. The host may schedule
resumption when input arrives, or a caller may invoke `resume`. If input remains
absent, execution reaches the same suspension and returns incomplete again.

### 3.6 Interruption and cancellation differ

Interrupting foreground execution, including with Ctrl-C, releases the current
executor and leaves the run `interrupted` and resumable.

```sh
xmd workflow cancel release-42
```

Explicit cancellation asks an active executor to stop and makes the run
terminal. It retains the journal and Workspace for inspection, training and an
eligible history fork. It does not undo completed local or external effects.

### 3.7 Exit status

Only foreground execution that reaches `completed` exits zero. Suspended,
failed, interrupted and cancelled executions have distinct nonzero outcomes so
shell automation cannot mistake an incomplete workflow for completion. Their
numeric assignments remain part of the CLI implementation contract.

Management commands report their own request. `workflow cancel <id>` exits zero
when cancellation succeeds even though the durable run status is `cancelled`.

### 3.8 The lifecycle is host-neutral

`start`, `resume`, `status`, `list`, `history`, `cancel`, `fork` and `delete`
form a provider-neutral control surface. The initial CLI exposes no remote-host
selector. The contract nevertheless contains no public SQLite access, local
process path or other assumption that prevents a later host from owning the
same run lifecycle remotely.

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
timestamps, current journal frontier, current Workspace version and fork
ancestry. `list` reports visible runs newest-update first and optionally filters
by status.

Both commands query retained metadata only. They do not replay, attach a
provider, reconcile an external effect or advance a run. Human output is the
default; `--json` returns the same data structurally.

### 4.2 History

```sh
xmd workflow history release-1.4
xmd workflow history release-1.4 --forkable
xmd workflow history release-1.4 --json
```

`history` exposes stable public event IDs that `fork --at` accepts:

```text
EVENT  OPERATION     ARGUMENTS                       RESULT      WORKSPACE  FORKABLE
E14    File          path="release/notes.md"         completed   V7         yes
E15    Agent.Prompt  prompt=<filtered>               <summary>   V7         no: provider has no checkpoint
E16    Git.Add       paths=["release/notes.md"]      completed   V8         yes
E17    Git.Commit    message="Prepare release 1.4"  6f21a9...   V9         yes
```

Each event includes its operation, source location, normalized evaluated
arguments, result or normalized error, completion phase, Workspace version and
forkability reason. Values come from the retained journal after its security
filter. Human output may summarize long values; JSON contains their full
filtered structured representation. History never reconstructs a filtered
value from the Workspace or provider and never mixes rendered stdout into the
trace.

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
Its lexical and self-closing path behavior matches Repository.

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
HEAD. Existing branches switch without reset; missing branches are created.
Compatible local changes may carry, changes Git would overwrite fail and a
branch checked out elsewhere fails. There are initially no path, detached,
force or discard controls. `<Git.Checkout>` remains absent until its broader
commit/path-restoration behavior has a distinct contract.

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
| File read | restore historical content |
| File write/delete | restore completion without mutating again |
| Glob | restore historical path set |
| Prompt/Sample | restore response |
| Git.Add/Switch/Commit | restore transactional result |
| Git.Push/PullRequest | restore or reconcile stable external identity |

Reads restore historical values even when current frontier state differs.
Replay never uses a guard such as current file existence to infer whether an
earlier effect completed.

A completed root result returns without expanding the document or attaching
Workspace, Agent or external providers.

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

A crash commits all three or none. Nested child effects finish before the
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

Delete targets one authorized run ID and removes its local database and
run-owned provider-session records. A host pruning operation may select explicit
statuses and ages. Documents cannot delete workflow runs.

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

SQLite is a host implementation detail. The CLI deliberately exposes no remote
host-selection option yet, while retaining a control surface that can be
delegated without changing the document language.

## 14. Contract inventory

| Contract | Status at this design revision |
| --- | --- |
| workflow-run and expansion identity | built by #289 / PR #341 |
| retained run record and filtered journal | built by #291 |
| caller-owned storage transaction | built by #291; Workspace mutations join it in #365 |
| provider-backed retained Workspace | defined here; unbuilt (#218) |
| Repository, Worktree and transactional Git components | defined here; unbuilt |
| lifecycle start/resume/status/history/fork/delete | defined here; unbuilt |
| read-only Agent materialization | defined here; proof required |
| generated-XMD constrained evaluator | behavior defined; public name/schema open |
| Deno-local DOFS persistence | POC proven by #349 / PR #350 |
| scoped Deno Worker Shell | containment proven by #351 / PR #353 and transactions by #357 / PR #362; production integration unbuilt |
| Worker JavaScript | deferred |
| bundled workerd local host | omitted; POC #347 / PR #348 retained as provider evidence |
