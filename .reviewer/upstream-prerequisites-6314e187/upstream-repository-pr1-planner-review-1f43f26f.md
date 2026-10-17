# PR 1 Planner acceptance

Verdict: **PASS** on `1f43f26fb71a802326578300f52021d9f82448e0`, base `f79f6730784a7ecba7253dcd35e6e5567293876c`.

This closes the Planner feedback review for the amended PR 1 File/Dir handoff. The exact revision satisfies the frozen acceptance/evidence threshold, including the two remaining E8 corrections from the [preceding review](upstream-repository-pr1-planner-review-e5f095bf.md). It changes only `packages/git/tests/retained-repository-lifecycle.test.ts` from `e5f095bfe8ccd3b6aca80fd486fffd265267876c`. Production modules and the previously accepted L1, Files validation and E3 corrections are unchanged.

## Accepted E8 corrections

The child fixture registers reaping cleanup before spawn and keeps it responsible through both suspending waits in `finish()`. Its completion flag is assigned only after the child's own status resolves. The new cancellation case uses a real child that continues holding the sidecar after stdin closes. After owner teardown, it checks that the sidecar can be acquired independently. Source inspection confirms cleanup also waits for actual child termination.

The descriptor regression wraps the existing native open function and restores it through cleanup registered before substitution. It directly observes these outcomes:

- Held: `open, lock` while owned; `unlock, close` once on teardown.
- Refused: `open, refused, close` before the asking scope ends, unchanged on exit.
- Throwing partial acquisition: `open, lock-threw, close`, no unlock and no second close on exit.

The reported defect controls discriminate premature child cleanup suppression, delayed refusal closure and double closure. Removing the catch's close alone still lets resource cleanup provide the required single close; distinguishing those two internal paths is not an acceptance requirement. The reported unconditional-release control cannot reach the non-held cleanup branch while prompt closure and its guard remain. Neither control result leaves a required externally observable outcome untested. No additional test permutations or production test API are required.

The earlier standalone probe embeds the old helper. Its continuing reproduction documents the previous defect; it is not evidence of a defect in this revision. The new in-suite cancellation case is the regression for the corrected fixture.

## Verification and evidence

Review working directory:

`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`

Independently run at the exact reviewed SHA:

```bash
deno task test packages/git/tests/retained-repository-lifecycle.test.ts
```

Result: exit 0, one suite / nine steps, zero failures.

The [machine-written implementation receipt](/private/tmp/claude-501/-Users-tarasmankovski-Repositories-taras-executable-md/6ed03464-691d-401e-9493-c23923a83995/scratchpad/pr1-r3-command-receipt.txt) was found and read. It records these commands verbatim with successful results:

```bash
deno task test packages/git/tests/retained-repository-records.test.ts packages/git/tests/retained-repository-local.test.ts packages/git/tests/retained-repository-lifecycle.test.ts packages/git/tests/run-composition-ambient.test.ts packages/git/tests/run-composition-lazy.test.ts packages/git/tests/module-partition.test.ts packages/git/tests/public-entrypoint.test.ts packages/git/tests/api-entrypoint.test.ts
deno task test packages/workflow/tests/workflow-lifecycle-authority.test.ts
deno task lint
deno task check
deno run --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/planner-e5-child-finish-probe.ts
```

Reported results: F1 14 tests / 86 steps; workflow lifecycle two tests / 11 steps; lint and check exit 0. The old-fixture probe exits 0 and reproduces its embedded old implementation as explained above. Defect-control outcomes are implementation-reported; this review did not rerun the controls.

Unaffected F2–F6 evidence is reused from `e5f095bfe8ccd3b6aca80fd486fffd265267876c`, as the preceding revision prompt permits. The current receipt identifies that reuse and does not claim those commands were rerun. The earlier command report arrived corrupted and no original machine receipt survives for those groups; this review relies on the previously reported passing evidence, prior source review and unchanged affected modules. That provenance limitation does not require repeating unaffected evidence for this test-only revision.

The [raw R2 benchmark](/private/tmp/claude-501/-Users-tarasmankovski-Repositories-taras-executable-md/6ed03464-691d-401e-9493-c23923a83995/scratchpad/bench-repl-file-dir-evidence-r2.txt) remains the accepted bounded comparison: five equal 30-operation / 1024-byte samples, ordinary median 82.2 ms, live entry 150.4 ms and completed continuation 39.3 ms, with zero continuation mutations, Git calls or lease acquisitions. No performance budget is inferred. Source/compiled public journey assertions remain unchanged and were not rerun in this review.

Verified blob identities:

| File | Identity |
| --- | --- |
| `packages/git/src/deno/run-composition/leases.ts` | Base and reviewed SHA: `2e5565f2a9eb332dfb6dcf0295d4f4181c36aa8b` |
| `packages/git/src/deno/run-composition/errors.ts` | Base and reviewed SHA: `c474b4b4adc6222b4184258992c9a3edbd81f1bc` |
| `packages/git/tests/run-composition-lazy.test.ts` | Base and reviewed SHA: `3dc754e6da8126a9178aa882dfa1d0388f3188f4` |
| `packages/workflow/src/deno/advisory-lock.ts` | Previous and reviewed revision: `e82dc8ce2dcb371ad8ba4323c4b299dd6140437d` |

The worktree is clean at the reviewed SHA. This review changed no implementation file, historical record or earlier artifact, and inspected no CI.

## Continuity and next actor

The authoritative planning artifacts remain the [stack plan](upstream-repository-pr-stack-plan.md) and amended [PR 1 handoff](upstream-repository-pr1-file-dir-implementor-handoff.md). This acceptance is `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-pr1-planner-review-1f43f26f.md`. Earlier reviews remain preserved as historical feedback.

Settled decisions remain unchanged: foreground recorded local Results, replay before live work, ordinary middleware semantics, existing journal composition, trusted entry ownership, unchanged generated permission ceiling, passive history, joined teardown and resolved native-only L1 exclusion. No Planner blockers or unresolved structural decisions remain for PR 1. Planner review closes here.

The next role is the Architect, reviewing exact revision `1f43f26fb71a802326578300f52021d9f82448e0` against the accepted architecture and focused evidence. Product Owner review and explicit merge approval remain required. Delivery verification remains separate. This PASS does not authorize publication, merge, PR 2 implementation or GitHub changes.
