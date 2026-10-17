# A1 decision: admit the entry before holding authored expansion

The pending pause takes effect after this exact entry's durable admission and
before its first authored expansion step. Core's setup import of `__root__`
must finish so the held entry has a real history position. No authored eval,
component body or rendered output may pass the requested hold.

This resolves A1's architecture question. It amends the earlier blanket ban on
admission acknowledgement; it does not accept increment 2's implementation.
P1 remains accepted at `cf3c65268600341c571b5fc2e871612c28113c81`, parent
`f156f2c387073baad681e350c8ff3a64a69c2d1a`. No further P1 work is requested.

## Why this needs no new product decision

The Product Owner accepts immediate Run/Pause, a real held entry, truthful
History, the separate `preparing`/`pausing`/`paused` states and the exact
submission's request lifetime. The unchanged J1 journey also requires that
the paused entry has an admission to inspect. Holding setup before admission
cannot satisfy those accepted observations together.

The Architect's earlier “first expansion gate” wording incorrectly included
the setup import. The corrected boundary preserves the accepted behavior;
private ordering and helper shapes are delegated under architecture rules
2, 3 and 9. It changes no public API, control, lifetime, journal grammar or
reopening behavior, so no additional Product Owner confirmation is required.

## Exact ordering and ownership

1. The root reserves the submission and owns its process-local pause request.
   Every Pause for that submission before admission remains a pending request,
   including one arriving after its task starts but before admission commits.
2. Core imports `__root__` through the ordinary durable operation. Its retained
   record reaches the session's existing append observer; the validated whole
   projection establishes this exact entry's admission. A generic append,
   terminal result or refused projection is not this signal. Preserve P1.
3. In that CLI-owned admission transition, consume the current pending request
   and arm this entry's controller **before** acknowledging successful admission
   or allowing the root-import continuation to resume into authored expansion.
   There is no suspension between checking the request and applying it.
4. Then live Pause targets that same admitted entry. The existing controller
   establishes the actual hold, publishes `paused`, and enables Continue.

Use the existing synchronous validated-admission/append transition for the
private handoff. Do not rely on a separately scheduled waiter, a frame, a root
report or whichever entry is latest to run before authored work. The import
record is persisted before its durable continuation resumes, so this transition
already supplies the required ordering without a public Core change.

Do not expose the live Pause target merely because `begin()` allocated a busy
task. Until this task's entry is actually admitted, Pause for its reservation
must stay pending; otherwise it can arm the controller early and hold the
setup import itself. An already-admitted entry still owns its live Pause when
a competing submission is refused. Preserve the root/session ownership split,
single mounted tree, seven footer rows and exact reservation identity.

The earlier prohibition now reads: **the handoff may use the exact entry's
validated durable admission, but cannot wait for asynchronous acknowledgement
delivery, presentation, or later entry lookup.** Successful completion-handle
acknowledgement and the pause handoff remain different responsibilities.

## Cleanup remains necessary and reachable

An armed entry can fail before any expansion hold. After `__root__` is retained,
`documentWorkflow` composes root metadata and the document envelope before
expanding the body. Ordinary runtime `RootMetadata` middleware can fail there.
The entry is admitted and fails normally; its history can accept a successor
after joined cleanup. The controller must be disarmed before that successor
starts. No Continue or release of a nonexistent hold is manufactured.

Register that entry-owned cleanup before arming, keep it scoped to the exact
entry, and preserve authoritative failure and joined teardown. Pre-admission
refusal discards an unconsumed request; withdrawal/Exit discards pending work;
reopening restores none of it. This preserves the accepted lifetime.

## Evidence and current worktree

Reviewed committed `cf3c6526` using `git show`. The user-reported four focused
commands and accepted P1 probe are not rerun or reopened here. At assessment
time the implementation worktree has six uncommitted files: architecture.md,
specs/repl-spec.md, application.ts, program.ts, session.ts and sidekick/gate.ts.
Those changes remove pending-Pause code and include removal of P1's admission
check. They were neither used as the reviewed revision nor changed by this
assessment. Preserve them; do not reset, stash or silently replace them.

Direct trace at the reviewed SHA:

- `execute.ts:2147`: the setup import is `__root__`, not the first component
  authored inside the entry. Its durable result precedes root composition.
- `journal.ts:85–91`: append commits the record, then synchronously notifies the
  session. `session.ts:1156–1172` projects it and calls `reached()`; P1 validates
  the running entry's key before acknowledging it.
- `session.ts:1048–1060`: arming currently waits in a spawned task on the
  admission resolver. The corrected handoff belongs inside the ordered
  transition above instead.
- `session.ts` publishes `live` in `begin()` before admission, while
  `program.ts:1245–1260` sends Pause to a present live controller first. This
  admits the early-live route to the pre-admission hold reproduced below.

An isolated `git archive cf3c6526` under `/private/tmp` reused the prepared
dependencies without installing or changing the implementation worktree.
The [focused diagnostic source](pr2-admission-pause-a1-probe.ts), copied to
`packages/cli/tests/architect-a1-probe.test.ts` in that snapshot, ran with:

```sh
deno task test packages/cli/tests/architect-a1-probe.test.ts
```

The [final output](pr2-admission-pause-a1-probe-final.log) passes 1 test/2 steps:
runtime metadata refusal observes `pausing` after admission, joins its failure
without Continue, resets to playing and permits a valid successor; an early
live Pause reaches a real hold with zero admitted entries. The latter diagnoses
the current ordering defect; its passing diagnostic is not acceptance of it.

The [first attempt](pr2-admission-pause-a1-probe-first-run.log) failed typecheck
because the scratch probe used the race API incorrectly and read controller-only
members from its view. After those probe errors were corrected, an additional
whitespace-body experiment timed out because the probe assumed it emitted no
output; the [exploratory source](pr2-admission-pause-a1-probe-exploratory.ts) and
[output](pr2-admission-pause-a1-probe.log) are preserved. That premise is not
used in this decision. No production code changed between these diagnostic runs.

## Planner handoff

Align ordered step 3 and PPA3 with this ruling before resuming implementation.
Keep PPA1's unchanged no-wait journeys, PPA2/PPA5's pending controls and PPA4/PPA6.
The existing reference-question counter proves a hold before that question;
it does not alone prove that the reference entry's earlier eval never ran.
Freeze a direct first-authored-step observation for the corrected ordering.

For PPA3(b), use one representative real post-admission startup failure, such
as runtime-only root metadata refusal, then a valid successor. This directly
tests the reachable armed-without-hold cleanup. Do not restore the withdrawn
pre-delegation-refusal successor expectation, add fault hooks or build a timing
matrix. Retain P1's existing evidence unchanged.

Also cover Pause arriving during startup before admission: it remains pending,
then holds the admitted entry before authored work. This is A1's existing
gap-free handoff claim, not a separate product journey. The Planner owns its
integration into the finite evidence rather than adding a general concurrency
matrix.

Return a new feedback commit after the aligned focused checks. Increment 2
remains unaccepted; increment 3 remains paused until that acceptance. Remaining
R2/R3, section 3 wiring and sections 4/5 stay required in the existing two-PR
series. No GitHub write, CI inspection or production edit by the Architect is
performed or authorized by this ruling.
