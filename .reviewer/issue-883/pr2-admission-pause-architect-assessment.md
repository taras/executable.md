# Architect assessment: Pause during submission preparation

The [A1 startup ruling](pr2-admission-pause-a1-architect-decision.md) clarifies
“first expansion step” below as the first authored step after durable admission.
It replaces the original blanket admission-acknowledgement prohibition with an
ordered private handoff; the three accepted product decisions stay unchanged.

The asynchronous draft breaks an accepted keyboard journey. The Product Owner
accepts making Pause available immediately after Run: during preparation it
requests that this entry pause when expansion begins. Continue appears only
after expansion actually stops. All three boundary decisions are accepted.
The [Planner handoff](pr2-admission-pause-planner-handoff.md) carries the complete
correction. The existing no-wait journeys retain their behavior.

## Evidence and review boundary

Assessed on 2026-10-11 in `.claude/worktrees/issue-883-pr2`, branch
`agent/issue-883-pr2`, HEAD
`14ebf82d05d30d861ab1e36458e46291486a4841`, parent
`01abab2763a7ef95d6bcfb67582df161f80918a5`, with the nine modified CLI files
listed in the [handoff](pr2-admission-pause-architect-handoff.md).
This is an assessment of that uncommitted increment, not a verdict on the
committed admission-gate increment or on the complete PR.
The [source fingerprints](pr2-admission-pause-worktree.sha256) identify the
assessed dirty files and unchanged journey test.

Ran once, without changing the journey test:

```sh
deno task test packages/cli/tests/repl-journey.test.ts
```

Exit 1: 36 passed (60 steps), 2 failed (2 steps), 1m13s. Both named J1
rows fail waiting for `expansion paused`, at lines 2236 and 3224. The captured
footer has `[history] [exit]`, `HEAD · EMPTY`, no checkpoints and the original
Draft. The complete [first-run output](pr2-admission-pause-first-run.log) is
preserved before any rerun. No rerun, broad suite or CI inspection was used.

## Existing contracts

- `specs/repl-spec.md`, “One live journey” and “Who owns what”: Pause asks a
  live expansion to stop at its next boundary. Continue exists only for an
  actual hold. Input travels through the mounted focus tree.
- The unchanged journey rows at lines 2180 and 3197 deliberately submit, then
  immediately send Shift-Tab and Enter. Their comments expressly exclude a
  screen read or intervening wait. They are accepted product evidence, not
  incidental sleeps to adjust.
- The accepted [plan, section 3](planner-handoff.md#3-share-root-admission-with-controls)
  requires responsive preflight, append and completion, plus exact-entry
  admission and joined completion. The accepted reservation contract in
  [remaining architecture](remaining-architecture.md#accepted-submit-reconciliation-between-histories)
  keeps Draft editing and Stop responsive. A reservation is not an entry.
- The terminal contract retains seven footer rows, actual mounted targets,
  truthful execution state and no Continue before a real hold.

## Diagnosis

`program.ts:1198` reserves the slot, then spawns `session.submit` and returns to
input. `session.ts:849` preflights before `begin`; `begin` establishes live
entry work. Until then `session.controller` is absent (`session.ts:730`).
`liveOf` derives `pausable` from that absence (`program.ts:960`), and the footer
offers Pause only when it is true (`application.ts:2736`).

Consequently the immediate Backtab from Draft reaches Exit, the last mounted
control in the idle footer, rather than Pause. Enter asks the command to leave;
the owning scope cancels and joins the submission child. This is more than a
late repaint: the same deliberate input can end the command instead of pausing
the entry. The empty-history footer in both failures is consistent with that
direct dispatch trace.

Waiting for admission in the input loop restores the old ordering by removing
the required responsiveness. Yielding to the child or repainting sooner cannot
guarantee admission while real preflight is suspended. Reporting the reservation
as a running entry is untrue. A hidden Pause target contradicts mounted-target
semantics. Holding navigation keys for an unknown duration changes input
behavior and is not an approved compatible repair.

The regression is real; its correction required a product decision about the
preparation window. The accepted extension of Pause resolves that conflict
without removing responsiveness or the existing burst guarantee.

## Product boundary interview — 3 of 3 accepted

The interview trigger applies because offering Pause before entry start changes
the control's reachability, absence and lifetime, and adds a handoff between the
root-owned reservation and session-owned expansion. Three items are in scope:

1. What Pause targets during preparation.
2. How preparation and a pending request are shown, including mounted focus.
3. How the request reaches expansion and when Continue becomes available.

Item 1 is accepted by the Product Owner's explicit “yes” on 2026-10-11 to the
Architect's proposal: make Pause available immediately after Run; during
preparation it means “Pause this entry when expansion begins”; Continue appears
only after expansion actually stops. The request targets that submission,
preparation continues, and an unstarted entry is not reported as paused.
The two existing no-wait journeys retain their claim.

Item 2 is accepted with the Product Owner's shorter state words and explicit
order: first the Pause button, then plain state text, followed by Continue
only when an actual hold exists:

```text
[pause] preparing
[pause] pausing
[pause] paused [continue]
```

`preparing` means preparation is pending without a pause request; `pausing`
means Pause was requested but expansion has not yet stopped; `paused` requires
a real expansion hold. The state text is not a button or focus stop. Keep the
same mounted Pause identity into live expansion, preserving focus; before a
hold, it is the control immediately before Draft. Continue follows the state
once held. The footer remains seven rows. This replaces the proposed
`Preparing entry`, `on start` and `requested` wording.

Item 3 is accepted by the Product Owner's explicit “yes” to the exact
submission's request lifetime: it takes effect before the first expansion step;
failure, withdrawal or REPL closure discards it; it neither affects a later
entry nor survives reopening. The root owns a process-local request tied to
the exact reservation; the session owns actual expansion holds.
Transfer occurs before that entry can pass its first expansion gate. Refusal,
withdrawal or command teardown discards the pending request, with no effect on a
later entry. No request is restored on cold reopen. Sidekick Stop retains its
accepted scope and does not cancel an independently admitted entry. No new
public Core interface is introduced. The root/session ownership follows the
existing architecture; internal helper shapes remain delegated.

## Next action

The Planner applies the [accepted amendment](pr2-admission-pause-planner-handoff.md)
to section 3 and freezes its implementation steps and focused evidence before
resuming increment 2. Preserve the dirty implementation and the two no-wait
journeys. Their presentation assertions may adopt the accepted button/state
separation; their timing and behavior remain intact. The historical pending-Pause
proposal remains withdrawn and does not supply the accepted labels.

Core PR 1, the bound Core amendment and admission-gate increment 1 retain their
accepted standing. This assessment accepts none of increment 2. Actual-start
root rechecks, durable reservation/recovery, the remaining section 3 wiring and
sections 4/5 remain outstanding in the existing two-PR plan. Local planning
records link this accepted amendment; no production code, specification,
rulebook or GitHub record changed here. No new runtime evidence or implementation
verdict is claimed by completion of the interview.
