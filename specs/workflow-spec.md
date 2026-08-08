# Specification: Workflow runs

* **Status:** Current
* **Scope:** `@executablemd/workflow` — associating a document execution with a
  workflow run whose starting repository state is pinned once, and retaining
  that run so another process can find it.

---

## 1. Overview

A **workflow run** is a workflow being carried out, with its progress and
outcome recorded durably. Document executions perform its work; the run itself
outlives any one of them.

A run has one starting repository state, chosen once. The host supplies a
**base** — any Git revision expression — and the run resolves it to a **pinned
commit** the first time it is created. A branch that moves afterwards does not
change what the run started from.

```ts
import { execute } from "@executablemd/core";
import { useWorkflow, getWorkflowRun } from "@executablemd/workflow";

yield* useWorkflow({ base: "main" });
const execution = yield* execute({ path: "./workflow.md", stream });
```

The package owns `WorkflowRun`, `useWorkflow()`, `getWorkflowRun()` and the Git
capability. It depends on `@executablemd/core`,
`@executablemd/durable-streams` and `@executablemd/runtime`, whose contextual
`exec()` and `cwd()` the Git provider invokes. Core never imports workflow or
Git, so ordinary `execute()` and `xmd run` stay Git-independent.

## 2. What a run is

```ts
interface WorkflowRun {
  readonly runId: string;
  readonly base: string;
  readonly pinnedCommit: string;
}
```

`runId` is opaque, allocated with cryptographic randomness, and supports
equality only. `base` is the revision expression the host supplied.
`pinnedCommit` is the full object id that base resolved to.

`getWorkflowRun()` answers with the frozen value for the document execution
running now. It is a context value under a stable name, so a descriptor built
independently — as a separately loaded copy of the package builds one — reads
the same binding, and by the same property a descendant may bind that name for
its own descendants. It is not an authority boundary: durable enforcement never
trusts it. Every call in one live execution answers with the same object; a
replay preserves the field values, never JavaScript object identity. It throws
outside a document execution associated with a run, and exposes no journal, Git,
workspace or continuation capability.

## 3. Where the run is installed

`useWorkflow({ base })` installs ordinary middleware in the scope that owns one
document execution, and does nothing else. **Installing it creates no workflow
run**; executing a document under it does.

The value is installed in the scope that owns the document execution, so every
descendant of the expansion reads it, output emitted after the durable run still
sees it, and ordinary teardown takes it away. It is not readable before
`execute()` and not readable after that execution completes, even while the
installing scope is still alive.

Concurrent runs are isolated by scope ownership: each document execution and its
middleware installation share one child scope. A later document execution —
including one continuing the same workflow run — gets a new child scope and a
new installation.

## 4. The three journal states

The journal decides which middleware does the work.

| State | What runs | What happens |
| --- | --- | --- |
| **live** — no record | `Execution.document` | allocates the run id, resolves the base through `Git.revParse()`, records one immutable value, and only then imports the root |
| **truncated** — record present, root not closed | the replay guard, then `Execution.document` | the guard restores the value; the durable operation still runs, so the journal cursor advances past its own entry |
| **completed** — root `Close` recorded | the replay guard only | the durable run returns the stored result without invoking the workflow, so the guard's check phase is the only place the run can be restored — or a different base refused |

The check phase runs before the recorded root result is returned. That ordering
is what lets a completed journal refuse a supplied base that disagrees with the
recorded one, rather than handing back a result the caller did not ask for.

Replay invokes neither run-id allocation nor `Git.revParse()`. The current value
of a moving branch is never consulted.

## 5. Refusals

The journal is parsed, never trusted.

- A record that does not describe a workflow run is refused. The stored value is
  described, never quoted: it is external data, and reporting it would carry
  whatever it held into logs and rendered output.
- A recorded base that differs from the supplied base is refused, naming both.

Both are `StaleInputError`: the journal no longer describes this run, and the
document is re-run from the start rather than resumed.

## 6. When a run exists

A workflow run exists once its `WorkflowRun` value is durably recorded. A
document failure or cancellation after that point does not erase it.

Failure *before* that point creates no run and expands no root document: Git
cannot be invoked, the working directory is not a Git repository, or the base
does not resolve to a commit.

Such a failure is journaled the way every durable effect's failure is — as a
recorded failed effect. Resuming the same journal therefore reproduces the
failure rather than retrying Git. No `WorkflowRun` value exists in either case,
which is what "records no workflow run" means.

## 7. The Git capability

```ts
interface GitApi {
  revParse(revision: string): Operation<string>;
}
```

`Git.revParse(revision)` has the semantics of

```sh
git rev-parse --verify --end-of-options <revision>
```

in the contextual working directory. `--verify` makes an unresolvable revision
an error rather than an echo; `--end-of-options` stops a revision that looks
like a flag from being read as one. The command is an array, so nothing is
parsed by a shell.

The default provider invokes the Git CLI through the contextual process and
working-directory Apis. A non-zero exit fails, reporting what Git said; a clean
exit naming nothing fails too, because an empty object id would pin a run to no
repository state at all.

Another provider replaces it lexically with
`Git.around({ *revParse(…) {…} }, { at: "min" })`. Providers install at `min` so
a nested replacement wins rather than being shadowed by an outer handler.

Workflow initialization calls it with `${base}^{commit}`, which is what makes
"does not resolve to a commit" an error rather than a tag object id.

## 8. Expansion identity is separate

A durable workflow effect that needs workflow-wide identity uses the run id and
the expansion id (§5.6 of the Executable MDX specification) together. Two
workflow runs may contain the same expansion id; the expansion id does not embed
the run id, and expansion identity works with no workflow middleware installed
at all.

## 9. Retained run storage

A run recorded only in the journal of the execution that created it can be
found only by whoever already has that journal. Retained storage is what lets
a second process open a run by its public id and continue from durable data.

Each run owns one database. Shared code reaches it through a contextual Api
that names no provider, so the lifecycle stays host-neutral:

```ts
interface WorkflowRunStorageApi {
  create(request: CreateWorkflowRunRequest): Operation<Result<WorkflowRunDatabase>>;
  lookup(runId: string): Operation<Result<WorkflowRunDatabase>>;
}
```

The default handler refuses. A run that appears to start and retains nothing
has not started, so a missing provider is reported immediately rather than
after an interruption. The Deno host installs its own with
`useWorkflowRunStorage({ root })` from `@executablemd/workflow/deno`, and that
entrypoint is the only place SQLite, run-id hashing, filesystem paths and host
behavior appear. Shared modules import none of them and detect no runtime.

A handle is a lease belonging to the scope that asked for it. Lease teardown
makes that handle unusable, and every later call answers with a closed-handle
failure rather than reopening the file. It does not close the run's physical
connection or invalidate another lease.

### 9.1 What identifies a run

Identity is the run id, the definition descriptor, the base and the normalized
props. Normalized props are a JSON object: a document declares named props, so
a run receives a mapping from those names to values, and a bare scalar or array
names nothing. The descriptor carries its own version, and takes part in the
comparison rather than governing it:

```ts
interface GitWorkflowDefinitionV1 {
  version: 1;
  kind: "git";
  objectFormat: "sha1" | "sha256";
  objectId: string;
  rootDocumentPath: string;
}
```

An object id is lowercase hexadecimal of the length its format requires, so two
hosts that agree about the commit agree about the run. A root document path is
an already-normalized repository-relative POSIX path: absolute paths,
backslashes, NULs, empty paths, empty segments and `.` or `..` segments are
refused rather than normalized, because two spellings of one path would
otherwise be two identities.

Where that object can be fetched from is deliberately not identity. A locator
and a local checkout path are **retrieval metadata** — replaceable, excluded
from the comparison, never containing credentials, and reauthorized by the host
before use. A run that moves between hosts is the same run.

### 9.2 Creating a run is also how it is found

`create()` answers with the stored run when the request describes it, and
refuses with a conflict when any immutable field differs. That is what makes a
caller-selected id usable twice — as a retry, or as a second process addressing
the same work — without a separate idempotency concept.

Props are compared canonically, so reordering a JSON object does not look like
asking for a different run. Everything a run accumulates is excluded: status,
stop reason, retrieval metadata, timestamps, document executions and journal
records all change while the run stays the run it was. A conflict names the
fields that differ and never the values behind them.

`lookup()` finds by id and creates nothing.

### 9.3 Finding a run without a registry

A run lives at the SHA-256 of its UTF-8 run id, directly beneath the authorized
storage root. Discovery is therefore arithmetic on the id, and no second
authority exists that could disagree with the files.

The root is absolute. A relative one names a different directory from a
different working directory, and where a run lives must not depend on where a
process happened to start; `~` is a shell convenience rather than a path and is
refused rather than expanded.

The root and the path it produces are host arrangement, not identity — which is
why the run id is also stored inside the database and checked against the one
that was asked for. A file at the right path holding a different run is a
collision or tampering, reported as its own failure and left unchanged.

### 9.4 What a run retains

- The immutable identity above.
- One of six statuses: `running`, `suspended`, `interrupted`, `completed`,
  `failed`, `cancelled`. Which transitions are legal is lifecycle policy and is
  decided elsewhere.
- A nullable **stop reason**: either `{ kind: "host", code }`, a categorical
  code the host assigns, or `{ kind: "journal", eventId }`, a reference to an
  event that already crossed the secret filter. Neither shape can carry an
  arbitrary exception message, because a message retained this way would be
  history nothing had filtered. A journal reason names an event the run holds;
  one naming an event that is not there is refused, because a reason that
  refers to nothing is not a reason.
- One **document execution** record per start and per resume, each with an
  opaque id, a start time, and — once it ends — a stop time, stop status and
  stop reason. These are not attempts: an attempt is one execution of a retried
  operation or region and stays in the journal.
- Replaceable retrieval metadata, with a revision counting replacements since
  it was last cleared.
- The filtered journal.

Complete WorkflowRun schema version 1 also contains the pinned Cloudflare DOFS
version-5 tables and indexes, immutable Workspace-root tables, exact root-to-
manifest and root-to-blob reference tables, singleton current-root state, and a
non-null Workspace-root association on every journal event. XMD schema version
1, DOFS schema version 5 and Workspace-root format version 1 are independent
version domains.

A fresh database contains one content-addressed Workspace root whose canonical
manifest describes only `/` as a directory. Its retained manifest and blob
reference sets are empty, its current-root pointer names that root, and its DOFS
frontier contains only the corresponding root directory.

Every later retained root is a complete canonical filesystem checkpoint. Root
format 1 uses fixed-key-order UTF-8 JSON containing `/` and every reachable
absolute POSIX path sorted by UTF-8 bytes. Each entry records its kind, mode and
observable mtime; files also record size, their DOFS manifest identity and a
deterministic hardlink group when shared; symbolic links record their verbatim
target. Paths are not Unicode-normalized. Mutable DOFS inode numbers, revisions,
tombstones, caches and synchronization bookkeeping are not part of root
identity.

The lowercase root ID is SHA-256 over
`xmd-workspace-root\0v1\0 || canonical_manifest_bytes`. Reusing an ID requires
the stored format and bytes to be identical. File bytes remain only in DOFS
blobs. The normalized root-to-manifest and root-to-blob rows equal the exact
transitive content of each root and prevent that content from being deleted
while the root is retained.

### 9.5 The journal

`WorkflowRunDatabase.journal` is an ordinary `DurableStream`, so `durableRun`
reads and appends through the interface it already uses. A record is stored
exactly as `serializeDurableEvent` produced it and read back through
`parseDurableEvent`, so a replay reads the record the protocol wrote rather
than a re-encoding of it. Events replay in append order.

An event's opaque id is stored separately from its physical position. The id is
stable once written and is what a journal stop reason points at; the position
is what ordering uses and is not a public identifier.

Every journal row also names the retained Workspace root current when the row
is inserted. Existing non-Workspace appends use the canonical empty current
root and otherwise retain their established behavior.

Events arrive already filtered:

```text
DurableEvent → secret gate → journal append
```

Storage performs no filtering of its own — a second policy in a second place is
a second thing to keep in agreement with the first — and a gate that rejects or
is cancelled leaves no row at all.

### 9.6 One authoritative connection, one operation

The Deno provider maps each canonical workflow-run database path to one
authoritative entry. The entry owns one physical SQLite connection, one
Cloudflare DOFS database wrapper, one Workspace filesystem, one cooperative
connection queue and one synchronous savepoint allocator. It remains alive
until provider-scope teardown, after the provider's child scopes finish.
Different database paths have independent entries.

Opening existing storage performs structural recognition, retained-root and
content validation, the live/current comparison and the singleton run-row read
inside one explicit SQLite read transaction. Those dependent reads therefore
describe one committed version. Recognition does not mark the connection as a
caller-owned Workspace transaction and does not permit DOFS savepoints.

Operations through every lease on one entry are serialized, and each runs
inside a transaction. A caller that needs several statements published
together holds the transaction itself:

```ts
yield* database.transact(function* (transaction) {
  yield* transaction.journal.append(event);
});
```

Enlistment travels with the `transaction` object rather than with the database.
Work that never received one cannot join by accident, so an append happening
elsewhere waits for its own turn and commits on its own rather than being
rolled back with a failure it had nothing to do with. Appends made through the
transaction insert and nothing more; the transaction decides whether those rows
survive, and failure or cancellation rolls all of them back.

The body runs in a scope of its own, and nothing commits until that scope has
finished tearing down. Work the body started may still be unwinding when the
body returns, and that work's cleanup appends through the same transaction —
committing first would leave those appends to publish themselves, outside the
transaction that was meant to decide about them. The transaction is closed to
further appends before the commit rather than after it.

Turns are taken through the authoritative entry rather than per handle. Two
leases on one run share them, so a second lease waits cooperatively while the
first holds the connection instead of entering synchronous SQLite and stopping
the host. Contention between processes remains SQLite's own.

Cloudflare's synchronous transactions use uniquely named SQLite savepoints on
that same connection and only while XMD's caller-owned transaction is open.
DOFS does not begin, commit or roll back a top-level transaction.

Adapter-private root operations also run only inside this caller-owned
transaction. Capture traverses and validates the complete live DOFS frontier,
builds or reuses a canonical DOFS file manifest when ordered chunks do not yet
have one, retains the immutable root and exact reference sets, and optionally
sets it current. Read-only recognition never builds a manifest or changes
last-seen metadata. The supplied private Workspace body runs in an inner scope,
and final live/current validation waits for that scope's children and resources
to finish teardown.

Successful effect coordination finishes its mutation scope before capturing
the root. The provider-level coordinator that orders mutation teardown, root
capture and filtered journal publication is not part of this storage layer.

The private restoration materializer loads a fully validated retained root and
rebuilds directories, files, chunks, modes, mtimes, symbolic links and hardlink
relationships inside a nested savepoint. It establishes valid mutable revision
state, clears the authoritative DOFS resolution and blob caches, and requires a
read-only resnapshot to reproduce the selected root ID before the savepoint is
released. A failure restores the prior live frontier and current-root pointer.

Immutable roots are authoritative checkpoints and DOFS tables are the current
live materialization. Every retained root remains indefinitely. The production
closure neither exposes nor invokes Cloudflare garbage collection; root-aware
deletion and collection are separate lifecycle behavior.

A transaction opened inside another on the same database is refused rather than
nested, and so is an ordinary operation called from inside a body — that call
would otherwise wait for a transaction its own scope is holding open.

### 9.7 Refusals

Storage is parsed, never trusted, and each condition a caller can act on
differently is reported as itself:

| Condition | Meaning |
| --- | --- |
| not found | nothing is stored under this id |
| conflict | a run is stored under this id with different immutable identity |
| id mismatch | the database at this id's path stores a different run |
| format | the file is not a workflow-run database at all |
| schema version | the schema is a version this build does not implement |
| corrupt | SQLite cannot read the file, or it is not shaped as version 1 |
| record malformed | a stored row does not describe what its column claims |
| request | a value a caller supplied describes nothing storage can keep |
| transaction | a transaction cannot be started, continued or committed as asked |

Recognizing a database is not the same as reading its table names. Every
table's stored definition is compared with the definition this build creates,
so a missing column, a dropped constraint, and a table nobody declared are all
caught before a row reaches a parser that assumes they hold. A file whose
header says it is a version-1 workflow run and is not shaped like one is
**damage**: the file disagrees with itself. Format and version failures are
reserved for a file that belongs to something else, or to a version this build
has not learned.

A database is initialized only when it is pristine — no application id, no
schema version and not one object anybody created. A file carrying a version
but no tables, or tables belonging to something else, is not empty.

Complete version 1 is the first XMD schema. An XMD-identified database carrying
schema version zero is a partial initialization and is reported as corrupt. A
genuinely unsupported nonzero version remains a schema-version refusal.

Rows are held to what they mean and not only to their column types: a timestamp
is an instant, an identity is not the empty string, and props are an object.

Semantic recognition parses every retained root canonically, recomputes its ID
and exact manifest/blob reachability, validates every referenced manifest,
blob, byte payload and live chunk, and requires the read-only live snapshot to
equal the singleton current root. Malformed paths or topology, dangling or
cyclic dirents, invalid hardlinks, corrupt hashes or sizes, inexact references,
and a live/current mismatch are damage. Recognition performs no repair.

No message repeats a stored value — or a stored *name*. Props and journal
payloads are retained history, and a member name can carry a credential as
readily as a member value, so an unexpected member is refused without being
named and a path through unknown members is written `*`.

An incompatible or damaged database is described and left exactly as it was
found. Nothing initializes, migrates, truncates, deletes or replaces one, and a
lookup that finds nothing creates no file.

Version 1 reads and writes version 1. Unsupported versions are refused without
the file being touched; partial version-1 initialization is corruption and is
also left unchanged.

## 10. Intentionally excluded

Public `xmd workflow` lifecycle commands; lifecycle transition policy, executor
leases and stale-owner recovery; public Workspace mutation and filesystem
effects; provider-level atomic Workspace effect/journal publication; public
root selection, history checkpoints and forks; `<File>` integration;
workflow-owned worktrees; and deterministic Git and GitHub effects. Retained
roots and private restoration do not expose any of those behaviors.
