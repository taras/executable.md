# Portable XMD Artifact Quest

- **Status:** Amended for architecture review. The published quest and stories
  are synchronized with this file; implementation waits for the Architect's
  verdict on this amendment.
- **Review target:** The commit containing this file, based directly on
  `43e4a8a0e30530972333a350b89791d818dfd4b6`; the Planner handoff supplies its
  exact immutable SHA.
- **Contract commit:** `43e4a8a0e30530972333a350b89791d818dfd4b6`
- **Base:** `e84c0a7a4d267299ae94cfbec10d2184028dbf74`
- **Branch:** `codex/xmd-portable-artifact-spec`

## Purpose

Deliver one portable, immutable `.xmd` evidence artifact for a committed
workflow-run frontier. CI and a local developer inspect the same bytes. A local
continuation always becomes a separately retained history fork; an artifact is
never authority to resume, answer, cancel, delete, or otherwise advance the
source run.

This plan turns the design contract into one GitHub quest and four dependent,
reviewable implementation stories. The stories collectively implement the
contract in `specs/xmd-artifact-spec.md`; they do not change it.

## Authoritative Contract

- `specs/xmd-artifact-spec.md` is the public artifact contract.
- `architecture.md`'s Portable XMD artifacts amendment fixes the authority,
  integrity, portability, and fork-lineage invariants.
- `specs/workflow-workspace-spec.md` integrates export, artifact inspection, and
  artifact-source forks into the host-neutral lifecycle surface.
- The frozen structural checklist is §7 of `specs/xmd-artifact-spec.md`.

## Current State

- The Deno workflow provider already has strict, read-only retained-run
  inspection, recovery-copy handling, executor locks, history projection, and
  fork staging/commit boundaries in `packages/workflow/src/deno/lifecycle.ts`.
- `packages/workflow/src/deno/fork-source.ts` and
  `packages/workflow/src/deno/fork-write.ts` already copy a selected retained
  history prefix, Workspace roots, content blobs, Repository and Worktree rows
  into a new independent run.
- `packages/cli/src/workflow.ts`, `packages/cli/src/workflow-management.ts`, and
  `packages/cli/src/workflow-fork.ts` own lifecycle grammar, presentation, and
  fork preflight. They currently accept retained run IDs only.
- `packages/cli/src/workflow-definition.ts` and
  `packages/cli/src/workflow-bundle.ts` establish and authenticate root and
  component Markdown from a pinned workflow definition.
- No artifact container, semantic-manifest verifier, `export` command, artifact
  inspection, or artifact source for a fork exists.

## Settled Decisions And Exclusions

- `.xmd`, artifact-format version, canonical manifest, and manifest identity are
  the public compatibility boundary. SQLite is only V1's private container
  encoding; raw schema and SQL are not public APIs.
- The artifact contains complete XMD-owned retained state plus the authenticated
  root/component Markdown source closure. It preserves all Workspace bytes,
  metadata, modes, links, and Repository/Worktree records exactly.
- Credentials, retrieval metadata, host paths, locks, sidecars, open
  transactions, provider-owned Agent storage, and remote-provider state remain
  outside the artifact.
- Artifact readers require a regular `.xmd` file, open it read-only, validate
  complete recognition and manifest identity before returning any data, and
  create no SQLite sidecars or migrations.
- Export acquires the source executor lock before it chooses its frontier; it
  uses existing private recovery-copy rules when necessary and never changes the
  source lifecycle, journal, Workspace, or provider state.
- Artifact continuation reuses the existing forkability and compatibility-replay
  gates. It writes a new run only after preflight succeeds, copies rather than
  shares state, and records the artifact identity with normal source-run,
  checkpoint, and root lineage.
- Reusing an explicit destination run ID compares the artifact identity as an
  immutable fork-identity term. Two artifacts with the same claimed source run,
  checkpoint, and root but different artifact identities are different fork
  requests and never compatibly reuse one destination.
- Artifact publication, CI upload, signed provenance, retention policy, and a
  redacted report format are outside this quest. The command reports a final
  file SHA-256 for a CI host to attest or publish through its own trusted
  channel.

## Quest Story

**Title:** `🗺️ Quest: Export portable XMD workflow evidence artifacts`

**Labels:** `enhancement`, `quest`

**Published issue:** #599

**GitHub body summary:** A workflow runner can export one immutable `.xmd`
artifact containing a committed run frontier and authenticated definition-source
closure. Any host can inspect its status/history without executing it, and a
developer can fork it into a new local run without acquiring authority over the
source run. The quest tracks the four stories below in order.

**Quest acceptance:** All four child stories pass their frozen criteria and the
result implements all eight structural invariants in the artifact specification.

## Story 1 — Sealed Artifact Container And Semantic Reader

**Title:** `Create the versioned XMD artifact container and verifier`

**Published issue:** #602

**Depends on:** Quest #599 only. This is the foundation for every other story.

**Ownership:** A new Deno-provider-internal artifact module near
`packages/workflow/src/deno/`; shared lifecycle types gain only parsed,
immutable artifact snapshot values. The implementation does not expose raw SQL
or a live database handle.

**Implementation outcome:**

- Define V1's distinct SQLite application marker, artifact/container versions,
  exact recognized schema, and canonical artifact manifest encoding.
- Define the canonical inventory of all retained semantic records and bytes;
  derive the lowercase SHA-256 artifact identity from the specified domain
  prefix and manifest bytes.
- Write a sealed artifact from an already-complete in-memory snapshot, and open
  an artifact only through a read-only verifier that parses immutable lifecycle,
  history, fork-source, and definition-closure values.
- Reject non-regular/wrong-extension paths, foreign SQLite, live run stores,
  unsupported versions, undeclared schema objects, duplicate/dangling/missing
  records, and any manifest/content/identity mismatch before a caller receives a
  snapshot or history row.

**Acceptance criteria:**

1. The V1 writer produces a `.xmd` SQLite container with a distinct application
   marker and declared artifact/container versions; no raw table contract is
   exported as public API.
2. Re-encoding the same semantic snapshot with permitted physical SQLite
   differences yields the same canonical manifest and artifact identity, while
   the final-file digest remains a separate byte-transport value.
3. The reader verifies the complete container, all retained bytes, and the
   derived identity before exposing status, history, forkability, Workspace, or
   definition data.
4. Foreign, live-run, malformed, future-version, and tampered artifacts refuse
   categorically without mutating the source file or creating `-journal`,
   `-wal`, `-shm`, or lock sidecars.
5. The parsed artifact snapshot carries no retrieval metadata, credential,
   host-path, lock, connection, or provider-owned-directory field.

**Focused evidence:** New `packages/workflow/tests/xmd-artifact*.test.ts` cases
cover semantic-identity stability, each recognition failure class, complete
manifest verification before projection, and sidecar-free read-only opening. Run
the exact new test file with `deno task test`.

## Story 2 — Export A Locked, Authenticated Frontier

**Title:** `Export one workflow run as a sealed XMD artifact`

**Published issue:** #600

**Depends on:** Story 1 (#602).

**Ownership:** Deno lifecycle/export orchestration, source snapshot extraction,
and definition-source retrieval/authentication. Reuse existing executor-lock,
inspection-recovery, Workspace snapshot, definition, and component-bundle
boundaries; do not teach the artifact container to acquire execution authority.

**Implementation outcome:**

- Add a provider-neutral lifecycle export request/result and Deno-provider
  implementation that takes the source executor lock, reads one committed
  frontier, gathers all XMD-owned retained state, and hands a detached snapshot
  to Story 1's writer.
- Obtain each root and bundled component source from retained bytes or
  reauthorized retrieval, and authenticate it against the definition's object
  format, commit, path, and blob identity before sealing it.
- Add `xmd workflow export <run-id> --output=<path.xmd>` with required local
  `.xmd` output, refusal of an existing target and standard output, atomically
  published only after the artifact and cleanup succeed.
- Report artifact path, source run ID, frontier event/root, semantic artifact
  identity, and final-file SHA-256. Help states that the file includes complete
  Workspace content and may be confidential.

**Acceptance criteria:**

1. Export while another executor holds the source lock refuses and creates no
   target; an export holding the lock chooses one consistent committed frontier
   and releases the lock without changing source state.
2. A successful artifact contains the complete retained run state: run and prior
   lineage, lifecycle/executions, filtered journal and provenance, every root,
   manifest/blob byte and filesystem metadata, Repository/Worktree rows,
   suspension state, retained external-effect records, Agent mappings, and the
   authenticated definition closure.
3. Missing retrieval authority or source objects, object-format/hash mismatch,
   unreadable retained state, invalid output path, existing target, atomic
   publication failure, cancellation, or a temporary cleanup failure before
   publication leaves no requested output and does not claim export success.
   Successful atomic no-replace publication commits the export: cleanup of the
   private entry it published from is best effort, and a failure there is
   reported as a retained leftover beside a successful export rather than
   invalidating or rolling back the committed artifact.
4. A crashed source uses the existing recovery-copy discipline; export does not
   repair, settle, replay, append to, or relabel the retained source.
5. CLI output distinguishes semantic artifact identity from final-file digest
   and its help warns that arbitrary Workspace content can be confidential.

**Focused evidence:** Extend workflow artifact tests with a run containing
multiple Workspace roots, file bytes/mode/symlink/hardlink state, Repository or
Worktree records, a root plus an unexpanded bundled component, and a suspension
or retained effect. Verify that export includes the exact root/component bytes
and their declared object identities, and that mismatched or unavailable source
refuses export. Repository-independent continuation from those bytes belongs to
Story 4. Add CLI integration cases for successful atomic export, lock refusal,
source-authentication refusal, and no target after cancellation/failure. Run the
explicit workflow test and `packages/cli/tests/workflow-*.test.ts` files that
cover export.

## Story 3 — Inspect Artifacts Without Execution Authority

**Title:** `Inspect validated XMD artifacts through workflow status and history`

**Published issue:** #601

**Depends on:** Story 1 (#602). Story 2 (#600) supplies production artifacts;
Story 3 may use Story 1 fixtures while it is implemented.

**Ownership:** Lifecycle inspection projection and CLI grammar/presentation.
`list` remains retained-run discovery only.

**Implementation outcome:**

- Extend status/history source parsing so exactly one of a retained run ID or
  `--artifact=<path.xmd>` is required; reject ambiguous/missing source forms.
- Project the validated artifact into the existing immutable status/history JSON
  shapes, adding artifact identity and artifact frontier while keeping any host
  path as human presentation only.
- Reuse the existing history forkability classifier over parsed artifact state,
  without materializing a Workspace, importing a definition, acquiring a lock,
  or contacting a provider.

**Acceptance criteria:**

1. `workflow status --artifact` and `workflow history --artifact`, including
   `--json` and `--forkable`, report the same semantic lifecycle/history fields
   as an equivalent retained run plus artifact identity/frontier.
2. Every artifact inspection first completes Story 1 recognition; a malformed or
   tampered artifact returns no partial status/history row and remains
   byte-identical with no sidecars.
3. Inspection executes no document, does not acquire an executor lock, attach or
   materialize a Workspace, fetch a definition, contact Agent/external
   providers, or mutate lifecycle/journal state.
4. `status` and `history` reject a positional run ID combined with `--artifact`;
   `list` rejects artifact input and never treats downloaded files as a run
   registry.
5. JSON identity never depends on the artifact's host path; moving/copying the
   identical file preserves its semantic result.

**Focused evidence:** Add CLI workflow-inspection cases that inspect one
artifact from two paths (including a read-only directory), compare
retained-run/artifact JSON projections, prove no sidecars/mutations, and
exercise grammar refusals. Run
`deno task test packages/cli/tests/workflow-inspection.test.ts` plus the
artifact reader tests.

## Story 4 — Fork A New Run From Artifact Evidence

**Title:** `Fork an XMD artifact into independent workflow history`

**Published issue:** #603

**Depends on:** Stories 1–3 (#602, #600, #601).

**Ownership:** Fork request/source interfaces, Deno staging and write path,
lineage storage/parsing, candidate-definition selection, and CLI fork grammar.
The existing compatibility replay is authoritative for whether a selected
checkpoint can continue.

**Implementation outcome:**

- Make a verified artifact an alternate fork source that feeds the existing
  selected-prefix, root-copy, staging, forkability, and compatibility-replay
  machinery without attaching the artifact as a writable run store.
- Permit `xmd workflow fork --artifact=<path.xmd> --at=<event> --id=<run-id>`
  with an optional definition. When omitted, construct the candidate from the
  authenticated embedded closure and retain it in the new run so later resume
  never needs the artifact path or original repository.
- Extend fork lineage with artifact identity while retaining source run ID,
  selected event ID, and selected root ID. Preserve inherited-event provenance.
- Treat artifact identity as an immutable fork-identity term when an explicit
  destination run ID already exists. Compatible reuse requires the retained
  destination to name the same artifact identity as the new request, in addition
  to the existing source/checkpoint/root, definition, base, and props terms.

**Acceptance criteria:**

1. Artifact fork grammar requires `--artifact` and `--at`, then creates a new
   explicit or host-generated run ID; artifact and retained-run source forms are
   mutually exclusive. The optional definition selects the embedded
   authenticated closure only when absent.
2. A fork obtains a new run ID and independent copied database/pages, roots,
   retained bytes, and required definition state; deleting either source run or
   artifact cannot make the fork unreadable or resumably dependent on it.
3. Forkability uses the existing cumulative blocker vocabulary, and preflight
   refuses invalid artifact, non-checkpoint, blocked checkpoint, bad merged
   props/candidate definition, or divergent replay before discoverable
   destination storage exists.
4. Successful lineage includes artifact identity, source run ID, selected event,
   and selected root; inherited rows retain original source-run/source-event
   provenance.
5. Forking never resumes or advances the artifact/source identity, never shares
   an executor lock or writable page, and leaves the artifact byte-identical.
6. A completed external effect replays only from retained evidence; an
   unavailable Agent/external continuation remains blocked and new live effects
   use the local host's authority and credentials.
7. Reusing an explicit destination run ID compares XMD artifact identity as a
   fork-identity term. A request from artifact B refuses before mutation when
   that ID already names a fork from artifact A, even when both artifacts claim
   the same source run, checkpoint, and selected root.

**Focused evidence:** Extend `packages/workflow/tests/workflow-fork.test.ts` and
CLI fork tests to prove embedded-definition forks with original repository
unavailable, modified-definition forks, copied-state independence, lineage,
preflight no-destination failures, each representative forkability blocker, and
artifact byte identity before/after multiple independent forks. Create a fork
from artifact A under one explicit destination run ID, then request that same ID
from artifact B with the same source run, checkpoint, selected root, definition,
base, and props but a different artifact identity; prove the second request
refuses before changing any destination row, journal event, Workspace root, or
retained byte. Run those explicit tests plus the artifact test file.

## Delivery Order

1. Story 1 establishes the private encoding, public semantic identity, and
   verified immutable reader.
2. Story 2 makes a live retained run exportable through the authority-safe lock
   and authenticated closure path.
3. Story 3 makes the verified reader observable through existing inspection
   commands. It can be developed in parallel with Story 2 after Story 1, but
   merges after Story 2 to retain a usable artifact-producing main branch.
4. Story 4 adds artifact-source continuation only after real artifact export and
   inspection are available.

No story leaves `main` with a public command shape that contradicts its
specification. Story 1 has no public CLI surface; Story 2 ships export; Story 3
ships inspection; Story 4 ships artifact fork.

## Frozen Evidence Matrix

| Criterion                                                       | Story | Representative proof                                                                                              |
| --------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| Semantic identity is container-layout independent               | 1     | Same semantic fixture, varied physical SQLite layout, one manifest identity                                       |
| Recognition is total and read-only                              | 1, 3  | Foreign/live/future/malformed/tampered inputs return no projection or sidecar                                     |
| Export captures one complete unchanged frontier                 | 2     | Multi-root run with lock refusal, recovery-copy, and post-export source comparison                                |
| Definition closure is complete and authenticated at export      | 2     | Exact root and unexpanded bundle-component bytes/object identities are sealed; mismatch or unavailability refuses |
| Embedded definition closure is self-sufficient for continuation | 4     | Root and unexpanded bundle component fork after repository access is removed                                      |
| Workspace confidentiality is explicit                           | 2     | CLI help/output proves disclosure warning; artifact retains unfiltered Workspace fixture bytes                    |
| Artifact inspection equals retained evidence                    | 3     | Status/history JSON comparison after moving the exact file                                                        |
| Artifact never gains execution authority                        | 3, 4  | No artifact resume/control grammar; inspection trace has no execution/provider effects                            |
| Artifact fork creates independent lineage                       | 4     | Two forks from one file, retained artifact identity/provenance, source deletion and resumability                  |
| Explicit destination reuse includes artifact identity           | 4     | Fork ID created from artifact A refuses artifact B with the same source/checkpoint/root before mutation           |
| Compatibility and forkability remain fail-closed                | 4     | Blocked checkpoint and divergent candidate leave no discoverable destination                                      |

Each Story implementor commits a feedback revision as soon as the story's named
focused evidence passes, reports the exact SHA and commands, and does not wait
for the full delivery battery. Delivery retains the repository's normal lint,
check, runtime, JSR, and required CI gates.

## Architect Review Request

Review this file against the structural checklist in
`specs/xmd-artifact-spec.md` §7. In particular, verify that the story boundaries
preserve: source-run authority; one committed locked frontier; total verified
read-only recognition; complete retained-state and definition closure; explicit
artifact lineage; artifact identity as an explicit destination fork-identity
term; exclusion of credentials/provider state/host paths; exact Workspace
preservation; and the `.xmd` semantic compatibility boundary.

The quest and four child stories are already published and synchronized with
this amendment. On `PASS`, implementation begins with Story 1 against this
frozen matrix.

## Continuity Record

- **Repository/worktree:** `/private/tmp/xmd-portable-artifact-spec`
- **Base/contract:** `e84c0a7a4d267299ae94cfbec10d2184028dbf74` →
  `43e4a8a0e30530972333a350b89791d818dfd4b6`
- **Review target:** the exact commit containing this file, supplied in the
  Planner handoff.
- **Produced artifact:** `plans/xmd-portable-artifact-quest.md`
- **Settled decisions:** the artifact specification and architecture amendment;
  no CI publication/attestation story in this execution-contract quest; explicit
  destination reuse compares artifact identity; export owns closure
  completeness/authentication evidence and fork owns repository-independent
  continuation evidence.
- **Published artifacts:** quest #599 and stories #602, #600, #601, #603.
- **Unresolved blocker:** architecture review of this amended plan is required
  before implementation.
- **Next role/action:** Architect reviews the exact plan commit and returns
  `PASS` or `REQUEST CHANGES`; after `PASS`, the Implementor begins Story 1.
