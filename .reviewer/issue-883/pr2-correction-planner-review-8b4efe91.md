# PR 2 feedback and process-recovery correction review

PASS at `8b4efe911041a5769e32818347717c7f8298c4de`.
Parent: `1ba2c48a9e610eba30faabd433592222d95c104b`.

This closes both findings in the
[previous review](pr2-projector-output-planner-review-1ba2c48a.md). It accepts
the correction and case-1 storage recovery evidence, not the complete CLI PR.

## Findings resolved

Feedback `text` now explicitly retains the entire input sent to the next turn,
including ordered facts and their context. The projector retains each completed
canonical Prompt's input and establishes delivery only when the input at the
owning conversation/turn matches that retained text. A mismatch remains
unestablished rather than becoming a delivered fact. The corrected R2d and
negative R2d2 distinguish matching from unrelated input at the same turn.

R2g and R2h now launch independent writer and reader processes through
`runPhase` and `recovery-phase.ts`. The child installs the production host and
uses the real paired repository. The before-ready interruption occurs inside
the actual publication path; the writer exits before the independent reader
opens the retained directory. The successful writer publishes, redirects and
appends through the same facade before ending. The reader verifies the pair
and origin without appending. Tests compare the original bytes and copied
prefix across processes. No elapsed sleep supplies readiness.

Reading through the repository is sufficient for the storage-level correction
requested here. The planned root integration still observes refusal through
`runReplProgram` and its refusal screen. That remains part of the upcoming
integration work, not a new prerequisite for this scoped PASS. R2 cases 3/4
still accompany section 3's production Submit path; cases 2/5/6 accompany
section 4's owner. R2 remains open until all six cases pass.

## Focused evidence

Independently run from `.claude/worktrees/issue-883-pr2` at the reviewed SHA:

```sh
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section2-storage.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-projection-fdf67b04.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-1ba2c48a.probe.ts
```

- The submitted tiers pass: 11 tests, 57 steps, including nine recovery rows
  and both actual subprocess cases.
- All three archived probes pass unchanged: three tests, 11 steps, including
  the mismatched-input regression and matching-input control.

The Implementor reports cross-runtime recovery and lint/check passes. This
review independently ran the Deno commands above. No CI was inspected. HEAD
remained at the exact reviewed SHA, and the implementation worktree stayed
clean. Only reviewer artifacts changed.

## Continuity

Accepted foundation: Core `79d404d0`, paired storage `43d53df7`, root repository
selection `fdf67b04`, pure output windows `1ba2c48a`, and this correction
`8b4efe911041a5769e32818347717c7f8298c4de`.
No correction blocker remains from this review. Continue `sidekick/controls.ts`
and `sidekick/profile.ts`, then separate Draft/Message revisions and the shared
root admission gate with entry-slot reservation. R3, integrated R4 and the
remaining R2 evidence stay at their already planned boundaries. Full PR 2
acceptance remains R1–R8 and the 36-frame packet.
