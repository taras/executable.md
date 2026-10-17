# Planner review: admission-gate increment 2 at 29fb689f

PASS at `29fb689fb2f1cec53aaf8ca49560f29d2892a58d`, parent
`cf3c65268600341c571b5fc2e871612c28113c81`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the
implementation worktree is clean. Increment 2 is accepted. P1 remains closed;
A1's implementation now satisfies the settled architecture and aligned
PPA1–PPA6 evidence. No blocking finding remains in this increment.

This accepts responsive submission, pending Pause and exact-entry completion.
It does not accept the unfinished reservation/recovery work or complete PR 2.
Increment 3 may proceed under the existing plan.

## Accepted implementation and evidence

The session exposes its controller only when the running entry has a validated
durable position. `begin()` resets that fact for each task; allocating busy work
alone no longer makes startup a live Pause target. Requests arriving before
admission therefore remain on the root's exact reservation.

The append observer reprojects the acknowledged whole history and calls
`reached()`. P1's exact-key check remains intact. The ordered transition is
`positioned = true`, `held.arm()`, then `held.admit(Ok(undefined))`, with no
suspension. The file stream persists its append before calling that observer,
and does not return to the durable continuation until the observer returns.
The separately spawned arming waiter is removed. This establishes A1's required
ordering from the production control flow, rather than from a scheduler result.

`arm()` consumes the request once, so later appends cannot re-arm the entry after
Continue. Entry-owned disarm cleanup is registered before `runEntry()` can
append its admission, and runs while that task still owns the session, before
the session becomes available to a successor. Exact-entry completion, P1's
refused-startup behavior, the mounted tree and footer geometry are preserved.
application.ts, program.ts and sidekick/gate.ts are unchanged from cf3c6526.

| Frozen evidence | Review result |
| --- | --- |
| PPA1 | Both original no-wait J1 behaviors and the single-burst row remain intact and pass. |
| PPA2/PPA5 | All three profiles retain pending controls, focus and geometry. The real compiler's first returned eval block is observed at invocation: zero at the hold, one after Continue, still one at the question. Exact admitted source and entry count are retained. |
| PPA3(a) | Ordinary preflight refusal discards the pending request; its valid successor plays. |
| PPA3(b) | The runtime metadata failure follows durable admission and precedes authored work. The journey proves the readable failed entry and a successor running without Continue; the Tier R4 session row observes entry-1, pausing and zero releases synchronously at the seam, then joined failure and controller reset. |
| PPA3(c) | Mounted Pause during held startup remains pending with no admission or Continue. Releasing startup admits the exact entry before its hold; its first eval remains uninvoked until Continue and then runs once. |
| PPA4 | Responsive Draft editing, Exit cancellation/join and cold reopening remain passing. |
| PPA6 | The earlier entry's handle waits through its teardown and remains bound to that entry after a later entry starts. |

The PPA3(b) split is accepted. The frozen matrix explicitly permits session
fixtures, and synchronous RootMetadata composition cannot suspend to expose a
terminal frame. Its two rows jointly establish the required seam and product
consequence without adding a new production hook or weakening the criterion.

The reported inability to make the old spawned waiter fail is not an evidence
blocker. The matrix requires the production transition to order arming, plus
direct first-authored-step observations. Both are present. A passing scheduling
experiment would not establish that structural property; the source trace above
does. No new race permutation or mutation exercise is requested. The reported
early-live mutation control is corroboration, not a separately rerun check.

architecture.md and specs/repl-spec.md now distinguish setup `__root__` import
from authored expansion and describe the synchronous handoff, pending startup
Pause and reachable armed-without-hold cleanup.

## Independently rerun checks

Each command ran at the exact reviewed SHA from
`.claude/worktrees/issue-883-pr2`; complete first-run output is retained below.

| Command | Result | Output |
| --- | --- | --- |
| `deno task test packages/cli/tests/repl-journey.test.ts` | 39 tests / 70 steps, exit 0 | [Journey log](pr2-admission-pause-review-29fb689f-journey.log) |
| `deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts` | 44 tests / 164 steps, exit 0 | [Entry and control log](pr2-admission-pause-review-29fb689f-entries.log) |
| `deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts` | 11 tests / 57 steps, exit 0 | [Storage and recovery log](pr2-admission-pause-review-29fb689f-storage.log) |
| `deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts` | 19 tests / 54 steps, exit 0 | [Layout log](pr2-admission-pause-review-29fb689f-layout.log) |
| `deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-forms.test.ts` | 30 tests / 126 steps, exit 0 | [Controller consumer log](pr2-admission-pause-review-29fb689f-controller-consumers.log) |

The four frozen commands pass 113 tests/345 steps. Including the affected
controller consumers, the focused review passes 143 tests/471 steps with no
failures. No full suite, lint/check, documentation gate or CI result was needed
for this verdict; the Implementor's additional gate results were not rerun.

## Preservation and continuity

The six pre-correction files remain recoverable in the tagged commit
`issue-883-pr2-a1-revert-state^{}` =
`b721df6c43ae67a12796e801aaf7893011c82184`. The Planner independently verified
all six files against the archived SHA-256 manifest and the complete diff
against the saved diff. The Implementor's deliberate reconciliation preserved
that work and accepted P1; it was not an unexplained overwrite.

Produced this review and five focused logs; updated planner-handoff.md and the
increment-2 handoff/prompt status. No production file, implementation commit,
memory, GitHub or CI state was changed during review. No push is authorized.

Next: increment 3's durable reservation/reconciliation, actual-start guards and
root-integrated R3/fresh-process R2 cases 3/4. Remaining section 3 guide/read/profile
wiring, section 4 and R2 cases 2/5/6, and section 5's terminal integration,
R5–R8 and 36-frame comparison packet remain incomplete in the two-PR series.
