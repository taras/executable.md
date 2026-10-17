# Stop unadmitted entry startup before it can admit later

Completed and accepted at `01990ca4dfca3d9526908ac775469c28f1be7776` in the
[Planner review](pr2-stop-planner-review-01990ca4.md). P1 is closed. The
instructions below record the completed correction; continue the main handoff's
remaining section 4 work without repeating it.

Correct `88c482b717d7443f329d010e8635506b9045109e`, parent
`2fddcf6b49859e630fc21ec3372a6bd765fb415c`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.

The [Planner review](pr2-stop-planner-review-88c482b7.md) records one failure of
the existing contract: Stop withdraws the reservation and joins the cycle, but a
session task allocated before durable admission survives and later admits.
Preserve the increment and correct that boundary. No new product approval or
architecture decision is needed. The accepted admission/Pause distinction is
already that a busy task is not an admitted entry.

## Required correction

Keep pending startup revocable until the exact entry's durable admission is
acknowledged. The real session allocates its entry task after preflight but can
still suspend during execution setup before admission. Cancelling the caller's
wait and setting reservation.live=false does not reach that task today.

Connect cancellation to that allocated but unadmitted work in the session's
existing ownership path. Stop must cancel/join that startup or otherwise keep
it from ever admitting, and must not return while unwanted startup can continue
behind it. Use the exact acknowledged entry fact to decide the boundary; do not
treat session.live, a task reference, a passed preflight or a taken slot as
admission. Register cleanup before activating work it must release.

Once that exact admission is acknowledged, the entry belongs to the session and
Stop cancels only Sidekick's wait. It continues running and its later completion
starts no automatic turn. Do not halt an admitted entry to solve the earlier
window. Preserve the admitting-record/Pause/continuation order settled by A1.

An unadmitted cancelled startup leaves no fabricated entry terminal, settlement
or admission. Preserve the entry grammar and existing histories. The paired
Submit intent remains the account of a reserved request whose result was not
acknowledged; do not manufacture a completion receipt. Integrity, policy and
teardown failures retain their authoritative owner and are not ordinary corrections.

Keep the conversation in the owner's scope, canonical turn claims, Stop's joined
response cleanup and history refresh, prompt busy refusal and the shared admission
gate. The reservation remains the home of request withdrawal. If session.ts
changes, keep the correction in its existing task/admission machinery rather
than adding another entry owner, writer or public Core interface.

## Finite evidence

Read the [startup probe](pr2-stop-startup-probe-88c482b7.test.ts) and its
[first runtime output](pr2-stop-startup-probe-88c482b7-first.log). Integrate its
regression and no-Stop control in the existing R6 lifecycle tier:

1. Hold a real entry-only Execution.document installation before delegation.
   The real session has allocated its task, is live, and has no admitted entry.
   Stop through owner.stop(), then release startup and observe that no entry or
   authored output appears. Check the entry history remains readable and has
   no invented admission/terminal records. No stopped cycle starts a follow-up.
2. Release the same boundary without Stop. Exactly the requested literal source
   is admitted and runs. This prevents suppressing all startup from satisfying
   the regression.
3. Preserve the existing Stop-after-admission row: the actual entry keeps running,
   its Submit intent stays unfinished, and automatic continuation ends.

The injected AdmittingSession row may remain as a withdrawal-bit test, but it
does not replace the real allocated-task case. Retain the
[join probe](pr2-stop-join-probe-88c482b7.test.ts)'s ordering observations: Stop
does not return or free the owner while response cleanup is held, then the same
conversation can answer after cleanup joins. No new permutation matrix, terminal
work or interruption-case completion is assigned.

Align the affected specification and architecture prose with the actual durable
admission boundary. Avoid saying an allocated task is independent before that
entry was admitted. Preserve the distinction between an unfinished intent and
an invented cancellation outcome.

Run from the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-startup-probe-88c482b7.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-join-probe-88c482b7.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-receipt-probe-f5b60c99.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts
deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts
deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts
```

If session.ts changes, also run repl-journey.test.ts: its accepted no-wait and
PPA3(c) startup/Pause assertions exercise the same allocation/admission boundary.
Do not change those accepted assertions. No full suite, CI inspection or terminal
capture packet is assigned.

Commit promptly once focused evidence passes. Hand back the exact signed SHA
and parent, every focused command/result, worktree state and remaining incomplete
work. Stop for Planner review before continuing. No push or GitHub mutation is
authorized.

Exact correction base is 88c482b7. Produced artifacts are this prompt, the linked
review/probes/outputs, passing logs and updated main handoff. P1 remains blocking.
Elicit, configuration, metadata refresh, interruption cases 2/5/6, program binding
and section 5 remain outside this correction.
