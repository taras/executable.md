# Planner review: Submit prefix correction at 32bbd7cc

REQUEST CHANGES at `32bbd7ccdf222c12f850176dc27210d0980d5e04`, parent
`9bb1d465b8b22fdf05cd87b6761791fa2fdb7702`, branch `agent/issue-883-pr2`.
HEAD matches, signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. The changed-prefix defect is corrected. One explicit part of
the correction remains unmet: outstanding entry appends are not settled before
the snapshot and Submit intent. Increment 3 and R2 cases 3/4 remain unaccepted.
Increment 2 and P1/A1 stay closed.

## Accepted correction

The ordinal and retained-prefix binding are separate. The strict Submit payload
requires record count, UTF-8 byte count and digest; the reader measures the actual
file bytes at the bound record boundary. It checks those bytes before either an
absent or admitted finding, and permits later suffix records.

R2k executes two valid preceding histories in separate processes. Their record
and byte counts match, their digests differ, and replacing the first history
causes reconciliation to refuse without an append. Its unchanged-history control
resolves absent against a non-empty preceding history. The two R3 rows cover
refusal before both findings; strict-record rows cover missing binding data.
R2i/R2j remain green. The corrected description of `again` is accurate: a second
projection in the reader process, not a third process.

The optional phase source and parent-test journal replacement are accepted. The
replacement is the fault fixture; both candidate histories were produced by the
real session. No further process, runtime or corruption permutations are needed.

## P1 — the snapshot precedes acknowledgement of an append already in flight

The [correction prompt](pr2-admission-prefix-implementor-prompt.md) explicitly
requires taking the snapshot under the held slot **after outstanding entry
appends have settled**, while preserving readiness and teardown checks.

`submitForSidekick()` at admission.ts:166–192 reserves an ordinal, calls
`bindRetainedPrefix(file.entries)`, then acknowledges `journal.began()` before
asking the session to submit. Neither that path nor `bindRetainedPrefix()` waits
for the execution writer. `EntryJournal` carries only a path. Holding the next
slot prevents another submitter taking it; it does not join a previous entry's
append. An append-only file can still be mid-write or awaiting acknowledgement.

The [reproducer](pr2-admission-prefix-settlement-probe-32bbd7cc.test.ts) seeds a
valid paired conversation, opens the production session, and holds a real prior
entry's admission append inside the filesystem host. While the writer reports
`appending === true`, production `submitForSidekick()` reads the file and
production `controlJournal()` writes Submit intent. The session's later busy
refusal comes after that intent. Releasing the append lets the prior entry finish.

The assertion expects no intent during the held append, but observes one. The
control finishes the prior entry first and passes. This is the explicit snapshot
ordering from the existing correction, not a new acceptance criterion.

Command, from the PR 2 worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-admission-prefix-settlement-probe-32bbd7cc.test.ts
```

[Behavioral output](pr2-admission-prefix-settlement-probe-32bbd7cc.log): control
passes; held-append row fails `Expected: false; Received: true`. Probe preparation
outputs are also preserved: an initial TypeScript narrowing error, then a first
behavioral run whose response identifier was corrected to the seeded `r1`.
The final correctly identified fixture produces the same ordering failure.
No production mutation was used.

The reproducer deliberately releases the held append after the current call
returns. Adapt that synchronization when integrating the correction so a correct
wait is released by the test owner rather than deadlocking the test. The ordering
observation, not that temporary synchronization, is the required assertion.

## Independently rerun evidence

All four frozen commands pass at this SHA:

| Command (`deno task test` with these files) | Result |
| --- | --- |
| packages/cli/tests/repl-journey.test.ts | 39 tests, 71 steps |
| packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts | 45 tests, 172 steps |
| packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts | 12 tests, 63 steps |
| packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts | 19 tests, 54 steps |

Total: 115 tests, 360 steps, zero failures. Logs are beside this review as
`pr2-admission-prefix-review-32bbd7cc-{journey,entries,storage,layout}.log`.
Controller-consumer reruns were not needed because session.ts is unchanged.
No full suite, CI result or GitHub action informs this verdict.

## Continuity

Preserve 32bbd7cc and the accepted prefix comparison. Apply the
[settlement correction prompt](pr2-admission-prefix-settlement-implementor-prompt.md)
and return a focused feedback commit. Increment 3/R2 cases 3/4 remain pending.
Remaining section 3 wiring, section 4/R2 cases 2/5/6 and section 5's terminal
packet remain incomplete. No production edit, push, GitHub mutation or memory
compaction was performed by this review.
