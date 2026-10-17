# Planner review: Stop correction at 01990ca4

PASS at `01990ca4dfca3d9526908ac775469c28f1be7776`, parent
`88c482b717d7443f329d010e8635506b9045109e`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. P1 is closed and the Stop increment is accepted. This verdict
does not complete section 4 or the full R6 integration.

## The admission boundary is restored

The task records its own placement only when the acknowledged projection names
that exact entry. This happens in reached(), beside the existing pending-Pause
handoff, before arm() and admit(Ok). An allocated task, a taken slot and an
admission refusal do not establish placement.

The submission's admission wait now has cleanup that cancels and joins a task
which has not been placed. Once placement is acknowledged, cancelling the caller
leaves the entry in the session's ownership. Occupancy is released after joined
cleanup for a task that never became an entry, or for an entry that settled;
an interrupted admitted entry continues to occupy its slot. These are ordinary
changes to the existing task/admission machinery, with no new entry owner or
Core interface.

The unchanged startup probe now passes both its regression and no-Stop control.
Stop during real runtime startup prevents later admission even after the held
installation is released. The integrated row checks readable paired history,
an unfinished Submit intent, no response record and no follow-up turn. The
matching control admits and runs the exact requested source. The existing
admitted-entry row still passes: Stop ends the waiting and leaves the entry
running.

The unchanged cleanup-join probe and its integrated lifecycle row also pass.
While a response control's cleanup is held, Stop has not returned, the owner
remains busy and a second message refuses. After cleanup joins, Stop returns,
refreshes the unfinished control and frees the owner; the same conversation
answers another explicit message.

The fixture's optional entry installation and held-fill seam reach real owners
without replacing their journals. Their use is accepted. Specification and
architecture changes describe the corrected ownership boundary and replace the
insufficient claim that reservation withdrawal alone prevents late admission.
The accepted no-wait and PPA3(c) journey assertions are unchanged and pass.
A1's admitting-record/Pause/continuation order remains intact.

## Independently rerun evidence

All eight commands ran from `.claude/worktrees/issue-883-pr2` at the reviewed
SHA. Each exited 0. The five probes are unchanged review artifacts in the root
checkout.

| Command | Result |
| --- | --- |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-startup-probe-88c482b7.test.ts | 1 test, 2 steps |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-join-probe-88c482b7.test.ts | 1 test, 2 steps |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-receipt-probe-f5b60c99.test.ts | 1 test, 3 steps |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts | 1 test, 5 steps |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts | 1 test, 3 steps |
| deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts | 24 tests, 129 steps |
| deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts | 38 tests, 146 steps |
| deno task test packages/cli/tests/repl-journey.test.ts | 39 tests, 71 steps |

Total: 106 tests, 361 steps, zero failures. Logs are
`pr2-stop-review-01990ca4-{startup,join,receipt,contract,owner,focused,consumers,journey}.log`.
The Implementor's reported mutation controls were not repeated by review; this
verdict rests on inspection and the frozen commands above. No full suite, CI
inspection or GitHub mutation informs acceptance.

## Continuity and next action

Exact accepted head is 01990ca4. Produced artifacts are this review, the passing
logs, the completed startup correction prompt and updated planner-handoff.md.
The earlier failing startup probe and its first output remain preserved.
No blocker remains in this increment, and no new product or architecture decision
is required. The previously accepted admission/Pause and feedback increments
remain closed.

Continue section 4's Sidekick-owned Elicit provider, configuration and compatible
metadata refresh, then complete R2 interruption cases 2/5/6 and remaining R5
integration under the frozen plan. Program binding, mounted Stop, Exit/Control-C,
question drawers and section 5's terminal evidence remain incomplete. Acceptance
adds no push, GitHub-write or CI authorization. No production file was changed
by review.
