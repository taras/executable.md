# Product decision needed: Pause while submission is preparing

Status: historical proposal, superseded by the
[accepted Architect amendment](pr2-admission-pause-planner-handoff.md).
The Product Owner accepts pending Pause with the shorter states `preparing`,
`pausing` and `paused`, ordered after the Pause button and before Continue.
The exact submission-specific lifetime is accepted. The proposal below remains
withdrawn as an implementation instruction; its older labels and evidence do
not override the accepted amendment.
Current committed base: `14ebf82d05d30d861ab1e36458e46291486a4841`, parent
`01abab2763a7ef95d6bcfb67582df161f80918a5`, branch `agent/issue-883-pr2`.
Increment 2 has nine uncommitted modified files; the two affected journey rows
are unchanged. No production code changed in this Planner assessment.

## Existing behavior and gap

Two J1 rows in packages/cli/tests/repl-journey.test.ts submit from Draft and
immediately send Shift-Tab then Enter, without waiting for a screen read.
Pause is expected immediately before Draft while expansion plays; Continue
exists only once a continuation is actually held. The first row must pause
before reaching its provider question, because an outstanding provider request
prevents the expansion walk from becoming fully held.

The accepted section 3 plan moves slow preflight/append/completion off the
input loop. The uncommitted implementation now reserves synchronously and
spawns submission. A frame can therefore show the reservation before an entry
exists. live.pausable is false then, so Pause is absent and the same navigation
burst activates a different control. The implementor reports both rows timing
out and the other 36 journey rows passing; those runs were not rerun here.
Source inspection confirms this change in the control's availability.

The pending reservation is a real fact but is not a running or paused entry.
Displaying that fact alone does not preserve the burst: the control must have
a defined action while preparation is pending.

## Recommended choice: pending Pause targets this submission

Keep asynchronous preflight. Represent preparation independently from the
entry's existing expansion state; do not report an unstarted entry as running
or paused and do not add a Core expansion state.

- While a live submission is preparing, show `preparing submission` within the
  existing seven-row footer. At the existing Pause position immediately before
  Draft, offer `[pause] on start`, with the same focus identity as the live
  Pause control.
- Activating it records a process-local pause request owned by that exact
  reservation. Show `[pause] requested`; no Continue exists yet.
- If that submission starts, apply its request before its first expansion
  step. Say `paused` and offer Continue only when the existing expansion
  controller establishes a real hold. Existing live Pause/Continue semantics
  remain intact.
- If preflight refuses, the request is withdrawn, or the command ends, discard
  that reservation's pending pause. It cannot affect a later submission.
- Preparation and its pause request create no admitted entry, terminal,
  provider turn or completed-control fact by themselves. Reopening does not
  restart pending work or revive a process-local pause request.

This choice preserves the no-wait interaction while making the new preparation
window visible. It changes the pending control's availability and action, so
it needs a product decision. It does not add a footer row or change the
Bindings/Sidekick pane boundaries. The exact internal handoff that installs the
pause before expansion must be traced and frozen before implementation; this
proposal does not authorize a new public Core interface.

## Alternative: Pause is available only after an entry starts

Accept the responsive preparation window with no Pause target. Amend the two
journey rows to establish an actual running entry before navigating to Pause.
Their burst-before-start guarantee is removed explicitly. A fixture must hold
the entry before its provider question so the test does not introduce a new
race while waiting for the control. This is a narrower product change but
changes the deliberate no-wait interaction.

Keeping slow preflight in the input loop contradicts the accepted responsiveness
requirement and is not recommended.

## Evidence after the choice

For the recommendation, retain the two existing no-wait journeys and their
behavioral assertions. Add one representative real held-preflight case showing
preparation, responsive input, stable Pause focus/action, and the same entry
held before its first effect. Its refusal/withdrawal control must show no
pause request leaking to the next submission. Exercise the pending frame at
the existing R8 profiles, preserving seven footer rows, truthful labels and
absence of Continue before a real hold. This is evidence for the newly chosen
pending action, not a general timing/permutation matrix.

For the alternative, revise the two rows only after explicit acceptance of the
changed product claim, retaining separate evidence that held preflight leaves
input responsive. Freeze the amended evidence in the main plan before coding.

## Other scope rulings

The five Result<void>-to-Result<unknown> helper changes and intent assertions'
revision field are ordinary type/shape adaptations, provided existing behavior
assertions remain intact.

Removing ready/running/ending from the root's GateFacts is acceptable in scope.
Source inspection confirms session.submit's canonical admissible check runs
both before and after suspended preflight, rejecting ending, occupied or
unsettled sessions without queuing. Do not duplicate those facts in the root.
The root still owns reservation exclusivity and must recheck route, draft
revision, human takeover and request liveness at actual admission; that work
remains required by the accepted R3/R2 plan. This ruling does not accept the
uncommitted increment or claim those root checks are already wired.

## Continuity

The two-PR series and accepted revisions remain unchanged. Increment 1 is
accepted at 14ebf82d; increment 2 has no feedback commit and no PASS. Preserve
the working changes and the unchanged failing journeys. Next action: Architect
assessment through the linked handoff, including Product Owner resolution if
a material choice remains. Independent inspection may continue; do not
rewrite the journey claim or implement the new pending action before that
decision. No GitHub write is authorized.
