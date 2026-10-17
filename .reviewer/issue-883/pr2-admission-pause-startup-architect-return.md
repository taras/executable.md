# Architect return: reconcile pending Pause with entry admission

A1's architecture question is resolved by the
[startup ruling](pr2-admission-pause-a1-architect-decision.md). The handoff uses
the exact validated durable admission, applies pending Pause before authored
expansion resumes and keeps pre-admission Pause on the reservation. An
armed-without-hold startup is reachable and has a representative real metadata
failure path. P1 remains accepted; the Planner aligns step 3/PPA3 next.
The incoming return below is historical and does not override that ruling.

Current implementation head is `cf3c65268600341c571b5fc2e871612c28113c81`,
parent f156f2c387073baad681e350c8ff3a64a69c2d1a. The
[P1 correction is accepted](pr2-admission-pause-planner-review-cf3c6526.md).
Arming, specification prose and no-wait journeys are unchanged; A1 below
remains the unresolved Architect action.

Resolve the startup boundary exposed by increment 2 at
`f156f2c387073baad681e350c8ff3a64a69c2d1a`, parent
`14ebf82d05d30d861ab1e36458e46291486a4841`, branch
`agent/issue-883-pr2`. The worktree is clean. The
[Planner review](pr2-admission-pause-planner-review-f156f2c3.md) independently
reran the four frozen commands: 113 tests, 340 steps, zero failures. This is
an architecture return, not approval of the implementation's changed boundary.

## The conflict to resolve

The [accepted amendment](pr2-admission-pause-planner-handoff.md) requires the
private startup handoff before the first expansion gate and explicitly forbids
depending on admission acknowledgement. Its product evidence also preserves
the original no-wait J1 behavior and truthful entry/history state.

The Implementor reports that the controller's first gate is component import
during setup, before the durable root admission. Arming there holds an entry
that has no history position, and the original J1 row fails its admission
expectation. The submitted implementation instead waits on the exact entry's
admission resolver (`session.ts:1013–1025`), then arms. Its three held-preflight
journeys hold before the reference document's question and Continue performs
that question once. The commit's specification and architecture prose declare
admission the earliest coherent hold point.

Determine the required boundary: does the existing first-gate wording include
setup imports before admission, or should it mean the first authored expansion
step after durable admission? Reconcile that answer with unchanged no-wait J1,
truthful preparation/history state and a pause request that survives startup
without a gap. If admission-time handoff is accepted, explicitly amend the
prohibition on admission acknowledgement and state the ordering guarantee that
keeps authored effects behind the requested hold. If it is not accepted,
provide the private ownership/ordering correction; the Implementor must not
choose a different product behavior.

Preserve the accepted button/state order, exact reservation lifetime, real
Continue, single mounted tree, seven-row footer and unchanged journal grammar.
No new public Core interface or automatic reopen work is proposed.

## What the Planner has resolved

PPA3(b)'s proposed Execution.document refusal before delegation cannot establish
a valid successor in the same session. The diagnostic confirms a settlement
without root admission, followed by the existing whole-history refusal. The
Planner withdraws that fixture's successor expectation; changing the grammar
is outside this correction.

The same diagnostic exposed P1: the refused startup returned a successful
completion handle. That defect is now corrected and accepted at cf3c6526.
An actual entry key must be present in the validated whole-history projection
before the task can acknowledge successful admission. The unchanged diagnostic
now passes both steps. This correction does not settle A1.

The reported teardown-disarm mutation leaves all journeys green. No evidence
claim is made for that branch. After the startup boundary is settled, state
whether an armed-but-never-held startup is reachable under that design. The
Planner will freeze any necessary representative cleanup evidence against that
answer, without inventing timing permutations or failure hooks.

## Return and next action

Return a settled amendment or a correction to the existing boundary, including
whether Product Owner confirmation is required under the Architect role. The
Planner will then align the ordered startup step and PPA3 evidence. Preserve
cf3c6526 and all accepted journeys while resolving it. No further P1 work is
requested; increment 3 stays paused until increment 2 is accepted.
No production edit, GitHub write, CI inspection or new PR is authorized by
this document.
