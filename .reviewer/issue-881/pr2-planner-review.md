# PR 2 Planner review

**REQUEST CHANGES** at `9d8bc463297c39edd8893c8404c1dd674700cb23`.

Three reproduced defects violate the settled contract: a foreign invocation
request can execute the current body before refusal; the lexical envelope
rejects an existing BOM-prefixed document; and published phase objects and
aggregate cause arrays are mutable. The independent review and corrections are
in [pr2-independent-architecture-review.md](pr2-independent-architecture-review.md).
No Journal or persistence change is needed. PR 1 remains accepted; PR 3 remains
outside this implementation verdict.

## Reviewed revision and focused evidence

Branch `agent/issue-881-pr2`; integrated base `c7d54769`, consisting of accepted
PR 1 `080b6ec80ca74e614789e8d2252857ac281df7e5` and main
`4c0414be1010f69f11bff0d1d634623a5b08f886`. The implementation worktree was
clean and stayed at the full reviewed SHA. The Planner changed only review
artifacts and ran isolated review fixtures. No production code, commit, push,
PR, GitHub mutation, CI inspection or subagent was used.

These commands ran from `.claude/worktrees/issue-881-pr2`:

```sh
deno task test packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-journey.test.ts
deno task test packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts
```

All three exited 0: respectively **53 tests / 411 steps**, **94 / 313** and
**14 / 52**. Full outputs are retained as `pr2-planner-evidence/core.log`,
`cli.log` and `lifecycle.log`. These passing tests do not catch R1–R3; the
read-only contract probe reproduces them at this same revision.

The ten supplied control records all report nonzero exits and identical
before/after production hashes. They were inspected, not rerun against the
reviewed worktree. K1 is described as “remove the rails,” but its saved mutation
changes EXIT's rail colour to pending; it does not remove a rail. Run the
original frozen rail-removal control with the affected frame evidence in the
revision. Preserve the complete first failure, rather than only the generic
`expect(received).toBe(expected)` line.

## Independent structural checklist

This table records the independent review of the seven existing checks; it
adds none. The overall verdict is REQUEST CHANGES.

| Frozen check | Review result |
| --- | --- |
| 1. Canonical execution, exact delegation and outcome authority | **Fails R1.** Canonical failure capture and ignored middleware returns have passing focused evidence, but an authentic foreign request reaches the wrong continuation. R3 also contradicts the accepted immutable reporting contract. |
| 2. Existing owners, cleanup order and consumer lifetime | Held body/cleanup/middleware cleanup, cancellation, failed teardown and session retirement pass the focused CX/L3 suites. The live journey stopped on a missing Plan directory during cleanup; its cause is unresolved, so the journey supplies no additional acceptance of this requirement. |
| 3. Generated capabilities remain narrow; presentation grants no authority | Supported by the generated execution and lifecycle tests and the unchanged capability ownership boundary. Private CurrentOccurrence data selects presentation lineage, not permission or durable identity. |
| 4. Pure canonical inspection and exact replacement ownership | **Fails R2.** Scanner reuse and retained-range replacement have passing evidence, but document-envelope equivalence does not hold. |
| 5. No persistence change; observed/unobserved equivalence | Supported by the focused Core/session comparisons of output, bindings, failure and serialized Journal bytes. No new retained lifecycle record or field was introduced. |
| 6. Prefix isolation, cold reads and actual output ownership | Focused suites and the independent offscreen/cold checks below pass. Cold inspection of the supplied settled run and its earlier prefix leaves Journal/provider bytes unchanged. |
| 7. Root view data, measured admission, mounted targets and no hidden resources | Supported by the focused rendering/admission/source-reading suites and inspected fitting/description path. The complete 44-pair visual review is not accepted here because the supplied packet was changing. |

## Planner journey: what was actually walked

The Planner drove the real Deno entrypoint at the reviewed SHA through a private
tmux socket, with a local provider and temporary working directory. No
presentation state was injected. Scripts, normalized actions, raw ANSI/text
captures and selected rasterizations are in `pr2-planner-evidence/`.

| Accepted step | Independent evidence and result |
| --- | --- |
| 1. Submit original Plan; nested ACTIVE reading | **Passed at all three profiles.** `captures/nested-running-*` shows Evaluate/Plan, nested rails and independent ACTIVE badges inside the pane. |
| 2. Preview/decisions; close and reopen unanswered | **Passed at all three profiles.** `plan-review-controls-*`, `plan-dismissed-*` and `plan-reopened-*`; source rows compare unchanged, and the pending question remains available. WAITING belongs to the actual nested Elicit; its active ancestors need not inherit that badge. |
| 3. Approve and inspect admitted source | **Not completed live.** Approval ends this attempt with a missing Plan session-directory diagnostic, before generated admission. The first failure is preserved. |
| 4. Invalid and populated project form | **Not reached in this live walk.** Passing focused tests and Implementor captures are not described as a Planner walk. |
| 5. Preview, write once, Output before Source | **Not reached live.** Independent cold reading confirms retained Output begins with the rendered document and includes the real final report. It does not prove the live approval/write path. |
| 6. Earlier prefix, offscreen advance, return live | **Passed at all three profiles.** While the provider was held, select Entry 1 admitted. Release it offscreen; the provider completes and the question arrives. `offscreen-before-*` / `offscreen-after-*` preserve the selected source; `offscreen-return-*` shows the current pending question after returning live. |
| 7. Resize and populated recovery | Supported sizes were exercised in the ACTIVE, question and historical states. **Populated-question refusal/recovery was not reached live.** No complete-step claim is made. |
| 8. Cold head and earlier-prefix reopen | **Passed at all three profiles.** `planner-cold-final.log`, `independent-cold-settled-*`, `independent-cold-historical-*` and `independent-cold-prefix-reopened-*`. No live badges reappear. |

The decisive live log is `planner-journey-pty-4.log`. At approval, the diagnostic
names `/Users/tarasmankovski/.xmd/plan/sessions/3b1a41e4f5c8bc727bb15aa945f5f7023733b1dd76801c23260f2b42ae2f75ba`
and says the directory was already gone. Another evidence journey was actively
running against the same host storage during review. Concurrent interference is
a possible explanation, not an established cause or an additional #881 code
finding. Preserve this failure and complete the remaining live steps in a
non-overlapping review run after the revision; do not assign that Planner work
to the Implementor.

For cold verification, the Planner reopened the supplied settled execution
`77890cfe1f8dbaefdf2c69b3b2cbd586`, selected Entry 1 and then its first admitted
prefix, exited and reopened the actual printed prefix URI:

```text
xmd://repl/77890cfe1f8dbaefdf2c69b3b2cbd586/entries/entry-1?at=yield:root:0&inspect
```

Across these cold reads the Journal stays **49,022 bytes / 38 lines**, SHA-256
`a7fd1d0e3105a003474f07242dcc1404f63d4a7193f98c582c9572889deb4f5a`.
The independent provider log stays **31,149 bytes / 42 lines**, SHA-256
`e69738b96e17f52c1a392a9e9070b01588b8246bee9bcef6def82793f674aa9d`.
`repl-journey.test.ts` TL10 supplies the source-load counters (zero compiles,
zero Markdown reads and zero questions); file/provider hash
comparisons alone are not claimed to measure source loads.

Early review-harness failures are preserved separately. They concern tmux socket
access in the sandbox, the absent Transcript heading in narrow mode, requiring
a parent's badge/guidance instead of checking the pending question, and reading
a wrapped exit URI at 72 columns. These are corrected review helpers, not
product defects or unexplained green reruns. The cold-prefix URI is read at
160 columns before reopening; its captures then exercise every profile.

## Evidence packet and handback corrections

The handed-back packet was being rebuilt during review. Its captures, actions,
provider log and journey script changed after the checksum list was written;
the gallery manifest and contact sheets were absent. The saved integrity
snapshot found only 37 of 319 listed files matching. This records the packet at
that time, not a claim about who changed it or its final state. The Planner has
not accepted or claimed to open all 44 visual pairs. Keep the frozen gallery
separate from supplementary journey evidence and return a complete stable
packet for the revised SHA.

The reviewed commit also tracks an approximately 79,900-line scratch test log,
`.cliall.log`, and `.controls.json` at the repository root. The branch comparison
`git diff --check c7d54769..9d8bc463` exits 2 because that log has trailing
whitespace and a blank final line; output is retained in
`pr2-planner-evidence/branch-diff-check.log`. An empty working-tree diff does
not check the committed change. Remove scratch outputs from the product commit
and retain useful evidence under the review directory.

Correct the self-assessment's measurement note: `ReplRenderer.measure` already
returns copied bounds at this revision. No renderer architecture decision is
opened by that inaccurate note.

## Ready-to-send revision prompt

> Revise PR 2 from `9d8bc463297c39edd8893c8404c1dd674700cb23` under the accepted
> contracts. Fix R1–R3 in `pr2-independent-architecture-review.md`: correlate
> each terminal with its exact request before claiming or running work; make
> pure lexical envelope extraction match existing execution, including a BOM
> without a header; and freeze published phases and explanatory aggregate
> member arrays. Extend the existing C1, C3/C4 and C5 tests with the supplied
> discriminating reproductions. These restore frozen requirements and require
> no new API, persistence or Journal design.
>
> Remove the committed scratch log/control outputs from the product diff,
> retain their evidence separately, and correct the copied-bounds statement.
> Run the frozen Core and CLI commands, the supplemental lifecycle command,
> and a base-to-feedback `git diff --check`. Commit promptly once the focused
> evidence passes. Return the exact SHA, parent and base, complete first
> failures and byte restoration for the relevant controls, including the
> frozen rail-removal control, and a stable 44-pair gallery/checksum packet
> from that revision. Supplementary journey captures do not enlarge the
> frozen gallery. Do not push or open a PR.
>
> Return implementation feedback only. The Planner retains the remaining
> live journey, independent review of the corrections, and accept-or-request-
> changes verdict. Keep PR 1's accepted evidence and PR 3's scope unchanged.

Continuity: this review returns REQUEST CHANGES against the full SHA above.
The three contract corrections are settled, not questions for the Implementor.
The live journey and full gallery remain incomplete as explicitly recorded;
they are not represented as an approval or handed to the Implementor to judge.
