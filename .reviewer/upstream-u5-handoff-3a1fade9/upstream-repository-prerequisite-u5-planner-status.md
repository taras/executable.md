# U5 Planner status — frozen

U5 is planned against landed U4. Twelve acceptance rows U5-1–U5-12 and twelve focused
commands are frozen in the [Implementor
handoff](upstream-repository-prerequisite-u5-implementor-handoff.md). Use the [starter
prompt](upstream-repository-prerequisite-u5-implementor-prompt.md) in a new, separately
authorized Implementor session. This conversation stays Planner.

## Verified base and source

- Exact main: `3a1fade9246db937e11da6cdadc4751ec924be97`.
- Exact tree: `b92762664a24d7b5636b08c98d96907a614d76f0`.
- U4 PR #919 merged at 2026-10-15T11:47:49Z. Its published head `4c05e45b468a80db7370a8163d82ce20ede94262` has the same tree as the merge. The earlier Planner PASS remains attached to `eef612edcf86dd2416b2cb3dbbdd85dcb4e3e9d4`; no verdict is transferred to a different SHA.
- GitHub main, PR merge metadata and local Git objects were checked read-only. CI was not inspected. The [landed receipt](upstream-repository-prerequisite-u4-landed-receipt.md) records those checks.
- `source.tar` is a Git archive of the planning base. `source/` has 1,717 blobs; each materialized blob was compared by Git object hash, with zero different, missing or extra files. This source has no dependencies or setup and is not an implementation worktree.
- All 35 existing test paths in the twelve commands resolve in that source. `packages/core/tests/generated-selection.test.ts` is the one planned new evidence file. Relative links and the two authority anchors resolve after all artifacts are written.

## Settled implementation boundary

`Component.generated` is a plain value property, default undefined. Core captures its
final answer and actual resolved definitions after init/host assembly and before public
execution policy. Owning metadata supplies identity, effect and contract. CLI defaults
only on undefined; defined empty or invalid selections reach setup refusal, and multiple
middleware do not imply union.

Selected replaceable names resolve to their actual host answer. An answer without the
required generated offer refuses setup; no pinned-core fallback survives for those
names. Canonical fixed/protected names, answer provenance, form dispatch and execution
lifetime remain effective. U4's single-read owned-copy rule remains required.

Generic Workspace/request inventories, frozen generated timeout and full profile inputs
are removed. Actual Files/Fetch work uses existing live Permissions and Config. Workflow
storage, restoration, forks, effect transactions, journal order, completed-root bypass
and completed local effect restoration remain. Plan uses its accepted ordinary
trusted-read boundary; no scope grants return.

The generated record changes to one current marker-4 shape, with no old-schema
compatibility path. #902 remains held until U5 lands and its consumer owner removes the
existing forwarding and proves its separate integration evidence.

## Source findings used to bound the work

- `core/src/execute.ts::invoke` already initializes and calls installation callbacks before public policy. Canonical registry/bundle/declaration/protected assembly and profile sealing are currently late in `executeDocument`. U5 moves the minimum necessary assembly into the same invocation owner and reuses it; it does not mint identities twice.
- The current component-answer capture only auto-publishes protected Syntax. Selection capture must also accept authentic canonical terminal answers for fixed components, defaults and registrations. Existing provider request/window verification stays authoritative for provider replacements.
- `ComponentApi` and its owned descriptors share `COMPONENT_DEFAULTS`; the property must be present throughout that family. No context-api dependency change is necessary.
- CLI run, REPL, isolated child and Plan assembly each carry the old profile. Every path migrates in the same slice. Isolated children explicitly assemble their own behavior.
- Workflow's profile combines selection with evaluator-only Workspace/timeout inputs. Its low-level `generated-observations.ts` wrapper has only test consumers. Migrating those tests through canonical Evaluate permits removal of that obsolete table-taking wrapper. Actual Workspace storage/effects are separate consumers and remain.
- Runtime Fetch already checks actual effective Permissions immediately before transport, and the ordinary Fetch component already uses a live durable callback. Generic static inventories can be removed without inventing a new I/O route.

## Overlap, preservation and authorization

PR #890 was rechecked read-only: open, head `79d404d04d02c3840892473b6f1b2cf540f3edd1`,
base `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`. It is not a dependency. The Implementor
rechecks main again before choosing a base and reports any later landed overlap.

No implementation authorization is inferred from this planning request. No production
implementation, test run against changed production code, setup, commit, push, PR,
merge, CI inspection or cleanup occurred. Root user edits, other branches/worktrees,
preservation refs and `.reviewer/upstream-prerequisites-6314e187/` were not changed. The
new planning artifacts live outside that immutable archive.

No unresolved architecture blocker is known. If implementation exposes a concrete
conflict with the accepted contract or cannot prove a frozen row, return that bounded
conflict to the Planner/Architect. Do not expand the matrix or implement a new authority
surface while awaiting a decision.

## Continuity

Base: `3a1fade9246db937e11da6cdadc4751ec924be97`, tree
`b92762664a24d7b5636b08c98d96907a614d76f0`. Artifacts: handoff, starter prompt, this
status, U4 landed receipt, source archive and source verification in
`.reviewer/upstream-u5-handoff-3a1fade9/`. The twelve rows and commands are frozen.
Implementation authorization is outstanding. Next action: authorize U5 for a new
Implementor session, which rechecks main, creates a fresh U5 worktree and runs setup
once. Subsequent exact-revision reviews and delivery remain separate.
