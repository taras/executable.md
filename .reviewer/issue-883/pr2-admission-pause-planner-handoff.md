# Accepted amendment: Pause during submission preparation

The [A1 startup ruling](pr2-admission-pause-a1-architect-decision.md) clarifies
the boundary: the setup import admits the entry, then its pending pause is
applied before authored expansion. The private validated-admission transition
may carry that handoff; asynchronous acknowledgement delivery may not delay it.

Pause is available as soon as Run reserves a submission. While preparation
continues, activating it requests that this exact entry stop before its first
authored expansion step after durable admission. This preserves the immediate
Run, Shift-Tab, Enter journey
while keeping input responsive during preflight and admission.

The Product Owner accepts all three decisions: the pending action, the exact
button/state order below and the request's submission-specific lifetime. The
[Architect assessment](pr2-admission-pause-architect-assessment.md) records the
diagnosis, approvals and first-run evidence. This is a feature amendment, not
a reusable rule or an implementation PASS.

## What the user sees and does

The existing footer shows the Pause button, plain state text and then Continue
when expansion is actually held:

```text
[pause] preparing
[pause] pausing
[pause] paused [continue]
```

`preparing` means submission preparation is pending with no pause request.
`pausing` means Pause was requested and expansion has not yet stopped. It
applies while preparation continues and while live expansion approaches a hold.
`paused` means the existing expansion controller has established a real hold.
Continue appears only then and releases that hold through the existing
controller. Ordinary playing expansion retains its existing Pause behavior.

The status words are not buttons or keyboard stops. Pause keeps one mounted
identity across preparation and live expansion, preserving focus. Before a hold,
Pause is the control immediately before Draft; Continue follows the state when
held. Mount the pending Pause description before dispatching subsequent
navigation after Run. Deferring its availability until an asynchronous
admission report would retain the reproduced Exit activation bug.

The footer remains seven rows. Existing width admission, modal focus and
History rules remain in force. Preparation is separate from entry execution:
a reservation does not make the entry running, paused, admitted or settled,
and adds no eighth History-head state.

## Ownership and lifetime

The root owns the pending request as process-local state tied to the exact
submission reservation. The session owns the actual entry task and expansion
controller. The CLI's private startup handoff applies the request in this exact
entry's validated durable-admission transition, before successful admission is
acknowledged or the root-import continuation resumes into authored expansion.
It cannot depend on asynchronous acknowledgement delivery, a later paint or
lookup of whichever entry is latest. Setup's `__root__` import is allowed to
finish; it supplies the real history position the held entry must have.

Pause during startup before that admission still targets the pending reservation,
even after its task has been allocated. Task occupancy alone cannot expose a
live Pause that holds setup before admission. The session's controller remains
absent when there is no live entry. Pending
Pause is a root action with a distinct pending target; it does not turn the
existing live controller into a capability for idle or historical entries.
Presentation receives immutable facts and produces typed semantic actions;
Freedom continues to own focus and dispatch through the actual mounted tree.
These ownership choices follow the accepted architecture rules. Local helper
and private handoff shapes are delegated; no public Core interface changes.

If preparation fails, the submission is withdrawn, or the command closes,
discard its pending pause. It cannot affect a later entry or reappear on cold
reopen. A failed startup cannot leave the session-wide controller armed for a
successor. Once the request belongs to the live entry, the existing controller
owns the hold and its teardown. Preparation itself creates no continuation for
Continue to release.

Pause cancels no preparation or entry. Sidekick Stop keeps its accepted scope:
it revokes its pending admission and joins Sidekick work; it does not cancel an
independently admitted entry. Exit still cancels and joins command-owned work.
Existing authoritative failure and joined-cleanup behavior remain unchanged.
The pause request creates no durable record and changes no entry-journal grammar
or retained Sidekick recovery policy.

## Planner action and evidence

Amend section 3's asynchronous admission work with this contract, then resume
increment 2. Preserve all nine dirty implementation files. The Planner owns
the finite implementation steps and focused test mapping. Derive evidence from
the accepted behavior and existing R3/R8 claims:

- Preserve the two existing no-wait J1 journeys in `repl-journey.test.ts`.
  Retain the immediate submit/Backtab/Enter sequence and the actual hold before
  the provider question. Update only presentation assertions affected by the
  accepted separate state text; do not insert a readiness wait.
- Hold real preflight and show `[pause] preparing`. Activate Pause through the
  mounted control and show `[pause] pausing`, with no Continue. Draft editing
  and applicable Stop/Exit actions remain responsive. When that same valid
  submission starts, it is admitted and holds before its first authored expansion
  effect; only then is
  `[continue]` available. Continue releases the actual hold without rerunning it.
- Exercise refusal or withdrawal of an armed submission, then a valid later
  submission, showing that the pending request does not leak. Reuse the
  existing cancellation/reopening evidence for command-owned teardown and the
  absence of restored process-local state rather than inventing new recovery.
- Integrate the pending states into the existing R8 terminal evidence at
  160x36, 120x30 and 72x20, preserving footer geometry, mounted targets and focus
  through the preparation-to-expansion transition. Do not add a second focus
  tree, hidden action target or renderer.

PR 2's planned specification update includes the preparing action and approved
state order. This does not authorize changing other settled journeys, adding a
new queue, blocking preflight in the input loop or executing a pending
submission automatically after reopening.

## Continuity

Assessed worktree: `.claude/worktrees/issue-883-pr2`, branch
`agent/issue-883-pr2`, HEAD
`14ebf82d05d30d861ab1e36458e46291486a4841`, parent
`01abab2763a7ef95d6bcfb67582df161f80918a5`, with the nine uncommitted files
identified in the assessment. The unchanged journey run exited 1 with 36
passed (60 steps) and 2 failed (2 steps); its complete output is retained there.
No corrected implementation or passing result is claimed.

Core PR 1, the bound Core amendment and admission-gate increment 1 retain their
accepted standing. The two-PR split remains. Actual-start route/revision/liveness
rechecks, durable reservation/reconciliation, remaining section 3 wiring and
sections 4/5 remain required. The older pending-Pause proposal is superseded
by this amendment; its `on start` and `requested` labels are not accepted.

Next: Planner freezes the local correction and evidence, then the Implementor
returns a stable feedback commit after the focused checks pass. This handoff
changes only local planning records; it authorizes no GitHub write, merge,
CI inspection, production edit by the Architect or acceptance of dirty code.
