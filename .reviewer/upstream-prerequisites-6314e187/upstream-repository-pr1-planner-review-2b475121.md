# PR 1 Planner feedback: settled scoped-setup changes

**Verdict: PASS for the completed, settled portion of the scoped-setup amendment at `2b475121ab76ec1147c7661c76200efd80488506`.** Exact base: `f79f6730784a7ecba7253dcd35e6e5567293876c`. This is a bounded feedback acceptance. PR 1's amended handoff remains incomplete at S1, the runtime-to-execution setup route; this verdict neither approves retaining the carrier as the final design nor closes the handoff's hold.

The inspected worktree is clean at that SHA on `agent/repl-file-dir-pr1`, in `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`. The diff from previously reviewed `56723fe372ef26db24183d651a055d8eff6b538d` contains the reported 29 files. No CI or GitHub state was inspected. The user reports the signed commit was pushed to draft PR #902.

## Accepted implementation

Ordinary setup receives existing readonly execution installations and returns prepared readonly installations inside the execution scope, before canonical `executeInstalled`. REPL `runEntry` calls setup after its Agent attachment and running-slot finalizers. Each invocation creates fresh provider state; lazy acquisitions remain owned by that scope. Ordinary and isolated-child paths use the returned installations. Without setup, the REPL uses the original installations; the unsupported ordinary setup returns its input unchanged.

Native `retained-repository/installer.ts` wraps the captured `evaluation.files` already supplied, preserving read/write permission tables and other installation members. An installation with no evaluation or captured access gains none. The session-specific `withEntryFileAccess` transformation and separate Files result are removed. Native `prepareReplRepository` replaces the former native entry-host constructor; no contextual installation API is added, and `/api` still exposes eight contextual APIs.

The redundant repository record-owner type, fields, name/fingerprint inputs, setup identity arguments and foreign-owner rejection are removed. Structural/version/request/name/result validation remains. The normal session passes `EntrySegmentStream` to execution. E7 now performs identical source in two entries, removing the file between them; the second writes it again, both local records have the same name, and separate entry segments prevent one entry replaying the other's work. This tests the accepted isolation boundary.

The coroutine selection memo and actual unfinished-prefix regression remain intact. Completed local replay still precedes canonicalization, discovery, lease acquisition and native mutation. Existing result/refusal, persistence-failure and generated ceiling behavior is retained. Native L1 lease/helper code, ordinary lease/errors, the preserved lazy regression, entry-segment implementation, `deno.lock` and `package.json` are unchanged from the previous reviewed revision.

Architecture/specification changes describe the implemented scope, result meaning, segment isolation and generated access. They remove the obsolete owner label and do not invent a resolved setup-availability route. No broader repository feature is introduced.

## S1 remains returned to the Architect

The ordinary functions still reach `runDocument`, isolated `runProfileChild` and `runEntry` through existing arguments/profile options. Renaming their types does not complete transport removal. `repl-repositories.ts` remains. Those facts match the Implementor's declared exclusion and preserve the existing behavior while the handoff forbids choosing a route. They are not accepted as the final assembly.

The existing handoff's S1 request remains: name the concrete existing composition boundary and exact module mapping that makes selected native setup available in those scopes after factory forwarding is removed. The accepted ordinary function signature, existing scope, `.around()` APIs, generated ceiling, stream isolation and L1 are settled and must not be reopened. A scope supplies lifetime, not lexical module availability. No new routing API, registry or lifecycle protocol is approved by this review.

The handoff citation to `useDenoRepl` is corrected from `deno-repl.ts:24` to `:21`; the original handoff is preserved in `planner-review-2b475121/`. Its construction table remains an explicitly dated trace of `56723fe3`, not a claim about every line number after this revision. No Architect-owned record was edited.

## Independent focused evidence

Run from the inspected PR 1 worktree:

```bash
deno task test packages/git/tests/retained-repository-local.test.ts packages/durable-streams/tests/structured-concurrency.test.ts packages/cli/tests/repl-repositories.test.ts packages/cli/tests/run-profile.test.ts packages/cli/tests/run-composition-nested.test.ts packages/git/tests/api-entrypoint.test.ts packages/git/tests/retained-repository-records.test.ts
deno test --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/architect-pr1-concurrent-selection-live-prefix-setup.test.ts
```

First command: exit 0, eight tests / 70 steps. Adapted Architect probe: exit 0, one test / one step. Its actual captured prefix contains selection records on both `root.0` and `root.1`; continuation writes only `sentinel.md`, with `rev-parse --show-toplevel` and `rev-parse --git-common-dir` supplying the new suffix's one discovery. The copied probe changes setup/import/returned-installations use only; original probe and its historical failure evidence remain preserved. No scheduling or journal protocol is added.

This subset independently covers the changed record shape/admission, composed local results and replay, generated preparation, E7 segments, no-setup pass-through, ordinary profile/isolated-child preservation and API inventory. Other F groups below are implementation-reported evidence read from the receipt, not independently rerun by this review. No exhaustive battery or CI is required for this feedback verdict.

## Reported evidence and receipt precision

The [R5 machine-written receipt](/private/tmp/claude-501/-Users-tarasmankovski-Repositories-taras-executable-md/6ed03464-691d-401e-9493-c23923a83995/scratchpad/pr1-r5-command-receipt.txt) was read in full. It records:

| Group | Recorded successful result |
| --- | --- |
| Prescribed local/composition and adapted Architect probe | Two tests / 30 steps; one test / one step |
| F1 after ordering-assertion fix | 14 tests / 85 steps |
| F2 | 37 tests / 389 steps |
| F3 | 41 tests / **171** steps |
| Extra ordinary construction | Four tests / eight steps |
| Workflow lifecycle | Two tests / 11 steps |
| F4 Deno / Node / Bun after journey correction | Three tests / six steps; **18** Node tests; 18 Bun tests |
| F5 build / compiled / discovery | Exit 0; one test / one step; 14 tests / 65 steps |
| F6 | Exit 0; raw comparison below |
| Lint / typecheck, appended exact-revision reruns | Both exit 0 |

Use these machine-recorded counts instead of the summary's 169 F3 steps and 20 Node tests. On 2026-10-13, the Planner read the receipt's appended corrections and successful exact-revision reruns: `deno task lint` exit 0 (formatting clean, warning output retained) and `deno task check` exit 0. The earlier lint exit 1 remains recorded, explicitly identified as preceding `deno task fmt`; it was not silently replaced. The receipt gap is closed. These are receipt-verified implementation results, not additional commands independently run by this review. Lint is not a feedback prerequisite, and this reconciliation does not imply delivery acceptance. The worktree was independently rechecked clean at the same full SHA. The pre-reconciliation review is preserved in `planner-review-2b475121/upstream-repository-pr1-planner-review-2b475121-before-receipt-reconciliation.md`.

The [raw R5 benchmark](/private/tmp/claude-501/-Users-tarasmankovski-Repositories-taras-executable-md/6ed03464-691d-401e-9493-c23923a83995/scratchpad/bench-repl-file-dir-evidence-r5.txt) reports five equal 30-operation / 1024-byte samples: ordinary median 74.0 ms, live entry 134.5 ms and completed continuation 39.1 ms. Continuation reports zero writes, deletes, ensures, Git calls and lease acquisitions. This satisfies the bounded measurement requirement without a performance threshold. It does not replace the continuation regression or public journey.

The receipt and control output report failures when cloning a ceiling-less installation, substituting the whole stream for an entry segment, or discarding prepared installations. The ordinary empty-installations control is not discriminated by `run-composition-deno`, but is by the existing run-profile/nested tests already in F3. This review did not rerun controls. No additional acceptance cases are required.

The saved first failures and source changes support the two evidence-race diagnoses: concurrent writes have no specified cross-branch order, so sorting that assertion preserves its meaning; waiting for deletion with a deadline preserves the terminal journey's absence assertion without racing the prior write. These corrections do not weaken replay or permission acceptance. The user reports repeated clean runs after correction. This planning review creates no GitHub issue or other external record; any required repository flake bookkeeping remains separate from this code verdict.

## Continuity and next action

Base remains `f79f6730784a7ecba7253dcd35e6e5567293876c`; exact reviewed feedback SHA is `2b475121ab76ec1147c7661c76200efd80488506`. Artifact: `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-pr1-planner-review-2b475121.md`. The stack plan, accepted architecture report, previous feedback reviews and historical implementation/evidence remain preserved. Only this new review artifact and the handoff's citation correction were written; implementation was not edited.

No new implementation defect was found in the settled portion. S1 remains the one structural planning blocker. Next actor: Architect, review this exact revision and resolve the concrete setup route; then Planner makes the remaining assembly handoff decision-complete. Further implementation requires applicable separate authorization and a new exact feedback SHA with every focused command/result. Product Owner review, delivery verification and explicit merge approval remain separate gates. This PASS authorizes no implementation, publication, PR change, merge or PR 2 work.
