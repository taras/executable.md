# Specification: Workflow runs

* **Status:** Current
* **Scope:** `@executablemd/workflow` — associating a document execution with a
  workflow run whose starting repository state is pinned once, retaining that
  run so another process can find it, and giving that run's document its own
  transactional filesystem.

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
import { executeInstalled } from "@executablemd/core/host";
import { workflowInstallation, getWorkflowRun } from "@executablemd/workflow";

const execution = yield* executeInstalled(
  { path: "./workflow.md", stream },
  [workflowInstallation({ base: "main" })],
);
```

The package owns `WorkflowRun`, `workflowInstallation()`, `getWorkflowRun()` and the Git
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

## 3. Where the run is prepared

`workflowInstallation({ base })` returns an `ExecutionInstallation` — a value,
not an installation act. **Constructing it creates no workflow run**; executing
a document under it does. A trusted host passes it to `executeInstalled()`, and
the installation contributes exactly two things:

- **an admission**, which canonical core captures before any installation,
  middleware or document code exists and applies inside its own trusted journal
  read, on the retained snapshot every later phase consumes; and
- **a `prepare` hook** — a `DurablePreparation`, the trusted durable
  preparation canonical core invokes *inside the durable root*, after
  retained-history admission and before any public `Execution.document` policy,
  the root import and every authored effect.

No public middleware carries workflow-run authority. `Execution.execute`,
`Execution.document` and `ReplayGuard` handlers may observe, transform or refuse
what they are given; none of them can suppress the preparation, complete it, or
substitute a run for it.

The run is readable through `getWorkflowRun()` for the lifetime of the document
execution: every descendant of the expansion reads it, output emitted after the
durable run still sees it, and ordinary teardown takes it away. It is not
readable before the execution and not readable after it completes, even while
the host scope is still alive.

Concurrent runs are isolated by execution ownership: each execution gets its own
slot, so a host that passes the same installation value twice runs two
executions and neither sees the other's run.

### 3.1 Installing a run that already exists

A host that keeps runs in retained storage (§9) has decided what the run is
before anything executes: `create()` answered with the run id, and the
definition was established from a commit the host pinned. There is nothing left
for the execution to allocate or resolve, and a run id an execution invented
could not agree with the record storage already holds.

```ts
yield* executeInstalled(options, [retainedWorkflowInstallation({ runId, base, pinnedCommit })]);
```

This installs the same middleware in the same place and records through the same
`workflow_run` durable operation. What differs is both ends of it. The live path
writes exactly the value it was given: no identifier is generated and
`Git.revParse()` is never called. And every journal state holds the record to
that value in full — run id, base and pinned commit — rather than to the base
alone.

A journal recording a different run is refused as `StaleInputError`, naming the
fields that differ and never their values: a run id may be caller-selected and a
base is any revision expression, so both are external text on the same terms as
retained props. A value installed without a run id, a base or a pinned commit
identifies no run and is refused before any document executes.

### 3.2 Where workflow-run identity is decided

**Workflow-run identity is execution-owned, and it is not middleware of any
kind.** `ReplayGuard` is composable policy by design: a handler installed
further out may answer without delegating. So is `Execution`: a handler
registered at the same position may rebuild the options a later one produced,
stream included. Identity decided from either place is identity decided by
registration order — a completed journal reached under a suppressing guard, or
under a handler that swapped the stream back, would hand its recorded root
result to whichever run asked.

An installation therefore contributes the *requirement* rather than a wrapper.
Its `admissions` say what a history has to satisfy; canonical core captures them
by value before any installation, middleware or document code exists, and
applies them inside the same trusted `readAll` that already holds a resumed run
to its recorded root selection. No wrapping site is added, nothing is reachable
through a context a document can rebind, and by the time any middleware runs the
read has already happened. It runs:

- before any public `ReplayGuard` check, admit or decide;
- before a recorded root `Close` can be reused;
- before live execution, Workspace mutation, or any append.

Public `ReplayGuard` handlers still observe the history this admits and may
still reject it. None of them can widen it.

Creating the run is separated from admitting the history for the same reason.
The installation's `prepare` hook is a `DurablePreparation` canonical core
captures by value at the same moment, and invokes inside the durable root —
after admission and before any public `Execution.document` policy, the root
import and every authored effect. A handler that answers without delegating
cannot get in front of it: by the time any document policy runs, the
`workflow_run` record is already in the journal, and a fabricated result is
refused by core rather than published.

The wrapper is a trusted wrapping site: it is installed before any document code
exists, delegates every append to the exact stream it was handed, and carries
that stream's journal-provenance witness onto itself without establishing one.

What a history is held to depends on the installation, and they differ in one
thing beyond which fields must agree.

`retainedWorkflowInstallation(run)` requires `runId`, `base` and `pinnedCommit` to match
exactly, and requires the record to be *there*: a host created the run before
anything executed, so a non-empty history carrying no successful record — none
at all, or only one that failed — is not this run's history.

`workflowInstallation({ base })` requires a recorded run's base to match, and requires
nothing to be present. It allocates its run on first execution, and §6 records a
base that would not resolve as a failed effect; a history whose only record is
that failure is this run's own, and refusing it would refuse a journal this run
wrote. Both installations refuse a history carrying more than one successful
record, and both refuse one that cannot be read.

A workflow definition may name an exact document target. That is part of what
the run is a run *of*, not part of what identifies it: run identity stays the
three members below, and a recorded value carrying a target as a fourth member
is refused as a value this version cannot account for.

A record identifies a run only when it is all of these at once:

- a Yield owned by the root coroutine;
- under the canonical effect type **and** the canonical effect name;
- successfully settled;
- holding a closed value of exactly `runId`, `base` and `pinnedCommit`, each a
  string; and
- in agreement with the identity the installation supplied.

An empty journal is the ordinary live start and is held to nothing. Otherwise a
history may carry **at most one** entry under the canonical run identity — the
record is written before the root document is imported, so a second entry
describes a second run, *however either of them settled*. Two successful
records, a successful one beside a failed one in either order, and two failed
ones are all refused. Under a retained installation the history must carry
exactly one, and it must have succeeded.

Malformed, carrying an extra member, written under another name, written by a
child coroutine, and naming another run are refused under either installation,
whether the history is truncated or completed. A single missing or failed record
is refused under a retained installation and permitted under a programmatic one,
for the reason above.

Reading a recorded value is total. A value whose enumeration, property
descriptors, getters or classification refuse describes no run, and becomes the
same fixed refusal every other unreadable record becomes — it never escapes
carrying its own text.

The history admission reads is the retained history: every discriminator settled
once, before anything is decided, and the same objects every later phase
consumes. An event that refuses any member a decision rests on — its type, its
coroutine, either half of its description, its settlement, or a successful
settlement's value — is a history this run cannot describe and is refused, never
stepped past as unrelated.

A refusal is a `StaleInputError` that names the fields that differ and never
their values, and the description it retains carries only the effect's type and
name — so nothing about the run, and nothing the journal held, is reachable on
the error object.

`getWorkflowRun()`, the three journal states and the lifetime rules above are
otherwise identical under either installation.

## 4. The three journal states

The journal decides which middleware does the work.

| State | What runs | What happens |
| --- | --- | --- |
| **live** — no record | the admission, then `prepare` | the admission finds nothing to hold the run to; preparation allocates the run id, resolves the base through `Git.revParse()`, records one immutable value, and only then is the root imported |
| **truncated** — record present, root not closed | the admission, then `prepare` | the admission restores the recorded value; preparation re-enters and its durable operation restores what it already recorded, so neither the identifier nor Git is reached again and the journal cursor still advances past its own entry |
| **completed** — root `Close` recorded | the admission only | canonical core returns the recorded result without entering the durable body, so preparation never runs and the admission is the only place the run is restored — or a disagreeing one refused |

The admission runs before the recorded root result is returned. That ordering is
what lets a completed journal refuse a supplied base that disagrees with the
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
recorded failed effect, and no `WorkflowRun` value exists, which is what
"records no workflow run" means.

Preparation fails before the root import, so the durable root records the
**bound pre-root terminal** canonical core writes at that position: a terminal
carrying core's own binding to the exact root source and target it was about.
Resuming that journal reports the recorded failure — it does not retry Git, does
not re-enter preparation, does not run document policy, imports no root, expands
nothing, and appends nothing. The workflow installation raises no objection to
it (§3.2).

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
connection or invalidate another lease. The provider keeps the association in
exact-object adapter-private state; the public handle contains no discoverable
SQLite or DOFS connection.

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
  targetPath?: string;
}
```

An object id is lowercase hexadecimal of the length its format requires, so two
hosts that agree about the commit agree about the run. A root document path is
an already-normalized repository-relative POSIX path: absolute paths,
backslashes, NULs, empty paths, empty segments and `.` or `..` segments are
refused rather than normalized, because two spellings of one path would
otherwise be two identities.

#### The document target a run is a run of

`targetPath` names one **document target** (executable-MDX §5.4) inside the root
document. Absent, the definition identifies the complete root document. Present,
it identifies exactly one section of it, and carries no leading `#`.

It is the **resolved exact canonical target**, never the selector a caller
wrote. A glob describes what somebody asked for; two callers may spell one
request differently, and re-resolving a glob against a different checkout can
name a different section. Only the resolved answer is stable enough to be
identity, which is the same routing-is-not-authority split the document layer
makes.

What counts as canonical is not restated here. A stored target has to satisfy
the same round trip an exact document target does — `isCanonicalDocumentTarget()`
from `@executablemd/core` is the one authority — so an empty target, an empty
hierarchy level, a leading `#`, a raw `#`, `*` or `**` anywhere in it, a
malformed or lowercase escape, a byte sequence that is not UTF-8, an NFD
spelling, and leading, trailing or uncollapsed whitespace are all refused.
Canonical escapes such as `%2A`, `%2F`, `%23` and `%25` are ordinary characters
inside a label and remain valid.

The member is closed like every other. Writing `targetPath` at all is what makes
it present, so an explicit `undefined` or `null` is a descriptor that asked for a
target and failed to name one — refused, rather than read as the whole document.
A failure is reported at `$.targetPath` in fixed wording that never echoes the
target it read, because a canonical target encodes heading text and heading text
is document content. Serialization writes the member only when there is one, and
stored identity is never normalized, decoded, repaired or re-encoded on the way
through.

`version` stays `1`. The five-member untargeted shape is the current
representation of a whole-document workflow rather than a legacy format being
preserved, so there is no second version, no version union, and no migration.

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

The exact target is compared with the rest of the descriptor. A run of one
section and a run of the whole document execute different content, and so do
runs of two different sections, so reusing one run id for the other reports a
`definition` conflict rather than finding the stored run. Absent compares equal
only to absent. The same exact target under the same id is the same run and is
found, which is what lets a targeted run be resumed.

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

Two sidecars share the root without being candidates for it. `<hash>.lock` is
the executor lock, and `<hash>.recovery.lock` is the coordination two owners of
a database-and-journal pair take turns on. Both are derived rather than
registered, both may be empty, and both may outlive the run they name. Neither
matches the `<hash>.sqlite` pattern discovery enumerates, so neither is ever
read, listed or mistaken for a run.

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

Each file entry's declared size equals the size in its referenced DOFS
manifest. Recognition checks that agreement for every file in every retained
root, including roots that are not current, while it validates the manifest's
chunks and blobs transitively.

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
DurableEvent → secret gate → Deno journal router → journal append
```

Storage performs no filtering of its own — a second policy in a second place is
a second thing to keep in agreement with the first — and a gate that rejects or
is cancelled leaves no row at all.

An unbound router append follows the ordinary standalone journal path and takes
its own serialized connection turn. Only a publication continuation may bind a
transaction destination, and that binding is lexical to the publication rather
than the operation's execution. The route validates the exact database lease,
connection generation, transaction identity, private token and open state
before delegating to the existing `transaction.journal`; it does not duplicate
insertion SQL. Missing, foreign, fabricated, completed, closed, cross-run and
stale authority reaches no SQL. A route for another WorkflowRun delegates to an
enclosing route instead of hiding it. The provider's ordinary destination and
each publication-local routed destination are terminal `{ at: "min" }`
handlers. An enclosing loaded copy with the same stable contextual name cannot
acknowledge an append before the provider either selects the ordinary path or
performs exact route validation. `readAll()` remains ordinary replay and neither
routes nor invokes the secret gate.

### 9.6 One authoritative connection, one operation

The Deno provider maps each canonical workflow-run database path to one
authoritative entry. The entry owns one physical SQLite connection, one
Cloudflare DOFS database wrapper, one Workspace filesystem, one cooperative
connection queue and one unified savepoint allocator. It remains alive
until provider-scope teardown, after the provider's child scopes finish.
Different database paths have independent entries.

The entry receives an opaque generation identity when it is created. Reopening
the same canonical path after provider teardown produces a different identity.
Every top-level transaction receives a separate opaque identity and an exact
active record containing its path, connection generation, open state,
authorized lease and transaction handle. The provider invalidates that record
before commit or rollback, so a retained handle or token never becomes valid
again in a later transaction.

Creating that physical connection takes recovery coordination, and holds it
until the connection closes. The opening performs one first read that touches a
page, which is what makes SQLite put back a rollback journal a lost host left
behind; the hold continues past it because any later read through the same
connection can be the one that meets a journal a process crashing afterwards
left. It is taken once per physical opening — never per transaction, lease or
effect — and a cached entry answers without taking anything, because the
connection it answers with already holds it. Closing and reopening a path is a
new physical opening and takes it again.

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

If a caller-owned transaction does not commit, its finalizer attempts top-level
SQLite rollback and then invalidates both the resolution and blob caches on the
authoritative DOFS wrapper before releasing the serialized connection turn.
The same cleanup covers body failure, cancellation during the body or child
teardown, final Workspace validation failure, and commit failure. Rolled-back
topology therefore cannot survive as a positive or negative cache entry.

The same monotonically unique allocator also owns operation-spanning
savepoints. An operation savepoint validates the exact active transaction
identity before SQL, runs its operation in a child scope, and waits for all
children and resources to tear down before release. An ordinary failure rolls
back to and releases only that savepoint, leaving the outer transaction free to
continue. Cancellation or halt invokes synchronous cleanup so no savepoint is
stranded. A savepoint creation, rollback, or release failure makes the outer
transaction uncommittable.

After `ROLLBACK TO` and `RELEASE` both succeed, the shared savepoint rollback
path invalidates the authoritative resolution and blob caches before the caller
may resume outer transaction work. This applies equally to operation savepoints
and synchronous DOFS savepoints. If rollback, release or cache invalidation
fails, the active transaction is poisoned and cannot commit; its top-level
rollback finalizer performs the separate outer-transaction invalidation above.

The active-path context chain remains structural refusal data: it detects that
an enclosing scope already holds a path, but never authorizes work. Adapter-
private contextual operations validate provider-owned exact identities instead.
Missing, foreign, fabricated, completed, closed and stale handles or tokens are
refused before SQLite is touched. A transaction on a different run neither
hides nor replaces the outer run's active record.

Adapter-private root operations also run only inside this caller-owned
transaction. Capture traverses and validates the complete live DOFS frontier,
builds or reuses a canonical DOFS file manifest when ordered chunks do not yet
have one, retains the immutable root and exact reference sets, and optionally
sets it current. Read-only recognition never builds a manifest or changes
last-seen metadata. The supplied private Workspace body runs in an inner scope,
and final live/current validation waits for that scope's children and resources
to finish teardown.

Structured durable operations accept an explicit provider-neutral live
coordinator. The default executes once, serializes execution success or failure
into the existing protocol `Result`, invokes the existing Yield publication
continuation exactly once, and returns that same result only after publication.
The continuation uses the durable stream's ordered append fence. A backing
append failure activates fail-stop state and raises `DurablePersistenceError`
with the adapter error as its cause; it writes no compensating `Close`, and
later durable work cannot execute or append even when workflow code catches the
failure. A marked pre-persistence policy rejection remains the policy's ordinary
failure. There is no generic durable validation hook: a caller or provider
validates before constructing the durable effect. Replay bypasses the
coordinator, execution, publication and live append; partial replay coordinates
only its live suffix. Cancellation cannot append or resolve late. The
callback-based durable-effect factory remains unchanged.

The shared Workspace operation wrapper explicitly reads a contextual provider
selection. The replaceable selection API carries no live-operation authority:
it receives no executor, publisher, failure activator or durable publication
identity. The live call retains those exact values behind an execution-owned
capability associated with a same-named contextual invocation operation.
Provider selection creates a one-use route and a separate opaque credential.
The contextual invocation carries the route and an execution-owned capability
but not its credential. A provider installed by another loaded package copy
terminally consumes the route and calls that capability directly. It never sends inspection, execution,
publication, failure activation or completion through `next`, so enclosing
middleware at either priority receives no operational phase. Provider selection
and invocation authority require no module registry and trust no replaceable
structural value.

The execution-owned capability permits one inspection, execution and
publication during its original live call. It records the exact result only after the
selected provider completes publication, and the durable operation resumes from
that record rather than from the contextual call's structural response. A
short-circuit, premature response or missing publication activates fail-stop;
middleware cannot transform an authoritative published result or turn a later
middleware exception into a different outcome. A foreign or substituted
selector and a reused, completed or stale invocation fail before the provider
opens a transaction. The default missing-provider path also fails before
execution or publication, and installing a provider does not enlist unrelated
durable operations.

Successful Workspace effect coordination finishes its mutation scope before
capturing the root. The Deno provider binds an adapter-private proof operation
to one exact WorkflowRun handle through module-private executor identity. It
establishes the canonical durable-stream module's journal provenance for that
run's journal and retains that exact witness. The generic pre-persistence guard
preserves nothing. Two trusted wrapping sites preserve the witness explicitly,
and a run's journal passes through both: the secret filter, and the
execution-owned target-admission wrapper core installs before any document code
exists. Nesting them carries the same witness through each. The provider
receives the invocation's exact executor identity and journal provenance from
its execution-owned capability and validates them before it opens the
caller-owned transaction. It refuses a foreign executor, foreign or absent
journal provenance, an ordinary guard, a custom wrapper, a copied property, or
a wrapper another loaded copy tried to prove, before transaction
work. It runs the mutation in one operation savepoint, waits for mutation child
teardown, captures and publishes the immutable root, and routes the
already-filtered Yield through that transaction's journal before commit. Its
publication operation calls the execution-owned publisher directly, so the
transaction body cannot return until the exact Result has been appended and
recorded as authoritative.

The adapter-private proof filesystem invokes the pinned synchronous DOFS
functions for its supported string and byte-array contract. It does not leave a
Promise, response body or stream pull capable of reaching the authoritative
connection after a cancelled mutation scope has torn down.

A documented filesystem refusal is an operation result only after its mutation
savepoint has rolled back successfully. It keeps the previous current root and
commits exactly one failed Yield against that root. Connection or authority,
savepoint, DOFS, schema, corruption, capture, current-root, routing, filtering,
serialization, insertion, teardown and commit failures instead roll back the
outer transaction and activate the durable run's first infrastructure failure.
That identity fences later coordinators, executors and appends. An already
active durability failure takes precedence. Cancellation at any phase publishes
nothing.

Losing the host is not one of those phases. Nothing runs after the process
dies: no cleanup, no commit, no rollback. The operating system closes the
connection and releases the locks it held, and the next connection to open the
database recovers it. The mutation, the immutable root, the current-root
pointer and the routed journal row have all been written inside the
caller-owned transaction by then; recovery exposes the last committed state and
none of them.

A second connection sees that same last committed state for as long as the
writer's transaction is uncommitted, so a crash publishes nothing that was not
already visible before it.

A later process therefore opens the last committed state and nothing else: the
same live filesystem, the same current root, the same retained roots, manifest
and blob references, and the same ordered journal with the same event
identities and Workspace-root associations. Recorded effects replay rather than
execute again, and the private restoration materializer reconstructs any
retained root from that state without the process that wrote it.

The provider-neutral coordinator receives the failure-activation continuation
needed for this boundary. The default live coordinator ignores it and preserves
ordinary success/failure publication. Replay bypasses coordination, and only an
explicit Workspace operation selects the Workspace coordinator. The
transaction-bound Files provider of §10 selects it for every document
filesystem effect; workflow start and resume do not reach it.

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
| inspection recovery | a crashed run could not be read from a private recovered copy |

Inspection recovery is a distinct condition because it says nothing about the
run. It reports that read-only inspection could not produce or clean up the
private copy it reads a crashed run from — the retained database and journal
are unchanged, and their next write-capable owner still recovers them. Damage a
recovered copy then reveals keeps its own condition above and is never folded
into this one. The refusal names the retained database; it names the private
copy as well, and only, when removing that copy failed and an operator has to
remove it by hand.

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
a file entry whose declared size differs from its referenced DOFS manifest, and
a live/current mismatch are damage. Recognition performs no repair.

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

## 10. The document filesystem of a run

A host attaches one run's Workspace to a document execution with
`withWorkflowWorkspace(database, operation)` from
`@executablemd/workflow/deno`. It installs three things together, inside the
execution rather than at an entrypoint, so they answer ahead of the host adapter
`xmd run` installs: the run's Workspace effect coordinator, the logical working
directory `/`, and the transaction-bound `API.Files` provider.

That composed helper is the whole of what the entrypoint publishes. The three
pieces are not installable separately, because the Files provider alone would
resolve a document's paths against whatever working directory the surrounding
host adapter answers with, and a host path resolved that way is what the run
then retains in the durable effects it replays from.

The filesystem a Workspace transaction hands its body is the provider's, decided
where the provider is installed and held in its closure. It is reached through no
context and no contextual Api, so a document cannot observe it and cannot put
anything in front of it — a stable name is composition, and composition is not
where authority belongs.

Paths are absolute POSIX paths inside the run's own filesystem. An authored path
is resolved by arithmetic on segments and handed to the run's DOFS filesystem;
no host path exists anywhere in it, so containment needs no stable-namespace
qualification. An empty path, an absolute path and a lexical escape are refused
with the vocabulary `API.Files` already has.

`readTextFile`, `writeTextFile` and `globFiles` are durable effects.
`checkFilePath` is not: it is lexical admission, it performs no effect, and it
appends nothing, so the write repeats the same admission from the same authored
path. Each effect's description is derived from the current expansion, the
operation and the resolved logical path, so one authored element is the same
effect across replays while an element edited to name another file is a
different one.

A search answers with sorted, deduplicated, POSIX-relative regular files, which
is the contract `API.Files` holds wherever it runs. A symbolic link is neither a
result nor a way into the tree it names, so a file reachable through a directory
link is reported once, under its own path.

One effect is one effect transaction. The mutation, the resulting immutable root
and the filtered journal result commit together. An ordinary filesystem refusal
rolls its mutation savepoint back before its result is published, so a write
that created two parent directories and was then refused leaves neither behind,
the retained outcome describes a Workspace that is exactly what it was, the
write reports its target as rolled back, and the next effect still commits. What
crosses the boundary is a `FilesReason` selected from the shared vocabulary — no
DOFS message, errno payload, SQLite text or resolved path. Everything that is
not a documented refusal stays an infrastructure failure and fails the run.

Replay restores the recorded outcome: it performs no mutation, opens no
transaction and consults no current state, which is what lets a read answer with
the bytes it read at the time and a create/delete/create history replay in
order. What it restores is parsed rather than believed. A record must carry its
variant's members and no others, each of the declared type, and a refusal's
phase and reason must both be words the operation's vocabulary holds. Anything
else describes no outcome, and becomes the one fixed cause-free provider
invariant — carrying nothing the record happened to hold, and performing no
further file effect.

`temporaryDirectory` is refused with the existing operation-denied failure. A
run has no host directory to hand out, and reaching the caller's would be the
uncontained filesystem this boundary exists to prevent.

## 11. Intentionally excluded

Public `xmd workflow` lifecycle commands; lifecycle transition policy, executor
leases and stale-owner recovery; public root selection, history checkpoints and
forks; workflow-owned worktrees; and deterministic Git and GitHub effects.
Retained roots and private restoration do not expose any of those behaviors.
