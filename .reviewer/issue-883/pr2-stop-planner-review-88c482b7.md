# Planner review: Stop at 88c482b7

REQUEST CHANGES at `88c482b717d7443f329d010e8635506b9045109e`, parent
`2fddcf6b49859e630fc21ec3372a6bd765fb415c`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. One existing Stop requirement fails. The accepted feedback
increment remains closed at 2fddcf6b.

## P1: an allocated but unadmitted entry survives Stop and admits later

The accepted contract distinguishes task allocation from durable entry admission.
Stop before admission prevents the entry from starting; Stop after admission
leaves that entry running. This distinction is explicit in planner-handoff.md's
Stop/admission sections, storage-contract.md's Submit boundary and
[remaining-architecture.md](remaining-architecture.md)'s journey 3. A1 already
established that busy startup is not an
admitted entry.

The production session checks the caller's starting terms before begin(), then
allocates a task in its own scope and waits for its admission. That task can
suspend inside runtime Execution.document before the admitting record exists.
Cancelling submitForSidekick withdraws reservation.live but does not cancel
this task. The starting check has already run, so the task does not ask about
the withdrawal again. Stop joins the cycle, not the unadmitted startup it left
in the session.

The [startup probe](pr2-stop-startup-probe-88c482b7.test.ts) uses the real owner,
Submit helper, entry session/compiler, paired repository and response ceiling.
An entry-only ExecutionInstallation holds runtime document delegation at the
same boundary used by the accepted PPA3(c) evidence. Before Stop, session.live
is true and the entry list is empty. Stop returns with reservation.live=false
and still no admitted entry. Releasing startup then admits entry-1, runs its
literal source and produces LATE-ADMISSION as successful output. The no-Stop
control releases the same boundary and correctly admits exactly that entry.

This is a product failure, not missing test coverage or a new cancellation
preference. The existing withdrawal row injects an AdmittingSession whose submit
only suspends; it never allocates the real session task. It proves withdrawal of
the bit, but cannot discriminate this later startup boundary.

Correct ownership of allocated work up to exact durable admission. Stop must
cancel/join an unadmitted startup or otherwise prevent it from ever admitting,
without leaving it running behind a stopped owner. The actual admitting fact,
not session.live or task allocation, decides when an entry becomes independent.
Preserve admitted-entry survival, no invented terminal/settlement, exact-entry
completion, the journal grammar and authoritative fatal failures.

## Boundaries retained from the increment

The conversation holder now belongs to the owner's captured scope rather than
the message that first opened it. A later explicit message continues the same
conversation after a stopped turn. Completed response/delivery claims read the
actual canonical turn matched by its input, and Stop refreshes retained history
before releasing the busy owner. These changes address the reported lifetime,
ordinal and stale-reading defects and should be preserved.

The [join probe](pr2-stop-join-probe-88c482b7.test.ts) holds a real response
control's cleanup. Stop remains pending, busy remains true and another message
is refused until cleanup is released. It then returns with refreshed unfinished
control history, and the same conversation answers immediately. Its idle-Stop
control passes. This supplies direct ordering evidence for the explicit halt;
the Implementor's reported non-discriminating mutation does not itself establish
that order. No production mutation was used by review.

Reservation-owned withdrawal is accepted as the cleanup's home; its current
reach is insufficient once the independent session task has been allocated.
The extracted harness is ordinary test module movement. The already-admitted
entry row remains green and shows an unanswered Submit intent and no follow-up
turn. Mounted Stop, Exit/Control-C and question ownership remain later work.

## Independently rerun evidence

All commands ran from `.claude/worktrees/issue-883-pr2` at the reviewed SHA.

| Command | Result |
| --- | --- |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-receipt-probe-f5b60c99.test.ts | 1 test, 3 steps; passes unchanged |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts | 1 test, 5 steps; passes unchanged |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts | 1 test, 3 steps; passes unchanged |
| deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts | 24 tests, 126 steps; passes |
| deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts | 38 tests, 146 steps; passes |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-join-probe-88c482b7.test.ts | 1 test, 2 steps; passes |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-startup-probe-88c482b7.test.ts | No-Stop control passes; Stop regression fails |

The five reported commands pass 65 tests/283 steps. With the join probe, passing
evidence is 66 tests/285 steps. Reported-command logs are
`pr2-stop-review-88c482b7-{receipt,contract,owner,focused,consumers}.log`.
Both new probes and their first runtime outputs remain beside this review.
An initial startup-probe setup typecheck failure is separately preserved in
`pr2-stop-startup-probe-88c482b7-setup-typecheck.log`; the runtime reproducer
uses an entry-only installation rather than a nonexistent request.source member.
No full suite, CI inspection or GitHub mutation informs this verdict.

## Continuity and next action

Exact reviewed head is 88c482b7; latest accepted increment remains 2fddcf6b.
Produced artifacts are this review, the
[correction prompt](pr2-stop-startup-implementor-prompt.md), the startup/join
probes and outputs, passing focused logs and updated planner-handoff.md.
P1 is the only blocker in this review. Correct the real pre-admission startup
window and hand back a signed feedback commit before the next increment.

No new product or architecture decision is required to restore the existing
admission boundary. Earlier accepted admission/Pause and feedback behavior stays
closed. Sidekick Elicit, configuration, metadata refresh, R2 interruption cases
2/5/6, program binding and section 5 remain incomplete. The current module tier
does not establish complete R3/R6 or terminal integration. No push, GitHub or
CI authorization is added.
