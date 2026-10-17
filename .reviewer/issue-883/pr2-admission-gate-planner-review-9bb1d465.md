# Planner review: admission-gate increment 3 at 9bb1d465

REQUEST CHANGES at `9bb1d465b8b22fdf05cd87b6761791fa2fdb7702`, parent
`29fb689fb2f1cec53aaf8ca49560f29d2892a58d`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the
implementation worktree is clean. One blocker remains: the reservation does not
bind the existing entry-journal prefix. Increment 3 and R2 cases 3/4 are not yet
accepted. Increment 2 and its P1/A1 findings remain closed.

## P1 — an entry count does not identify the retained prefix

`submitForSidekick()` in sidekick/admission.ts:154 retains
`session.entries.length` as `prefix`. `resolved()` in sidekick/gate.ts:333
checks only that count/position, the reserved entry key and the reserved source.
It receives no retained prefix content or fingerprint. A different valid earlier
history of the same length is therefore accepted as this reservation's past.

The accepted Submit reconciliation contract in remaining-architecture.md and
storage-contract.md requires an unchanged entry-journal prefix and refuses a
changed prefix. Main-plan R2 case 4 explicitly includes changed-prefix refusal.
This is an unmet existing criterion, not a new corruption permutation or an
architecture choice. Counting earlier entries establishes an ordinal; it cannot
establish which records preceded that ordinal.

The [archived reproducer](pr2-admission-prefix-probe-9bb1d465.test.ts) executes
two valid histories through the production session:

1. `entry-1` runs `Prior A.`, then the reserved `entry-2` runs `Reserved body.`
2. A replacement history has the same entry count and the same `entry-2` source,
   but its `entry-1` runs `Prior B.` instead.

The unchanged-history control establishes the reservation successfully. The
changed-prefix row expects refusal but receives success. Both histories were
actually executed and validated by the session; this is not a malformed-entry
fixture or a content-only search.

Command from the PR 2 worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-admission-prefix-probe-9bb1d465.test.ts
```

[First output](pr2-admission-prefix-probe-9bb1d465.log): one passing control,
one failing regression, exit 1. The failure is `Expected: false; Received: true`
at the changed-prefix assertion. No rerun or production mutation was used.

## Rulings on the reported deviations

- Suspending the actual append, observing its entered latch, then ending the
  subprocess through owned unwind is acceptable. It leaves the relevant record
  unwritten and runs no success/failure continuation beyond it. Throwing would
  test a handled failure instead of the required interruption. The independent
  subprocess reader establishes what reached disk.
- Staged canonical conversation/turn/response facts are allowed by the frozen
  R2 transport-fixture boundary. The Submit intent and entry admission now use
  production admission/session/writer operations. No second storage or
  conversation owner supplies their result.
- The optional ControlJournal reservation and session StartingCheck are private
  CLI helper extensions within the delegated implementation boundary. Moving the
  real control writer into production is appropriate. No new public Core or
  product decision is required.

The actual-start human-Run path, source/revision recheck and the representative
held-preflight History-navigation row pass. The recovery happy paths distinguish
absence from the admitted exact entry and retain a resolution without repeating
source. These do not overcome P1: both R2 cases use an empty preceding entry
history and cannot discriminate equal-length prefix replacement.

The recovery row's comment about a third process is imprecise: `again` is a
second projection in the same reconcile process. Correct that description;
the frozen matrix does not require an additional third-process permutation.
Sidekick's real response-owner/control binding is still unfinished: the new
submitForSidekick helper is currently called by the recovery phase, while the
remaining section 3/4 wiring must bind it to the shared root state and final
checks. These module-level checks do not claim complete R3 or an end-to-end
Sidekick conversation.

## Independently rerun evidence

All five focused commands pass at the reviewed SHA:

| Command | Result | Complete first output |
| --- | --- | --- |
| `deno task test packages/cli/tests/repl-journey.test.ts` | 39 tests / 71 steps, exit 0 | [Journey](pr2-admission-review-9bb1d465-journey.log) |
| `deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts` | 45 tests / 170 steps, exit 0 | [Entries/controls](pr2-admission-review-9bb1d465-entries.log) |
| `deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts` | 12 tests / 59 steps, exit 0 | [Storage/recovery](pr2-admission-review-9bb1d465-storage.log) |
| `deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts` | 19 tests / 54 steps, exit 0 | [Layout](pr2-admission-review-9bb1d465-layout.log) |
| `deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-forms.test.ts` | 30 tests / 126 steps, exit 0 | [Controller consumers](pr2-admission-review-9bb1d465-controller-consumers.log) |

The first four commands pass 115 tests/354 steps; including controller consumers,
145 tests/480 steps pass. The additional prefix probe fails as described above.
No full suite, delivery-gate or CI result determines this verdict.

## Correction and continuity

Use the [ready-to-send correction prompt](pr2-admission-prefix-implementor-prompt.md).
Bind the exact acknowledged record prefix independently from the reserved entry's
ordinal. Carry that binding through the strict protocol and cold reader; compare
it before returning either admitted or absent. Keep later valid suffix records
ordinary, preserve the unchanged-prefix control, and add the single reproduced
same-length changed-prefix regression to existing tests. No wider fault matrix
is requested.

Base: 9bb1d465b8b22fdf05cd87b6761791fa2fdb7702. Produced this review, the
correction prompt, reproducer and six logs; updated planner-handoff.md.
No production code, implementation commit, memory, GitHub or CI state changed.
Next action is the prefix correction and a new focused feedback commit. Remaining
section 3 wiring, section 4/R2 cases 2/5/6, and section 5/R5–R8 plus the 36-frame
packet remain incomplete. The series remains two PRs; no push is authorized.
