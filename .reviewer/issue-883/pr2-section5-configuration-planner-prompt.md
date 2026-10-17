# Planner continuation: finish the Configure/Retry assignment

Follow `.agents/planner.md`. Finish the bounded section 5 Configure/Retry
assignment for #883 PR 2. The product and architecture questions identified
by the preparation are now answered; do not send the Implementor back to choose
these behaviors.

Start with these main-checkout records:

- `.reviewer/issue-883/pr2-section5-configuration-planner-handoff.md`
- `.reviewer/issue-883/pr2-section5-configuration-timing-architect-decision.md`
- `.reviewer/issue-883/pr2-section5-configuration-product-decisions.md`

Implementation checkout:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`

Assigned starting SHA: `bb60ca35661c2988ef647cc7a456470482d06e2e`, parent
`2f3af332e09a7aa8e6acda6e51e1f63aab13614e`, branch `agent/issue-883-pr2`.
Verify the current head/tree; reconcile any advancement rather than resetting
or discarding work. Planning records remain in the main checkout.

## Settled behavior

- A preference for an active conversation can be saved while Sidekick works.
  It does not inspect or interrupt the provider. The next turn, including an
  automatic entry-completion follow-up, reads the latest acknowledged preference
  immediately before prompt handoff. Current work keeps its original request.
- Keep one serialized chat writer and the existing owners. Saving is independent
  of message-cycle Stop; shutdown joins admitted writes/configuration tasks.
  Apply cannot be retargeted by conversation replacement. Inspection and agent
  switching retain their busy restrictions and the explicit Stop/join path.
- Retry resends the failed person's saved request as a new message in the same
  conversation. Keep the prior failed attempt. It is not merely an availability
  check and does not use unrelated composer text. Unknown acceptance, identity,
  storage and configuration-integrity refusals remain effective.
- Apply saves and closes Configure on success. Close discards unsaved choices;
  reopening shows saved preferences. Failed Apply keeps the drawer open and
  reports the reason. Model/effort save acknowledgement is distinct from native
  application; agent Apply keeps explicit new-conversation setup semantics.

## Required output

Turn the preparation into a decision-complete, bounded plan and finite evidence
matrix. Preserve its six focused selections and add only actual known affected
consumers. Carry the timing ruling's exact R7 adaptation, held-entry/control
pair and write-order/ownership observation. Incorporate the accepted Retry and
Apply/Close journeys with real mounted evidence. Keep all previous acceptances
closed and leave ordinary REPL entry behavior unchanged.

Write the self-contained Implementor prompt to:
`.reviewer/issue-883/pr2-section5-configuration-implementor-prompt.md`.

Update the packet's readiness to name the exact implementation base, frozen
evidence, focused commands and next action. The Implementor makes a signed
feedback commit promptly after that evidence passes and returns its exact SHA,
parent, branch, tree status and commands/results for review. Preserve the first
output of any failure. Delivery checks remain separate.

No preview, Sessions integration, remaining terminal acceptance, captures,
pushes, GitHub mutations or CI inspection are assigned. The Planner writes no
production code. No new permission or product question is needed for choices
already settled in the linked records; return only a genuinely new conflict
that the existing contracts cannot resolve.
