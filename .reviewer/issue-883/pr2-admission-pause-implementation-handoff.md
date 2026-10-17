# Implementation amendment: preserve Pause during asynchronous submission

**Accepted at 29fb689fb2f1cec53aaf8ca49560f29d2892a58d.** The
[Planner review](pr2-admission-pause-planner-review-29fb689f.md) closes increment 2
under this frozen matrix, including the PPA3(b) journey/session split and the
source-established synchronous ordering. P1 remains closed. The implementation
worktree is clean; increment 3 may proceed under the main plan. The starting
state below records the preserved pre-correction files, not current dirty work.

Step 3 and the finite evidence below are aligned with the settled
[A1 startup ruling](pr2-admission-pause-a1-architect-decision.md). Commit this
exact entry's admission, apply its current pending Pause in the same synchronous
validated transition, then allow authored expansion. Pause during startup stays
pending until admission. No further product or architecture approval is needed.

The [P1 correction is accepted at cf3c6526](pr2-admission-pause-planner-review-cf3c6526.md).
Preserve its exact-entry admission check and existing tests. PPA3(b) now uses
the reachable post-admission metadata failure instead of the withdrawn
pre-delegation-refusal successor fixture. PPA3(c) covers the diagnosed early-live
Pause gap. The linked review accepts this correction; the remaining reservation
and recovery work belongs to increment 3.

Implement this correction before offering admission-gate increment 2 for
feedback. Run remains responsive during preflight; its immediately reserved
submission offers Pause before the next queued navigation event. Pause requests
a hold for that exact entry before authored expansion begins. Continue exists
only for a real hold. The [Architect handoff](pr2-admission-pause-planner-handoff.md)
records all three accepted product decisions; no further product choice is
assigned to the Implementor.

This document freezes the local implementation boundary and PPA1–PPA6 evidence.
It amends section 3 of the [main plan](planner-handoff.md), preserving the two
existing no-wait J1 behaviors. It is an implementation handoff, not a PASS for
the complete CLI PR. The series remains two PRs.

## Correction starting state (historical)

Work in `.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`, HEAD
`cf3c65268600341c571b5fc2e871612c28113c81`, parent
`f156f2c387073baad681e350c8ff3a64a69c2d1a`. Six files have uncommitted edits:
architecture.md, specs/repl-spec.md, packages/cli/src/repl/application.ts,
program.ts, session.ts and sidekick/gate.ts. The latter four paths are under
packages/cli/src/repl/. Preserve them; do not reset, stash or silently replace
them. Their removal of pending-Pause behavior and P1's check is not accepted.
Reconcile those edits deliberately with the committed P1 fix and this ruling.
The Planner preserved their exact starting bytes in
[the six-file manifest](pr2-admission-pause-a1-worktree.sha256) and
[the uncommitted diff](pr2-admission-pause-a1-worktree.diff).
The earlier ten-file manifest describes the historical pre-f156f2c3 draft.

Committed increment 2 reserves and spawns submission in program.ts, drains
typed reports through applyReports, returns an exact-entry ReplSubmission from
session.ts and carries the submit revision in application.ts. P1 is accepted;
increment 2 as a whole is not. Preserve its permitted type/shape adaptations:
five widened test helpers and two intent assertions' revision field.

## Ordered correction

### 1. Keep the pending action on the exact reservation

Extend the root-owned reservation state in program.ts/sidekick/gate.ts with
the process-local pending pause request and its handoff state. No journal,
location, restored model or Core context carries it. Preserve synchronous slot
reservation before the spawned child can suspend. A second request cannot take
the held slot.

The root resolves a Pause action against the actual target: its pre-admission
reservation, or the session's admitted live entry. Allocating a busy entry task
does not publish a live Pause target. Pause remains pending throughout preflight
and startup until that exact entry is durably admitted. An already-admitted
entry keeps its live control; a refused attempt to submit behind it must not
retarget Pause to a successor.
At startup, transfer the preparing request to its matching entry, without a gap
in which a subsequent Pause can be lost or sent to another entry. Duplicate
Pause requests are idempotent; Pause withdraws nothing and cancels no work.

Keep screen state single-writer: child work reports facts to the loop rather
than changing Draft, route, focus or refusal itself. applyReports must apply
completion/refusal without requiring another keystroke. A report for an older
reservation cannot clear a newer reservation or its pending request.

### 2. Mount the approved controls before dispatching the next event

Pass immutable pending facts into application.ts, not a reservation/controller
capability. Render the exact accepted order:

```text
[pause] preparing
[pause] pausing
[pause] paused [continue]
```

State words are plain text, not part of the button's label and not focus stops.
Keep the existing Pause key/type/parent identity through preparation, pending
request and live expansion. Before a hold, Pause is immediately before Draft.
Continue appears after the state only when the existing controller establishes
a real hold; ordinary playing Pause behavior stays unchanged.

In program.ts's act/batch path, refresh the existing mounted description tree
after Run establishes the pending action, before dispatching subsequent
navigation in that same burst. Waiting for applyReports, session changes or the
end-of-batch paint is too late: the next Backtab otherwise reaches Exit.

Use the same measured, width-admitted descriptions and Freedom tree as the
existing prepareFrame/commitReplFrame pipeline. Factor its existing preparation
and application operations if useful; do not add a second focus tree, hidden
target, alternate layout or unconditional redraw per keystroke. Keep the normal
batch paint/frame acknowledgement ownership and exact-frame pointer validation.
An obsolete pointer map must not activate newly mounted controls by stale
coordinates. Width, modal, History and undersized-screen rules still decide
which targets are reachable. Keep seven footer rows and the existing History
head states; preparation is not running, admitted, paused or settled.

### 3. Commit admission, apply pending Pause, then allow authored expansion

In session.ts's private submitting/begin/runEntry path, register the exact
entry's cleanup before arming or starting work that needs it. Allow Core's setup
import of `__root__` to finish without a pause hold. That import is not an
authored expansion step; holding it would leave no admitted History position.

The existing journal append observer runs synchronously after persistence and
before the durable import continuation resumes. It reprojects the whole
acknowledged history. In that transition, after validating that this task's
exact entry key is admitted, read its current pending request and apply Pause
without suspending. Do this before acknowledging successful admission and
before returning control to authored expansion. Preserve P1: a generic append,
settlement or refused projection never establishes admission.

Move arming out of the separately spawned admission-resolver waiter. Neither
its scheduling, asynchronous acknowledgement delivery, a frame, applyReports
nor a later lookup of the latest entry can order authored work. Admission may
establish the private handoff; the former blanket ban on using it is superseded.
Successful completion-handle acknowledgement is a separate responsibility.
Internal helper shapes remain delegated; no public Core method or journal/API
change is needed, and ambient context supplies no authority.

Read the request at that transition, not at submit or begin: Pause can arrive
while either preflight or startup is suspended. Before admission, the task's
busy state must not expose session.controller as a live Pause target. Keep
requests on the matching root reservation until admission. At that boundary,
publish live Pause for the admitted entry with no gap or retargeting. A competing
refused submission cannot take an already-admitted entry's control. The existing
controller then establishes the real hold; only that hold enables Continue.

Pre-admission refusal discards the unconsumed root request. An armed entry can
also fail after admission but before a hold: root metadata and the document
envelope are composed in this interval. Entry-owned cleanup disarms its controller
before joined teardown allows a successor. It creates no Continue or release of
a nonexistent hold. Cleanup for an older submission cannot reset a newer
entry's controller. Withdrawal and command closure discard pending state and
join owned work. Preserve authoritative failure behavior and exact-entry
completion. Pending Pause appends no durable event or invented terminal, and
reopening restores no pending request.

Retain ReplSubmission's exact task-bound completion. A successful handle names
only its admitted entry; join waits for its outcome and full cleanup, including
when read after another entry starts. It must not consult session.running or
join the current latest entry. Refusal returns no completion handle.

### 4. Update specifications and preserve remaining scope

Update specs/repl-spec.md's live journey, Pause/Continue description and
ownership explanation with preparation, separate state text, exact request
lifetime and unchanged footer geometry. Update the corresponding CLI ownership
discussion in architecture.md where needed. Distinguish setup `__root__` import
from authored expansion, describe the validated synchronous admission handoff,
and keep startup Pause pending until then. Remove the obsolete spawned-waiter
and first-setup-gate explanations. Use present-tense behavior. There
is no new entry-journal grammar, durable Pause record or History-head state.

Only presentation assertions affected by the approved button/state separation
may change in the existing journeys. Keep their immediate Run/Backtab/Enter
sequence and the hold before the provider question; add no readiness wait.
Retain existing behavior assertions in the other adapted tests.

Actual-start route/revision/takeover/liveness checks and durable reservation/
reconciliation remain required in increment 3 and the complete R3/R2 evidence.
Session still checks its own readiness before and after preflight. This local
correction neither removes those guards nor declares them finished. Preserve
Sidekick Stop's accepted scope; pending Pause does not become a new cancel
action. Guide/bootstrap assets, reads/profile wiring and sections 4/5 remain
required, and R2 cases 3/4 are not complete at this feedback boundary.

## Frozen focused evidence

Use actual production operations, mounted input and isolated real histories.
Reuse recordingTerminal, immediateClock and temporary-host patterns from
repl-journey.test.ts and existing joined-entry fixtures in repl-entries.test.ts.
Hold one real Markdown-definition read used by validateDocument through the
existing runtime API.Fs.readTextFile middleware. Register entered/release and
cleanup before waiting. Hold only that validation read, not the entire event
loop; a fake session.submit or injected completed view cannot prove this seam.
Readiness comes from latches, actual mounted frames and acknowledged facts,
not elapsed time. A bounded failure watchdog is allowed.

| Row | Required evidence and defect it catches | File |
| --- | --- | --- |
| PPA1 | Preserve both existing no-wait J1 rows, including immediate Run/Backtab/Enter with no intervening readiness/screen wait, and the integrated single-burst row. They reach a real expansion hold before the provider question and retain their Continue behavior. Catches mounting pending Pause only after admission or paint. | repl-journey.test.ts |
| PPA2 | Strengthen the existing held-preflight scenario at each profile, 160x36, 120x30 and 72x20: show preparing, activate mounted Pause, show pausing with no Continue, release preflight, and observe the exact admitted entry held with zero invocations of its first authored eval block. Continue invokes that block once and reaches the question once. Source and entry count stay unchanged. Catches a request sampled too early or applied after authored execution. Use the direct observer below; the question counter alone is insufficient. | repl-journey.test.ts |
| PPA3(a) | Keep the existing ordinary preflight-refusal case: pending Pause is discarded, draft/failure facts stand, and a valid successor plays and performs its effect without Continue. Catches an unconsumed root request leaking to another entry. | repl-journey.test.ts |
| PPA3(b) | At 160x36, request pending Pause for a real entry before admission, then refuse runtime root metadata after its durable admission and before authored expansion. Observe the exact admitted entry and pausing mode at that seam, no actual hold or authored eval invocation, the failed outcome after joined cleanup, and a readable history. Without Continue, a valid successor starts playing and performs its first authored step. Catches the reachable armed-without-hold controller leak. Use the runtime-only RootMetadata pattern below, not the withdrawn pre-delegation refusal. | repl-journey.test.ts; reuse session fixtures where appropriate |
| PPA3(c) | At 160x36, hold actual runtime startup after its task begins but before delegating Execution.document. With zero admitted entries, activate the mounted Pause now, not during preflight. It stays pending/pausing with no Continue or live expansion hold. Release startup; the exact source becomes entry-1 and reaches its real hold with zero first-eval invocations. Continue runs that eval once and reaches its question once. Catches the early-live route that currently holds setup before admission. | repl-journey.test.ts |
| PPA4 | While real preflight is held and Pause is pending, edit Draft and activate Exit through the mounted UI. Editing is processed before releasing validation. Command closure cancels/joins the held work and retains the newer draft without admitting old source or inventing a terminal. Reuse the existing cold-reopen path to assert no preparing/pausing action or pending request is restored and no implicit work starts. Catches an input loop still blocked by preflight and orphaned pending work. | repl-journey.test.ts |
| PPA5 | Within PPA2's three profiles, assert button/state/Continue order, plain state text with no extra focus stop, Pause node identity and focus through startup, seven footer rows, and only width-admitted mounted/pointer targets. Reuse existing modal/History/undersized and stale-frame evidence rather than adding those timing permutations. This is the pending-state portion of R8, not complete R8 acceptance. | repl-journey.test.ts; existing presentation/layout fixtures |
| PPA6 | Exercise ReplSubmission over a real entry: its join remains pending while that entry's teardown is held; release it, start another held entry, and read the earlier handle again. It returns the earlier outcome/identity without waiting for the later task. Reuse the existing teardown fixture. Catches a handle bound to session.join/latest running work or output-close alone. | repl-entries.test.ts |

PPA2 and PPA5 share one scenario per required size; do not duplicate them into
independent timing matrices. PPA4 demonstrates responsive Draft editing in an
Exit branch; PPA2's positive branch leaves its submitted draft revision intact.
The later full R3 evidence still proves stale-admission refusal after an edit.
Retain PPA2's observed frames as the pending-state evidence for R8. The main
plan's 36-frame comparison packet remains required; this amendment adds no
independent gallery scenes or replacement product journeys.

For the direct first-authored-step observation, reuse the unchanged reference
entry: its first authored node is the eval block in fixtures/repl/entry.md.
Install test-owned API.Env.compile middleware after useTempFileCompiler. Delegate
to the real compiler and wrap the first returned EvalBlock with an invocation
counter, then delegate execution to that block. Count block invocation rather
than compilation, a drawn row or the later Elicit. Assert zero invocations at the
real hold, one after Continue, still one after the question is mounted. Retain
the existing question counter as corroboration. This adds observation to PPA2's
three existing scenarios and PPA3(c), not another scenario matrix or production
hook. Core's eval-handler.ts runs the returned block inside the durable eval;
the setup root import does not use this compiler.

For PPA3(b), follow the Architect's archived
[metadata diagnostic](pr2-admission-pause-a1-probe.ts): an installation wraps
Execution.document and installs RootMetadata middleware only inside that runtime
invocation. Refuse metadata once, after the root import, then permit the
successor. This avoids refusing preflight and preserves a valid admitted segment.
Observe entry identity and controller state in that callback, join the real
submission's completion, then assert playing and a valid successor. Do not
assert error-object identity where the existing execution boundary only preserves
its name/message. No special Core fault seam is needed.

For PPA3(c), reuse that diagnostic's entered/release latch around the first
runtime Execution.document delegation, but exercise Pause through runReplProgram's
mounted control rather than directly calling the controller. Register release
cleanup before waiting. The existing diagnostic passes by reproducing the defect
(a hold with zero entries); the regression must assert the corrected opposite:
no pre-admission hold, then an admitted entry held before authored work.

No additional malformed-input or runtime matrix, mutation-control exercise,
provider conversation, storage abstraction or fresh recovery protocol is needed.
No new test file is required; extract shared test fixtures only when reused.

## Focused checks and feedback commit

Run from the PR 2 worktree after the correction:

```sh
deno task test packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

These files cross the real command, startup, mounted presentation and exact
entry teardown boundaries. Add affected-test selection only for another
changed boundary outside this selection. Do not wait for a full CLI/runtime
suite, lint/typecheck, JSR or CI before the feedback commit. Those remain the
separate delivery gate. Capture the first failure output before rerunning.

Once these focused checks and aligned PPA1–PPA6 pass, commit the increment-2
correction promptly on cf3c6526. Include specification changes and intended test
adaptations; exclude unrelated edits. Return exact SHA/parent, each command and
result, row mapping, any assertion change and the still-incomplete CLI claims.
A passing verdict accepts this increment only. Do not start increment 3 before
this feedback is reviewed; no GitHub write or CI inspection is authorized.

## Continuity

The correction base was cf3c65268600341c571b5fc2e871612c28113c81, parent
f156f2c387073baad681e350c8ff3a64a69c2d1a. The six files recorded above are
preserved in issue-883-pr2-a1-revert-state (b721df6c), verified against the
manifest/diff, and deliberately reconciled. Accepted HEAD is now
29fb689fb2f1cec53aaf8ca49560f29d2892a58d, parent cf3c6526, with a clean tree.
Produced/updated this handoff,
planner-handoff.md, pr2-admission-pause-a1-implementor-prompt.md and the six-file
preservation manifest/diff. No production file was changed by this planning pass.

The accepted product contract is pr2-admission-pause-planner-handoff.md; A1's
architecture amendment is pr2-admission-pause-a1-architect-decision.md. Step 3,
direct first-eval evidence and PPA3(a)–(c) now implement that ruling. No product or
architecture question remains open for this correction. P1 and increment 2 are
accepted by the linked review. Its four frozen commands pass 113 tests/345 steps,
with 30 tests/126 steps from controller consumers. Increment 3 may proceed under
the main plan; no further increment-2 correction or evidence is requested.
Subsequent work remains increment 3/R2 cases 3/4, remaining section 3 wiring,
section 4/R2 cases 2/5/6 and section 5's terminal packet. No push, GitHub write,
CI inspection or unrelated PR work is authorized.
