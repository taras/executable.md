# Architect handoff: submission preparation and Pause

Assessment complete: the Product Owner accepts all three decisions in the
[Architect assessment](pr2-admission-pause-architect-assessment.md). The
[accepted Planner handoff](pr2-admission-pause-planner-handoff.md) governs the
correction: Pause targets the exact preparing submission; the button precedes
the state and Continue; failure, withdrawal or closure discards the request,
which never affects a later entry or survives reopening. The Planner freezes
the implementation steps and focused evidence next. The incoming assessment
request below is historical; it does not override that accepted handoff.

Resolve the interaction conflict exposed by asynchronous submission in #883
PR 2. First determine whether existing accepted behavior can be preserved. If
product behavior must change, bring the smallest concrete choice to the Product
Owner. Return the accepted decision to the Planner before implementation depends
on it. This is an assessment handoff, not a coding instruction.

## Current state

Branch: `agent/issue-883-pr2`.
Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
HEAD: `14ebf82d05d30d861ab1e36458e46291486a4841`, parent
`01abab2763a7ef95d6bcfb67582df161f80918a5`.

The series remains two PRs. Core PR 1 (#890) is accepted at 79d404d0; the bound
Core amendment within PR 2 at 01abab27; admission-gate increment 1 at 14ebf82d.
Increment 2 is uncommitted and has no PASS. Nine files beneath packages/cli
are modified: src/repl/application.ts, program.ts, session.ts, sidekick/gate.ts;
tests/repl-agent-execution.test.ts, repl-entries.test.ts, repl-history.test.ts,
repl-lifecycle.test.ts and repl-sidekick-controls.test.ts.

repl-journey.test.ts is unchanged. Preserve the working changes and its failing
rows. No reset, stash, production edit, commit or GitHub write is authorized by
this handoff. No production code changed in this Planner assessment.

## Conflict and evidence

Section 3 of the accepted plan keeps the input loop responsive during slow
preflight, append and entry completion. The draft reserves the next slot
synchronously, then spawns session.submit. A frame can appear with a reservation
held but no entry running. Pause is absent then because live.pausable is false.

Two ordinary REPL J1 rows in packages/cli/tests/repl-journey.test.ts submit from
Draft and immediately send Shift-Tab then Enter without another screen read:

- Line 2180: `J1: run, hold at a gate, inspect a prefix, return live, continue, answer, settle`.
  The no-wait burst is at lines 2215–2231. This row must request Pause before
  reaching its provider question; an outstanding provider request prevents the
  walk from becoming fully held.
- Line 3197: `J1: Continue is mounted only while a continuation is held`.
  Its corresponding burst is at lines 3218–3224.

Both depend on Pause being immediately before Draft while expansion plays,
with Continue absent until an actual hold. Previously awaiting submission kept
later keys behind admission. The spawned path exposes a preparation frame
where the same navigation activates a different control. Source inspection
confirms this availability window. The implementor reports both rows timing
out and the other 36 journey rows passing. The Planner has not rerun those
failures or reviewed the whole uncommitted increment; these are reported
results, not an exact-commit feedback verdict. These J1 names are distinct from
#883's separately named Sidekick product journey 1.

## Boundaries to inspect

program.ts owns Admitting, the reservation and child reports. Its submit case
reserves before suspension and spawns session.submit; applyReports drains
results once per input/session batch, including without another key.

session.ts now returns Result<ReplSubmission>, capturing the exact admitted
entry task and joining its outcome and cleanup. Its canonical admissible check
rejects ending/running/unsettled history both before and after preflight.
application.ts requires live.pausable for Pause and an actual paused expansion
for Continue. program.ts acts through session.controller, which is absent
without a live entry. expansion.ts owns the actual expansion walks and gates.

The root owns reservation exclusivity, route, draft revision, human takeover
and request liveness. Actual-start root rechecks, durable reservation and R2
cases 3/4 remain unfinished; they are not already proven by this increment.

## Requested Architect assessment

1. Establish the accepted burst guarantee from specifications and journey
   intent. Classify this as an implementation defect within the existing
   contract or a material product choice. Changing test timing alone does not
   resolve the conflict.
2. Find a compatible solution if one exists. If new behavior is necessary,
   interview the Product Owner under .agents/architect.md and its product
   rulebooks. Resolve what Pause means before entry start, focus/control
   availability and when Continue exists. Apply the boundary-interview rules
   where appropriate.
3. Return accepted behavior, ownership/lifetime, failure/cancellation rules
   and any explicitly approved changes to journeys or presentation. The
   Planner then freezes implementation steps and focused evidence.

The implementor suggested accepting the window and waiting for entry start;
exposing preparing submission with defined control behavior; or retaining
admission/preflight in the loop. The last conflicts with current responsiveness
requirements. These are alternatives to assess, not an approved or exhaustive
menu.

The Planner's [pending-Pause proposal](pr2-pending-submission-product-decision.md)
is unapproved and withdrawn as an implementation instruction. Its labels,
pause-on-start behavior and suggested evidence are not frozen criteria. The
Product Owner has not selected it. Do not infer approval from the earlier
recommendation or question.

## Existing constraints and scope rulings

Preserve truthful running/paused state, the seven-row footer, actual mounted
focus/pointer targets and no Continue before a real hold. Preserve responsive
preflight, exact entry identity, canonical admission, authoritative failures,
joined cleanup, human draft protection and no automatic recovery of pending
Sidekick work. A reservation is not an admitted entry or terminal. No new public
Core interface is authorized.

Removing readiness from GateFacts is acceptable in scope: session owns and
rechecks it. Root-owned actual-start guards remain required. The five helper
return-type widenings and two intent assertions' revision field are type/shape
adaptations, provided existing behavior assertions stay intact. These rulings
do not accept the uncommitted increment.

## Sources and return handoff

Read the [main plan](planner-handoff.md), section 3 and R2/R3/R8;
[accepted product journeys](remaining-architecture.md#4-accepted-product-verification);
[terminal adaptation](reference/README.md#accepted-terminal-adaptation);
and [increment 1 review](pr2-admission-gate-planner-review-14ebf82d.md).
Read architecture.md and affected specifications, plus the Architect and
product rulebooks under .agents/ in the governing repository.

Reported uncommitted evidence: repo-wide typecheck clean; repl-entries,
repl-history, repl-lifecycle, repl-agent-execution and repl-sidekick-controls
total 42 tests/158 steps passing; 36 journey rows pass and the two above fail.
No full-suite success or CI status is claimed. Reproduce through the unchanged
repl-journey.test.ts using the repository runner; capture first failure output
before rerunning. Do not rewrite assertions to obtain a green result.

Return an Architect record with the diagnosis, accepted decision and its
authority, exact user-visible behavior, ownership/lifetime/failure rules,
affected claims and next Planner action. Keep any unanswered Product Owner
choice explicit. The Planner updates the handoff before work depends on a new
decision. Remaining section 3 assets/reads/profile wiring, increment 3 recovery
and sections 4/5 remain in the two-PR plan.
