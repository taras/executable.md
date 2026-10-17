# Correct Sidekick increment 2's admission/Pause handoff

Completed and accepted at `29fb689fb2f1cec53aaf8ca49560f29d2892a58d` in the
[Planner review](pr2-admission-pause-planner-review-29fb689f.md). This prompt
records the correction's starting instructions; do not repeat it against the
clean accepted head. The next action is increment 3 under planner-handoff.md.

Resume #883 Sidekick increment 2 using this prompt and the aligned
[implementation handoff](pr2-admission-pause-implementation-handoff.md).
The [Architect's A1 decision](pr2-admission-pause-a1-architect-decision.md)
settles the order: commit this exact entry's admission, apply pending Pause,
then allow authored expansion. No further product approval is needed.
Increment 2 remains unaccepted. P1 is accepted and must remain intact.

## Starting state and preservation

Work in `.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`, at
`cf3c65268600341c571b5fc2e871612c28113c81`, parent
`f156f2c387073baad681e350c8ff3a64a69c2d1a`. The planning artifacts are in the
root checkout's `.reviewer/issue-883/`, outside this worktree.

Six files have uncommitted edits: architecture.md, specs/repl-spec.md and
packages/cli/src/repl/{application.ts,program.ts,session.ts,sidekick/gate.ts}.
Preserve them and inspect the [manifest](pr2-admission-pause-a1-worktree.sha256)
and [saved diff](pr2-admission-pause-a1-worktree.diff). Do not reset, stash or
silently overwrite them. Reconcile their removals of pending-Pause and P1 code
deliberately with the accepted commit and the required correction. The dirty
files have not been accepted. If their bytes have changed since the manifest,
account for that new work before editing it.

## Required correction

1. Keep every pre-admission Pause on its exact root reservation, including
   requests arriving after begin allocated the task. Busy is not admitted and
   must not expose a live Pause target. An already-admitted entry retains its
   live control when a competing submission is refused.
2. Let Core's setup `__root__` import commit the admission. In the existing
   synchronous append/reprojection transition, validate this task's exact entry
   key using the whole history, preserving P1. Consume its current pending
   request and arm its controller without suspension, before successful admission
   acknowledgement or the durable continuation resumes authored work.
   Remove arming from the separately scheduled admission-resolver waiter.
3. Keep entry-owned cleanup registered before arming. Post-admission metadata
   failure can leave the controller armed without a hold; joined cleanup must
   disarm it before a valid successor. No Continue or fake hold release is needed.
   Refusal, withdrawal and closure discard pending requests; reopening restores
   none. Preserve exact-entry completion and authoritative failures.
4. Keep the single mounted tree, Pause identity, button/state order and seven
   footer rows. Preserve both original no-wait J1 sequences and the single-burst
   row. Align architecture.md and specs/repl-spec.md with the corrected order.
   No public Core API, journal grammar or product behavior change is assigned.

## Finite evidence

Execute the aligned handoff's PPA1–PPA6. The A1 changes to that matrix are:

- Strengthen the existing three PPA2/PPA5 scenarios with an invocation observer
  for the reference entry's first authored eval block. Delegate through the real
  API.Env.compile, wrap its first returned block, and count its execution:
  zero at the real hold, one after Continue, still one when the question appears.
  Keep the question counter too. Do not change the reference document.
- Preserve PPA3(a)'s ordinary preflight refusal and valid successor.
- Replace withdrawn PPA3(b) with one real post-admission metadata refusal at
  160x36, followed by a valid successor. Use the archived diagnostic's runtime-only RootMetadata
  middleware inside Execution.document. Observe exact admission and pausing at
  that seam, no authored execution or hold, joined failure, controller reset and
  a successor playing without Continue. Do not restore the invalid pre-delegation
  refusal/successor expectation.
- Add PPA3(c) at 160x36: hold the first runtime Execution.document before
  delegation, activate mounted Pause during that startup window, and prove it
  remains pending with no admission/hold/Continue. Release startup and prove
  entry-1 is admitted and held before the first eval. Continue runs it once.

Use existing test files and real production paths. No new fault hook, timing
matrix, runtime matrix or mutation-control exercise is required. Retain P1's
existing refusal/control evidence unchanged. The Architect's passing early-live
diagnostic reproduces a defect; the regression must assert the corrected behavior.

Run these four commands from the PR 2 worktree:

```sh
deno task test packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

When focused evidence passes, commit promptly and return the exact SHA/parent,
every focused command/result, PPA mapping and any assertion changes. Do not wait
for the full suite, lint/check, JSR or CI before the feedback commit. Stop for
Planner acceptance of increment 2. No push or GitHub/CI action is authorized.

## Continuity

Base: cf3c65268600341c571b5fc2e871612c28113c81. Governing artifacts: this prompt,
the aligned implementation handoff and A1 Architect decision linked above;
planner-handoff.md records the complete two-PR series. No design blocker remains
for this correction. P1 stays accepted and increment 2 stays unaccepted until
review of the new feedback commit. Increment 3/R2 cases 3/4 remain paused;
remaining section 3 wiring, section 4/R2 cases 2/5/6 and section 5's terminal
evidence remain incomplete. This task concerns Sidekick #883; PR #181 work is
outside this handoff.
