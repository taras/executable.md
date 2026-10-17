# Smaller REPL repository deliveries

Read this plan before authorizing a replacement implementation. It divides the accepted foreground REPL behavior into useful deliveries and freezes the first delivery's scope. It applies to repository operations in Deno and compiled `xmd repl`.

**Planner PASS: L1 is resolved and the planning hold is removed.** The [recorded Architect resolution](upstream-repository-pr-stack-architecture-review.md#l1-common-directory-lease-resolution) supplies the native-lock design and Product Owner's accepted contention behavior. Implementation remains separately authorized.

## Authority and base

This task produces planning artifacts only. It authorizes no implementation, commit, publication, GitHub mutation or merge. Earlier handoff authorization and delivery-status fields are superseded. The historical implementation is evidence, not an approved patch.

The exact proposed base is **`f79f6730784a7ecba7253dcd35e6e5567293876c`**. A read-only request to `https://api.github.com/repos/taras/executable.md/branches/main` on 2026-10-11 verified that main still names this commit. Its tree is `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`. Its second parent is the revert `3159095cdc48e96914f69740b3940972fb0ce6bd`.

The root workspace is on local main `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`, whose committed tree is the same. Its remote-tracking main is stale (`afe8a5f237e6b23a222327834be8fa7c92241471`); neither it nor the dirty working files defines this plan's base. Existing modifications to `.agents/architecture-rules.md`, `.agents/product-interface.md`, `AGENTS.md` and `architecture.md`, and untracked `.agents/agent-writing.md`, `.reviewer/` and `greeting.md`, remain untouched.

Historical evidence remains at `/private/tmp/xmd-retained-repl-repositories`, branch `agent/retained-repl-repositories`, clean head `559f446dbba97b33042e512fd3c018b9a0f64a47`. Do not reset, cherry-pick onto, repurpose or delete that worktree. Preserve its journals, benchmark material and earlier handoffs. A later authorized implementation uses a separate worktree from the exact base above. If main advances, return the changed base and overlapping changes to the Planner before treating this handoff as current.

Authority, in order: the current Product Owner instruction; repository `AGENTS.md` and the Planner, Implementor, Architect, architecture, product-interface, product-verification and agent-writing rulebooks; the accepted decisions in [the Architect review](upstream-repository-pr-stack-architecture-review.md); the historical `architecture.md` foreground model and entry-host amendment, reconciled with those accepted decisions; and the affected specifications. The mandatory Effection lifetime rules are at [Effection AGENTS.md](https://github.com/thefrontside/effection/blob/v4/AGENTS.md).

No tests, builds or timing measurements were run during planning. Source inspection and read-only Git/API queries establish this plan; they are not implementation acceptance evidence.

## Settled behavior

The REPL is a foreground environment for experimentation with user or agent attention. A completed local operation returns its saved result during continuation. New operations use the live environment. Replay does not inventory, validate, restore or predict checkout contents. An operation without an acknowledged result may run again, including after its native effect happened. Differences in the environment may require user orientation or a change to the document.

The entry host supplies trusted execution/entry ownership and the entry's existing journal segment. The journal supplies coroutine identity and execution order. Operation descriptions carry kind and request information; the journal's existing type/name matcher associates results. Equal requests at different positions are valid. Existing nested and concurrent journal behavior remains the mechanism. There is no local component-occurrence protocol, authored site prop, prerequisite journal redesign or metadata on `next`.

Ordinary Files middleware may answer, transform and delegate, or refuse. The recorder saves the actual composed Result, including a valid write publication value and ordinary refusal details. Completed replay calls neither that middleware nor native work. Generated File access uses the existing captured provider and working-directory binding under the unchanged REPL ceiling. Generated Dir stays unavailable. History remains passive; a live entry owns and joins its resources before its slot is released.

Existing GitHost and Issue workers retain their external identities, encodings and reconciliation. A local success, a copied value or a Files middleware answer is no external publication receipt.

## Stack overview

The Product Owner delegated ordering to the Architect. This order is settled; the descriptions below are scope outlines, not later Implementor handoffs. PR 1 alone has frozen implementation acceptance in the companion artifact.

| Delivery | User-visible checkpoint and boundary | Dependency and exclusions |
| --- | --- | --- |
| 1. Entry-owned File/Dir results | In an existing ambient checkout, authored File writes/deletes and Dir ensures return saved results on continuation; captured generated File writes/deletes do so under the existing ceiling. Includes the per-entry factory, lazy ambient routing, leases, passive-history correction, truthful docs and real source/compiled leave/reopen proof. | Exact main above. No managed selection, local Git, external workers, read recording or new permissions. |
| 2. Managed Repository/Worktree | A Deno/compiled entry selects or creates a managed checkout/worktree; saved selection supplies routing data, and new work uses the live environment. Includes canonical managed-root acquisition and managed-slot leases only when requested. | After 1. Reuse ordinary live selectors, metadata and placement; no checkout snapshot, transition prediction, repair or local Git delivery. |
| 3. Local Add/Switch/Commit | A selected entry records ordinary local Git results. Completed operations replay; new ones use the live index/HEAD and lazily captured effective commit identity. Missing acknowledgement permits another attempt. | After 2. Reuse native local performers and host isolation; no Push, PR or Issue assembly. |
| 4. Push | An entry retains resolved Push inputs and uses the existing GitHost worker to replay, observe/adopt/perform/refuse under its established reconciliation rules. Completed replay reaches no credential or service. | After 3. Preserve external envelopes and workflow/fork behavior. No PR/evidence adapter or unused publication subsystem. |
| 5. Pull requests and evidence reads | A PR uses this entry's matching successful Push receipt and saved complete request. Completed PR/evidence reads replay; a later read observes live service data. Bind read identity within the individual admitted operation. | After 4. Keep owner/occurrence/request pairing distinct from local Files records. No entry-wide mutable read slot; no rewriting existing workers. |
| 6. Issues | Owned Issue reads/upserts work inside or outside a checkout, with existing read and idempotent reconciliation behavior. Standalone Issue work acquires no checkout or Git resource. | May proceed independently after 1. Reuse complete authored inputs and the existing worker; no checkout-dependent barrier or duplicate resolved-request subsystem. |

Every delivery includes runtime wiring, accurate specifications and its own public source/compiled journey. There is no final assembly PR. No size estimate is an allowance to combine independently reviewable features. Extracting the existing PTY fixture is optional local test maintenance, not a prerequisite delivery.

## PR 1 construction and replacement

Current source and compiled entrypoints install ordinary host Files and pass the ordinary-run repository installer separately. `runXmd` assembles a single immutable `ReplExecutionProfile`; `repl/program.ts` passes it to `openReplSession`; `runEntry` acquires `agent.owning(key)` and calls `executeInstalled` on that entry's `EntrySegmentStream`. There is currently no repository entry factory. Node/Bun share the command/profile/session path and must continue loading without the Deno repository graph.

Introduce the narrow factory at that existing seam. Its trusted request has exactly `executionId` and `entryKey`. Its required result has exactly `installation` and `files`. No source/site member survives without a consumer. The native assembler captures ordinary Files and contextual cwd, supplies the native Git host, and installs only the PR 1 feature. The session invokes it once inside each executing entry task, after admission and Agent ownership, and binds its Files value only into evaluation installations that already have Files access. Do not construct it for a catalog, preflight, settled projection, refused route or frozen history view.

An entry-owned recorder surrounds authored Files mutations through ordinary `API.Files.around(..., { at: "max" })`. Existing ancestor-max ordering places it before document middleware and the ordinary terminal. Generated mutations use an entry wrapper around the existing captured provider, not ambient Files lookup. The same local result policy serves both paths. Preserve core's File form dispatch, content-before-write expansion, captured access and permission checks. Dir keeps its existing ensure-before-content/contextual-directory behavior.

Only small routing data is retained for ambient selection: entry ownership, selection request and either no ambient checkout or canonical checkout root/common Git directory. No HEAD, origin, publication identity, inventory or managed-root data belongs in the PR 1 record. Selection replay restores data without discovery or a lease. A new in-checkout operation acquires a live common-directory lease before performing its mutation. Completed mutation replay is tried before canonicalizing cwd or discovering the checkout. The handoff specifies how to use the existing replay cursor as a non-consuming lookup before the existing matcher, without another occurrence table or journal change.

The historical all-feature provider, broad record unions, duplicate-name rejection and result synthesis are replaced with this narrow design. File identity hooks, private inspect/answer settlement, pass-through mutation handlers and host next-first fallback are excluded entirely. The restored base already lacks them; do not import them merely to remove them again.

## L1 resolved: reuse the native lock

The [Architect resolution](upstream-repository-pr-stack-architecture-review.md#l1-common-directory-lease-resolution), recorded at review line 296, closes the lease ownership and contention decisions. The earlier proposed shared holder state and opaque-token boundary are superseded.

Add private `useCommonDirectoryLease(commonDirectory: string): Operation<void>` in `packages/git/src/deno/retained-repository/leases.ts`. Its sole input is the canonical common Git directory from trusted native selection. Derive the existing hashed sidecar through `commonLockOf` in native `run-composition/placement.ts`, at `tmpdir()/xmd-common-lanes/<digest>.lock`, and reuse `useAdvisoryLock(path)` from `@executablemd/workflow/deno`. Leave the sidecar in place. The calling scope owns the native descriptor; the entry invokes this helper through its existing lazy single-flight acquisition in the entry owner scope. Same-entry borrowers reuse that acquisition. Independent live entries open independent native handles, which the kernel excludes within one process and across cooperating processes.

No process-global holder registry, shared namespaced state, opaque-token API, replaceable Context map or new cross-package contextual API enters PR 1. Durable owner strings identify records, not live acquisitions. Handles stay private and never enter authored middleware or journals. Ordinary managed-slot policy and `run-composition/leases.ts` remain unchanged. This protocol does not exclude arbitrary Git tools, users editing files or processes that ignore the sidecar.

Correct `packages/workflow/src/deno/advisory-lock.ts` before reuse: register cleanup before opening or attempting the nonblocking lock, following its existing waiting sibling. Close a refused descriptor promptly; unlock and close a held descriptor on scope exit; handle partial acquisition without double close. Keep the helper's signature, immediate-refusal behavior and workflow semantics. This is the directly required rule-16 correction, with focused acquisition/cancellation evidence and existing workflow lifecycle regression coverage.

After excluding completed replay, acquire the lease **outside the File result-recording callback** and before the new composed mutation. Contention stops the executing entry without acknowledging a File result. Preserve earlier completed records and save no ordinary File refusal for contention. Use a feature-specific Git error following the existing `StaleInputError` subclass/fatal propagation pattern, so core Files normalization preserves the failure without a new core/runtime API. The accepted message is: “Another XMD entry or process holds this checkout. End that work before trying again.” There is no automatic wait/retry and no promise that every failed entry is resumable. A later attempt uses the environment then available.

The Architect's primary-source trace and isolated Darwin probe correct the historical claim that native locks cannot exclude separate handles within one process. Those are recorded review evidence, not implementation test results. E8 still proves the feature's real native acquisitions, contention outcome and joined teardown. Only E8 and the directly affected workflow regression command are refined; the other frozen rows and delivery order remain intact.

## Frozen verification and documentation

The companion handoff freezes matrix E1–E10 and command groups F1–F6. They cover public source/compiled continuation and interruption, middleware answer/refusal/transformation, equal requests, existing nested/concurrent composition, generated ceilings, trusted entry isolation, passive history, resource teardown, ordinary/workflow/runtime preservation and one fair bounded cost comparison. Reuse existing regressions; do not multiply every scenario across all operations and runtimes.

Cost evidence compares equal ordinary-run and live-REPL fixtures/payloads, separately reporting completed replay. It reports times and counters without a new performance threshold. Missing performance evidence is reported as missing, not replaced with historical unequal measurements.

Implementation updates `architecture.md`, `specs/repl-spec.md` and the affected File/Delete/Dir/provider sections of `specs/executable-mdx-spec.md`; it adds a bounded REPL environment distinction in `specs/workflow-workspace-spec.md`. Preserve workflow transactions/frontiers and ordinary-run semantics. Reconcile the historical foreground amendment's obsolete local occurrence, terminal, fallback and replay-authentication commitments with accepted behavior, without copying its future-feature claims. These repository records are not edited during planning.

## Feedback and delivery gates

Once implementation is separately authorized, finish PR 1 only. Run the frozen focused evidence, fix any failures, then promptly create a feedback commit. Return its exact SHA, exact base, every command run with results, evidence artifacts and limitations. Do not delay that commit for lint, broad typechecking, JSR, exhaustive runtime suites or CI. Do not start PR 2 while waiting for PR 1 review.

Delivery separately requires applicable repository checks and authoritative branch protection, exact-revision Architect implementation review, Product Owner review and explicit merge approval. CI owns exhaustive Deno/Node/Bun suites. No implementation feedback verdict is a merge gate substitute. Planning/order acceptance authorizes none of those actions. Do not inspect or monitor CI as part of Planner feedback review.

## Continuity

- Base: `f79f6730784a7ecba7253dcd35e6e5567293876c`.
- Artifacts: this file and [the PR 1 Implementor handoff](upstream-repository-pr1-file-dir-implementor-handoff.md).
- Settled: foreground local result semantics; ordinary middleware answers; existing journal association/composition; entry ownership; unchanged generated ceiling; passive history/joined teardown; File/Dir-first delivery order; external reconciliation remains separate; L1 reuses the native advisory lock with cleanup before acquisition and accepted fatal contention outside the File outcome.
- Unresolved blockers: none. Planner PASS; the L1 hold is removed. This is planning acceptance, not implementation or merge authorization.
- Next action: obtain separate implementation authorization. After it is given, the Implementor uses a fresh worktree at the exact base, executes PR 1 and returns its focused-evidence feedback commit. Commits and publication remain subject to the authorization and review gates above.
