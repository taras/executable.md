# XMD Artifact Specification

- **Status:** Design contract
- **Audience:** Workflow lifecycle, storage, CLI and CI integration implementors

This specification defines the portable evidence form of an Executable Markdown
workflow run. An XMD artifact is one immutable `.xmd` file that can leave CI,
arrive on a developer machine and still describe the exact committed run that
CI observed. It complements `specs/workflow-workspace-spec.md`, which owns live
workflow execution and history forks, and `architecture.md`, which owns the
structural invariants.

The practical boundary is simple:

```text
CI live run ──export──> build-failure.xmd ──inspect──> same evidence
                                             └─fork──> new local live run
```

The artifact never becomes the CI run on the second machine. Inspection reads
the same bytes. Continuing creates a new run with explicit lineage.

## 1. User contract

### 1.1 Export one run

```sh
xmd workflow export run_01J... --output=build-failure.xmd
```

The command writes one XMD artifact containing the run's committed retained
state at one artifact frontier. It reports:

```text
workflow artifact: build-failure.xmd
workflow run: run_01J...
workflow frontier: 2b8e...
workflow artifact identity: 9f31...
workflow artifact sha256: 5a0d...
```

The artifact identity identifies the canonical semantics. The final SHA-256
identifies the exact bytes transferred. The latter can be published beside a CI
artifact or covered by a CI attestation.

`--output` is required, accepts a local path ending in `.xmd`, and never accepts
standard output. Export refuses an existing target rather than replacing it.
The completed file appears atomically: a failure or cancellation leaves no file
at the requested target. Provider-private temporary state is removed during
teardown; a cleanup failure is reported and does not claim a successful export.

### 1.2 Inspect the file anywhere

The existing inspection shapes accept either one retained run ID or one
explicit artifact path:

```sh
xmd workflow status --artifact=build-failure.xmd
xmd workflow status --artifact=build-failure.xmd --json
xmd workflow history --artifact=build-failure.xmd
xmd workflow history --artifact=build-failure.xmd --forkable
xmd workflow history --artifact=build-failure.xmd --json
```

The positional run ID and `--artifact` are mutually exclusive. `list` remains a
list of live retained runs and accepts no artifact: a directory of downloaded
files is not a run registry.

Artifact status and history expose the same semantic fields as their retained-run
forms, plus the artifact identity and artifact frontier. Human presentation may
name the artifact path. JSON never makes that host path part of identity.

Inspection opens the container read-only, executes no document, materializes no
Workspace, reads no definition from Git, contacts no Agent or external provider,
and writes no journal or lifecycle state. It gives the same answer when the file
is read from its CI output directory, copied to a laptop, or mounted read-only.

### 1.3 Continue by forking

An artifact is a source for the existing history-fork contract:

```sh
# Continue the exact embedded definition.
xmd workflow fork \
  --artifact=build-failure.xmd \
  --at=2b8e... \
  --id=local-investigation

# Continue under a modified definition from the current repository.
xmd workflow fork \
  --artifact=build-failure.xmd \
  --at=2b8e... \
  --id=local-fix \
  prepare-release.md \
  --props-debug=true
```

For an artifact source, the definition argument is optional. When absent, the
candidate definition is the artifact's workflow definition source closure. The
new run copies that closure into its retained definition state, so later resume
does not depend on the artifact path or on access to the original repository.
When present, the candidate definition is resolved normally and the source
run's normalized props remain the baseline under the workflow history-fork
contract.

The fork always receives a new run ID. It copies the inherited journal prefix,
the Workspace roots that prefix references, the selected current root, and the
definition state it needs. It shares no writable page, lock or provider-owned
directory with the artifact. Its lineage retains:

- the XMD artifact identity;
- the source run ID;
- the selected source event ID; and
- the selected Workspace root ID.

Inherited events retain their existing source-run and source-event provenance.
The artifact identity disambiguates two artifacts that claim the same source
run ID but contain different evidence.

## 2. Immutable evidence

### 2.1 An artifact is not a renamed run database

The live Deno run store and the first XMD artifact encoding both use SQLite, but
they have different contracts.

A live run database is writable provider state discovered from a run ID. It may
have executor and recovery sidecars, an unfinished rollback journal, cached
connections, and host-side provider-session state. Its schema is private to the
provider.

An XMD artifact is a separately constructed, immutable semantic export. It is
discovered only from the path the caller supplies. It has no sidecars, no live
connection identity and no location derived from its source run ID. Renaming or
copying it does not change its identity.

No command treats `.xmd` as execution authority. In particular, these forms do
not exist:

```text
xmd workflow resume --artifact=...
xmd workflow answer --artifact=...
xmd workflow cancel --artifact=...
xmd workflow delete --artifact=...
```

The absence is structural. Separate downloaded copies cannot coordinate a
single live identity through SQLite locking, so they never attempt to advance
one.

### 2.2 The artifact frontier

Export takes the source run's executor lock before it chooses the artifact
frontier. A live workflow executor therefore makes export refuse without
creating an output file. Once the lock is held, no workflow execution can append
or settle while the export is selecting its snapshot.

The frontier consists of one mutually consistent view of:

- workflow identity, definition, normalized props and retrieval-independent
  lineage;
- lifecycle status, stop reason and document-execution records;
- the complete filtered journal through its last committed event;
- every retained Workspace root and the current root association; and
- every other XMD-owned retained record referenced by that state.

The status may be `running` when the prior host died without settling. Export
does not repair or relabel it. If SQLite recovery is necessary, the provider
copies the database and rollback journal under inspection recovery coordination
and recovers only that private copy. The retained source remains unchanged.

Export performs no lifecycle transition, stale-execution settlement, replay,
external reconciliation or document execution. Releasing the executor lock
after export changes no retained state.

### 2.3 Complete XMD-owned state

The artifact contains all committed XMD-owned state needed to inspect the
frontier and attempt a compatible history fork:

- the immutable workflow-run identity and its prior fork lineage;
- the artifact frontier and lifecycle snapshot;
- the complete already-filtered journal, including event IDs, authored source,
  Workspace-root associations and inherited-event provenance;
- every Workspace root, manifest, retained file byte, mode, symbolic-link
  target, hardlink relationship and Repository/Worktree record the run retains;
- suspension requests, delivered answers and answer-consumption state;
- completed and interrupted external-effect requests, identities and filtered
  outcomes already retained by the workflow contract;
- workflow Agent session mappings and compatibility attributes already retained
  in the run database; and
- the workflow definition source closure.

“Complete” is bounded by XMD ownership. The artifact does not claim to capture
the state of the world around the run.

### 2.4 Definition source closure

The closure contains:

- the exact root Markdown bytes, repository-relative path, Git object format,
  pinned commit and root blob identity;
- the exact canonical document target, when one is selected; and
- every declared workflow component's name, canonical repository-relative path,
  blob identity and Markdown bytes, including a component the run never
  expanded.

Export authenticates every source against the immutable object identity in the
workflow definition. It may satisfy a source from already-retained bytes or from
reauthorized retrieval metadata. A fetch is an export input operation, not
inspection and not part of artifact identity. Missing retrieval authority,
missing objects, an object-format mismatch or bytes that do not hash to the
declared identity refuse export.

Retrieval metadata, clone paths, remote URLs and credentials do not enter the
closure. The artifact therefore remains sufficient to inspect and fork the
original definition when its repository is unavailable.

## 3. What remains outside

The artifact excludes:

- credentials, tokens, authentication helper output and environment bindings;
- retrieval metadata and provider endpoints;
- executor locks, recovery-coordination locks and SQLite journals;
- open transactions, connections, savepoints, leases and process identities;
- disposable materialization, checkout, temporary and Agent working-directory
  paths;
- provider-owned Agent conversation stores and session directories; and
- remote Git branches, pull requests, issues, services and other provider-owned
  state.

Exclusion does not erase durable evidence about an external effect. Its stable
request, natural key and filtered outcome remain when the live workflow contract
retains them. What stays outside is the external system itself and the live
credential or attachment needed to reach it.

### 3.1 Workspace confidentiality

The journal security gate still filters journal data before retention. It does
not inspect arbitrary document-created files, Git objects or Repository content
inside the Workspace. An XMD artifact may therefore contain source code,
generated files or secrets that the workflow wrote into its Workspace.

Export is a deliberate disclosure boundary. Operators treat the artifact with
the confidentiality of the complete retained Workspace, not merely the
rendered log. The command states this in help and CI integrations do not publish
an artifact more broadly than the source run's Workspace may be published.

The artifact format does not offer a “scrubbed but forkable” mode. Removing
arbitrary bytes would change Workspace roots, journal associations and replay
evidence. A separately defined report format may make that tradeoff; it is not
an XMD artifact.

### 3.2 Agent and external-state forkability

Provider-owned Agent conversation state is not portable merely because its XMD
mapping is. A checkpoint whose compatible continuation requires that state is
reported `agent-state-unavailable` by the existing forkability contract.

Completed external effects replay from their retained records and do not contact
their providers. An interrupted or otherwise unsettled external effect is
forkable only when the existing reconciliation contract establishes a safe
continuation. A checkpoint that cannot establish it is
`external-state-unavailable`. New live effects in the fork use the local host's
current authority and credentials; the artifact grants neither.

The same `workspace-root-unavailable` and `unsupported-effect` blockers apply to
artifact history. `history --artifact --forkable` calculates them without
executing the candidate. `fork` performs the complete compatibility replay
before any discoverable new run exists.

## 4. Identity, integrity and trust

### 4.1 Canonical artifact manifest

Every artifact carries one versioned artifact manifest. It canonically
enumerates all semantic records and retained bytes in the artifact, including
their kinds, logical identities, lengths and content hashes. Ordering and value
encoding are part of the manifest version. Physical SQLite page order, free
space, indexes and host path are not.

The XMD artifact identity is:

```text
sha256("xmd-artifact\0v1\0" || canonical-manifest-bytes)
```

The identity is written in the container as a derived value. A reader
reconstructs the manifest, recomputes the identity, validates every referenced
record and byte, and compares the derived value before exposing status, history
or forkability. Missing, additional, duplicated, dangling or hash-mismatched
content makes the artifact corrupt.

The semantic identity remains stable if a later implementation can encode the
same manifest in a different physical container. The SHA-256 of the final file
does not; it identifies transferred bytes and is reported separately.

#### 4.1.1 Version 1 manifest encoding

Version 1 fixes the manifest as compact canonical JSON encoded as UTF-8 with no
byte-order mark and no trailing newline. Object keys are in the stable sorted
order every other XMD identity uses; arrays keep the order the manifest states.
The value is:

```ts
interface XmdArtifactManifestV1 {
  readonly version: 1;
  readonly entries: readonly XmdArtifactManifestEntryV1[];
}

interface XmdArtifactManifestEntryV1 {
  readonly kind: string;
  readonly identity: Json;
  readonly encoding: "canonical-json" | "utf8" | "bytes";
  readonly length: number;
  readonly sha256: string;
}
```

`identity` is that kind's complete logical natural key as a canonical JSON
scalar or array, never a delimiter-joined string: two different natural keys can
join to one string, and an inventory that merged them would hold fewer records
than the artifact does. A singleton kind writes `null`.

Entries are sorted first by `kind` and then by the UTF-8 byte order of the
canonical JSON encoding of `identity`. A duplicate `(kind, identity)` pair is
forbidden. `length` is the exact byte length of the stored content and `sha256`
is that content's lowercase SHA-256.

`encoding` says how the bytes are to be read, not how they were produced.
Structured records this format defines are `canonical-json`. Text another
contract already fixed — a filtered journal record, an authored Markdown source,
a Workspace root manifest — is `utf8` and is preserved exactly rather than
re-encoded. Content with no text meaning is `bytes`.

#### 4.1.2 The version 1 inventory is closed

Version 1 enumerates every XMD-owned semantic record and retained byte in these
groups, and admits nothing else:

- the artifact frontier: the source run id, the final committed event id when
  the journal holds one, and the current Workspace root id;
- the workflow run record, without definition retrieval metadata;
- every document-execution record, in its retained order;
- the prior workflow-fork lineage, when the source run was itself a fork;
- every journal row in append order: its event id, the exact filtered protocol
  record, its Workspace-root association, and its inherited provenance when it
  has one. The authored source position lives inside the record and is
  validated from it rather than projected beside it, and so does every retained
  external-effect request, identity and filtered result;
- every retained Workspace root, its exact canonical manifest bytes, and its
  declared root-to-manifest and root-to-blob references;
- every retained DOFS manifest record and its exact encoded bytes, and every
  retained blob record and its exact bytes, that those roots require;
- every Workspace Repository and Worktree creation record, carrying the
  credential-free locator and the logical Workspace checkout path — never
  retrieval metadata or a host checkout path;
- every suspension-answer record, with its request identity, its pending or
  consumed state, and its timestamps;
- every retained workflow Agent session mapping and its compatibility
  attributes, without any provider-owned conversation store or session
  directory; and
- the workflow definition source closure: the root descriptor and exact root
  Markdown bytes, plus every declared component's name, canonical path, object
  identity and exact Markdown bytes, including a component the run never
  expanded.

An unknown content kind inside a version-1 container is an undeclared semantic
record, and therefore corruption. It is not ignored for forward compatibility: a
reader that skipped it would be returning a snapshot whose inventory nobody
checked. A later version declares its own set.

### 4.2 Integrity is not authenticity

Manifest verification detects accidental corruption and unsophisticated
modification. It does not prove who produced the file: somebody able to replace
the artifact can also construct another internally consistent one.

A CI system that needs provenance publishes the final-file SHA-256 through a
trusted channel or covers it with its own signed attestation. The integration
verifies that claim before handing the artifact to XMD. The `.xmd` extension,
SQLite header and artifact identity are not signatures.

## 5. Container and compatibility

### 5.1 Public format, private encoding

`.xmd` is the public file extension and XMD artifact is the public format name.
SQLite is the first container encoding and an internal protocol choice. The
artifact uses a distinct SQLite application ID from a live workflow-run
database and carries both an artifact format version and a container schema
version.

Version 1 fixes those values. The artifact format version is `1`. The container
schema version is `1`, stored as the SQLite `user_version`. The application
marker is the four bytes `XMDA`, the integer `0x584d4441`; the live
workflow-run marker is `XMD1`, `0x584d4431`, and recognizing that one is the
categorical live-run refusal rather than the foreign-container refusal.

Raw tables, views, indexes, triggers, PRAGMAs and SQL queries are not public API.
The supported readers are XMD lifecycle commands and libraries that implement
this semantic specification. Editing the file with SQLite is unsupported and
causes manifest verification to refuse it unless a complete new artifact is
constructed.

An XMD reader validates, in order:

1. regular-file and `.xmd` path requirements;
2. the container family marker and supported container schema;
3. the supported artifact format version;
4. exact structural recognition with no undeclared schema objects;
5. the artifact manifest and XMD artifact identity; and
6. the workflow, journal, Workspace and definition invariants used for a live
   retained snapshot.

No status, history row or Workspace byte is returned before complete
recognition succeeds. A foreign SQLite database, live run database, newer
unsupported version, malformed schema and corrupt artifact are distinct
refusals and remain unchanged.

### 5.2 Read-only operation

Readers open an artifact without creating a rollback journal, WAL, shared-memory
file or lock sidecar. A host that cannot guarantee read-only access refuses.
No command performs schema migration in place.

An older supported reader may reject a newer artifact cleanly. A newer reader
may understand older declared versions, but never guesses missing semantics or
rewrites the source. Format conversion is outside this contract.

## 6. Failure behavior

Export refuses without producing the target when:

- the source run is absent, foreign, damaged or incompatible;
- another workflow executor holds its lock;
- a consistent committed frontier cannot be read;
- the workflow definition source closure cannot be obtained and authenticated;
- any retained state required by the artifact manifest is unreadable;
- the target exists, lacks the `.xmd` extension or cannot be published
  atomically; or
- temporary-state cleanup fails.

Inspection refuses without a partial result when recognition or manifest
verification fails.

Fork refuses before creating discoverable run storage when:

- artifact recognition fails;
- the selected event is not a committed checkpoint;
- the selected checkpoint has a forkability blocker;
- the candidate definition or merged props are invalid; or
- compatibility replay does not consume exactly the inherited prefix and stop
  at the selected frontier.

Diagnostics name the artifact path, categorical condition and non-secret
identities needed to act. They do not quote retained file bytes, journal values,
credentials or retrieval metadata.

## 7. Structural acceptance checklist

Architecture review freezes these invariants before implementation:

1. An artifact is immutable evidence and never authority to advance the source
   run ID.
2. Export chooses one committed frontier while holding the source executor lock
   and leaves the source unchanged.
3. The artifact contains the complete retained XMD state and authenticated
   workflow definition source closure required by this specification.
4. Every reader validates the whole artifact manifest before returning a
   partial answer and never mutates or migrates the file.
5. Continuation creates a new history fork, copies state, records the artifact
   identity in lineage and passes the existing compatibility and forkability
   gates.
6. Credentials, live host authority, provider-owned Agent state, locks and host
   paths do not cross the artifact boundary.
7. Arbitrary Workspace content is preserved exactly and is treated as
   confidential rather than silently scrubbed.
8. `.xmd` and the semantic version are the public compatibility boundary;
   SQLite schema is not.

## 8. Contract inventory

| Contract | Status at this design revision |
| --- | --- |
| XMD artifact terminology and structural boundary | specified in `architecture.md`; unbuilt |
| `xmd workflow export` | specified; unbuilt |
| artifact status/history and manifest verification | specified; unbuilt |
| artifact-backed history fork and artifact lineage | specified; unbuilt |
| SQLite artifact container version 1 | specified as the initial encoding; the sealed container, its canonical manifest and its total read-only verifier are built. The physical schema is private and no raw table, SQL or connection is public API |
| CI upload, digest attestation and retention policy | host integration; not an XMD execution contract |
| redacted diagnostic report | outside this format |
