# Mounted Sidekick review at 86debcb9

**REQUEST CHANGES — 2026-10-14.** The mounted slice has two confirmed defects
against the frozen plan. Follow [the correction prompt](pr2-mounted-implementor-correction-86debcb9.md).
No new product or architecture ruling is required.

## Exact revision

Reviewed `86debcb96ba8f547d78712b2de66fcc1ed709ef9`, parent
`004de839e85e53cff4d960cb515729d350383f30`, branch agent/issue-883-pr2.
Signature independently verifies G, tarasm@gmail.com. The implementation
worktree is clean. The commit changes 24 files, +3441/-589. Review made no
production or index changes and performed no push, GitHub mutation or CI inspection.

## Findings

### M-P1 — cancelling the storage handoff can block all later entry records

In packages/cli/src/repl/sidekick/history.ts:1321, upgradeExecution yields
writer.hold() before entering the try/finally that releases it.
MovableWriter.hold() sets holding = true before waiting for issued appends
to settle (journal.ts:328). Cancellation during that wait therefore reaches
no release. Once the original append finishes, the next append waits forever.

This violates the handoff cancellation/lifetime contract in plan steps 1–2,
M2's preservation of a running entry, and AGENTS.md Code Rule 16's requirement
to establish cleanup before acquisition or a suspending wait. The whole-publication
hold is necessary; its cleanup must cover acquisition too.

[The production probe](pr2-mounted-handoff-cancel-probe-86debcb9.test.ts)
holds a real append, starts upgradeExecution, cancels it while hold() waits,
then releases the append and attempts another record through the same facade.
That record reaches the failure deadline. Its paired ordinary-publication-failure
control appends successfully.
[Verified failure output](pr2-mounted-handoff-cancel-probe-86debcb9-verified.log)
and [final rerun](pr2-mounted-handoff-cancel-probe-86debcb9-final.log)
preserve the observation. The initial first log is an authoring typecheck
error in the probe's race operands, corrected before interpreting product
behavior; it is not product evidence.

### M-P2 — Sidekick Submit omits the actual-start recheck

The new root adapter in program.ts:807 calls current.submit(source).
submitForSidekick calls that adapter after reserving and journaling, but its
AdmittingSession surface has no start check. ReplSession asks the optional
StartingCheck after preflight (session.ts:1054); omission answers Ok.
Human Run still supplies stillAdmissible with its exact reservation and fresh
root facts. The mounted Sidekick path does not.

[The mounted probe](pr2-mounted-start-recheck-probe-86debcb9.test.ts) uses
runReplProgram, the real response controls and a held component-file read in
ordinary entry preflight. The person edits Draft while that read is held.
Releasing it admits entry-1 from the stale reserved source anyway. The paired
unchanged-Draft control correctly admits that entry once.
[First output](pr2-mounted-start-recheck-probe-86debcb9-first.log) preserves
both observations. The failure is Expected 0 / Received 1, not an environment
limitation.

Step 3 of both the frozen plan and prompt explicitly requires the same
actual-start route/revision/liveness checks as human Run. This is missing
production plumbing for an accepted gate, not a new product decision.
Restore the existing predicate at the session's start boundary using the exact
reservation and current root facts.

## Evidence and scope disposition

All six assigned commands independently pass at the reviewed SHA:

| Selection | Tests | Steps | First output |
| --- | ---: | ---: | --- |
| Mounted presentation / journey / lifecycle | 11 | 48 | [log](pr2-mounted-review-86debcb9-mounted-first.log) |
| Entries / history / agent execution / controls / output | 51 | 201 | [log](pr2-mounted-review-86debcb9-entries-first.log) |
| Storage / recovery / configuration | 11 | 61 | [log](pr2-mounted-review-86debcb9-recovery-first.log) |
| Journey / agent interface / agent journey / forms | 71 | 185 | [log](pr2-mounted-review-86debcb9-journey-first.log) |
| Route / layout admission / presentation style / source reading | 28 | 130 | [log](pr2-mounted-review-86debcb9-layout-first.log) |
| Execution / lifecycle | 6 | 39 | [log](pr2-mounted-review-86debcb9-lifecycle-first.log) |
| Total | 178 | 664 | |

Exact commands, all run from the implementation worktree:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

The paired probes each fail only their regression arm; both positive controls
pass. These expose gaps in the selected evidence for existing lifecycle and
admission requirements. They do not expand the frozen UI contract.

The added whole-publication writer hold addresses the concrete M2 failure
reported in the handback and belongs to this connection. It does not need a
separate architecture approval. M-P1 concerns its cancellation coverage.
The stricter field-focus helpers, extracted shared terminal fixture and
explicit Bindings selection are consistent with the plan's fixture clause;
the six selections preserve their claims. The reported notification mutation
targets the required no-input first-reply observation; its code path and
independent M5 tests were reviewed. Review did not repeat that mutation.

The passing selected evidence and these allowed adaptations do not establish
acceptance while M-P1/M-P2 remain. No unrelated hardening or permutation matrix
is assigned.

## Continuity

Last accepted prerequisite: signed 004de839. Configuration P1/P2 and R2 remain
closed; M-P1/M-P2 are findings about the new mounted connection. The section 5
mounted increment at 86debcb9 is unaccepted. Deferred preview, question/Configure
drawers, configuration controls, Sessions integration, full terminal acceptance
and the 36-frame packet stay deferred.

Next Implementor action: apply the linked two-finding correction on 86debcb9,
promote the paired regressions, run the assigned focused evidence and return one
signed feedback commit. No delivery action opens.
