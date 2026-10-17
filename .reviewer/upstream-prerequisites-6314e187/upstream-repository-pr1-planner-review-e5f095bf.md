# PR 1 Planner revision review

Verdict: **REQUEST CHANGES** on `e5f095bfe8ccd3b6aca80fd486fffd265267876c`, with base `f79f6730784a7ecba7253dcd35e6e5567293876c` and preceding feedback revision `bf56f978d70b5690996ab39f122e74140811429a`.

The production corrections for L1 and Files validation, and the E3 concurrent integration case, satisfy the preceding review. The remaining corrections concern the already-required E8 resource fixture and descriptor-cleanup evidence. This review applies to Deno and compiled foreground REPL File/Dir work. It does not expand the feature or introduce a structural decision.

## Accepted corrections

- The private `retained-repository/leases.ts` helper consumes the existing native advisory lock. Independent entries open independent handles. The global holder registry, UUID tokens and disproved per-process lock explanation are removed. Entry-owned lazy acquisition remains. The accepted sidecar name and cleanup-before-open correction remain.
- Both normalizers now require readable boolean settlement. Unit successes reject unreadable or non-undefined payloads, while readable unknown non-write failures become ordinary generic refusals. Malformed writes remain fatal. The two entry-recorder regressions cover the previously demonstrated behavior changes.
- E3 now uses equal requests on distinct durable coroutines and verifies replay without new native work. Existing nesting and sequential-equal-request regressions remain.
- E8 now exercises production entry-level contention, another checkout, same-entry reuse, independent same-process handles, cross-process refusal/release and cancellation after an acquired barrier.
- `run-composition/leases.ts` matches the base blob `2e5565f2a9eb332dfb6dcf0295d4f4181c36aa8b`; `run-composition/errors.ts` matches `c474b4b4adc6222b4184258992c9a3edbd81f1bc`. The original lazy regression still matches base blob `3dc754e6da8126a9178aa882dfa1d0388f3188f4`.

## Remaining E8 corrections

### Keep child cleanup responsible until termination is observed

In `packages/git/tests/retained-repository-lifecycle.test.ts:533–537`, `finish()` sets `finished = true` before yielding either the stdin close or child status wait. The registered cleanup at lines 496–506 returns immediately when that flag is true. Cancellation during either wait therefore bypasses both killing and joining the child.

This violates the existing E8 joined-teardown requirement and repository rule 16. Registering cleanup before spawn is now correct, but declaring completion before the resource's own termination is observed disables that cleanup too soon. The correction belongs to this PR's revised cross-process evidence fixture; it requires no production API change.

The isolated [review probe](planner-e5-child-finish-probe.ts) embeds this revision's `HoldingChild` interface and `holdingChild` implementation verbatim. It starts a real child that owns the sidecar, gates the stdin-close promise, begins `finish()`, and halts the owner while that wait is pending. It prints:

```json
{"ownerHaltReturned":true,"childStillAlive":true}
```

The probe's separate outer cleanup kills and joins the real child, restores the command constructor and removes its private fixture. No production or repository test file was edited. The gate makes the cancellation boundary deterministic; it does not claim an uninstrumented leak was observed during the ordinary passing test.

Keep the cleanup active until the child status wait has completed. Add a bounded assertion at this existing lifecycle boundary that cancellation while finishing still kills/joins the child before owner teardown returns. Preserve normal completion and cross-process lock release assertions.

### Observe descriptor cleanup directly

The case at `retained-repository-lifecycle.test.ts:443–471` does not establish its stated refused-descriptor assertion. It sees `undefined` for a refused acquisition and later reacquires after the holder exits. An open descriptor that failed to acquire the lock does not hold that lock, so reacquisition cannot reveal its leak. The test also leaves each refused scope immediately, so it cannot distinguish prompt closure from closure deferred to scope teardown. It exercises no throwing partial-acquisition path.

The production helper's close/cleanup branches look correct by direct inspection. The remaining gap is the focused evidence already required by E8 and the previous revision prompt. Make the existing bounded helper regression observe close/unlock calls: a refused descriptor closes once before the caller's scope ends; a throwing partial acquisition closes once without unlocking; a held acquisition releases once on teardown. Preserve cleanup-before-open ordering. Test-side observation of the existing native boundary is sufficient; add no production injection API or new abstraction.

## Focused verification performed by this review

Working directory for all commands:

`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`

```bash
deno task test packages/git/tests/retained-repository-records.test.ts packages/git/tests/retained-repository-local.test.ts packages/git/tests/retained-repository-lifecycle.test.ts packages/git/tests/run-composition-ambient.test.ts packages/git/tests/run-composition-lazy.test.ts packages/git/tests/module-partition.test.ts packages/git/tests/public-entrypoint.test.ts packages/git/tests/api-entrypoint.test.ts
deno task test packages/workflow/tests/workflow-lifecycle-authority.test.ts
deno run --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/planner-e5-child-finish-probe.ts
```

Results: F1 passed, 14 tests / 85 steps; workflow lifecycle passed, 2 tests / 11 steps; the corrected probe execution exited 0 with the reproduced ownership gap above. An initial probe launch did not execute its Effection operation; the runner was corrected before the reported reproduction. No exhaustive suite or CI inspection occurred. The implementation worktree remains clean at the exact feedback SHA.

The supplied report states the remaining F2–F6 groups, lint and check passed. Its command text arrived corrupted, so it is not an exact execution receipt. An uncorrupted receipt or a local file containing every command actually run, including corrected failures, is still needed with the next feedback. Do not reconstruct a purported execution log from the handoff's prescribed commands.

The raw R2 benchmark was found and read at:

`/private/tmp/claude-501/-Users-tarasmankovski-Repositories-taras-executable-md/6ed03464-691d-401e-9493-c23923a83995/scratchpad/bench-repl-file-dir-evidence-r2.txt`

It reports equal 30-operation / 1024-byte fixtures across five samples: ordinary median 82.2 ms, live entry 150.4 ms and completed continuation 39.3 ms. Continuation reports zero writes, deletes, ensures, Git calls and lease acquisitions. No performance budget is inferred. Public journey evidence remains the source/compiled live assertions; this review did not rerun those journeys.

## Ready-to-send revision prompt

Revise only the remaining E8 evidence in feedback revision `e5f095bfe8ccd3b6aca80fd486fffd265267876c`, preserving base `f79f6730784a7ecba7253dcd35e6e5567293876c` and the accepted production corrections.

Keep the `holdingChild` cleanup responsible until the child's status has actually completed; `finish()` must not set its cleanup-suppression flag before its suspending waits. Verify cancellation while finishing still joins actual termination. Use the attached review probe as the deterministic boundary evidence, retaining normal cross-process refusal/release coverage.

Strengthen the existing advisory-helper regression to observe prompt single closure of a refused descriptor, single closure on throwing partial acquisition without unlock, and single release on held teardown. Keep cleanup registration before open. Add no production test API, registry, journal protocol or unrelated feature.

Run the affected F1 lifecycle evidence and required workflow lifecycle regression, fixing focused failures before committing. The production interfaces and public journey implementation need no changes for this request. Reuse the already reported unaffected F2–F6 evidence and identify its revision; rerun other commands only if subsequent changes affect them. Commit promptly after the affected evidence passes and return the new exact SHA, exact base, every command actually run with results, and an uncorrupted prior command receipt or resolvable path to it. Keep delivery verification separate. Do not publish or merge as part of this prompt.

## Continuity

The amended [stack plan](upstream-repository-pr-stack-plan.md), [PR 1 handoff](upstream-repository-pr1-file-dir-implementor-handoff.md), Architect review and earlier feedback review remain unchanged. New artifacts are this review and `planner-e5-child-finish-probe.ts` beside it.

L1 and the product contract remain settled. There is no unresolved structural question for the Architect. The remaining blockers are bounded E8 fixture ownership and cleanup evidence. Once revision is authorized, the Implementor returns the corrected feedback SHA. Architect implementation review of the exact revision, Product Owner review and explicit merge approval remain separate gates; this review authorizes none of them.
