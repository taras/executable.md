# Reconcile generated-root evaluation with main's generated selection

Architect return: [integration decision](pr890-pr921-main-integration-architect-decision.md).
Both contracts below are settled for Planner finalization. The original
questions remain here as the input record; this link grants no rebase or
implementation authority.

Read this to decide how #890 and #921 can move onto current main without
changing their accepted execution and replay boundaries by conflict resolution.
Return an Architect decision for the two questions below. This is a design
handoff, not permission to rebase or implement.

## Applies to

Core generated roots and fragments, their durable admissions and Syntax
descriptions, and the Sidekick's existing bound root-evaluation consumer. REPL
presentation corrections and the deferred Parse issue are outside this ruling.

## Exact state

Inspected on 2026-10-16 through local Git objects:

| Reference | SHA |
| --- | --- |
| Integration target, origin/main | 986948eabd070c0ae7354c2a0db8df7feed63621 |
| Accepted #890 / agent/issue-883-pr1 | 79d404d04d02c3840892473b6f1b2cf540f3edd1 |
| Accepted #921 / agent/issue-883-pr2 | 940249af47159a3bbd960b8ca8df3f10bb53811c |
| Existing PR1 safety ref, pre-rebase/issue-883-pr1 | 79d404d04d02c3840892473b6f1b2cf540f3edd1 |

The root checkout's local main is e61d6ce0 and has unrelated user edits. It is
not the integration target. Use committed versions for contract comparisons;
do not copy its live architecture.md into either implementation worktree.

The [aborted rebase finding](pr890-rebase-attempt-finding.md) reports no moved
branch or remote. No rebase was retried for this handoff. PR1 is checked out in
.claude/worktrees/issue-883-pr1 and PR2 in .claude/worktrees/issue-883-pr2;
their owners retain those worktrees. Existing reviews describe their exact
SHAs, not future rewritten commits.

## Governing decisions

- [Accepted PR1 review](pr890-planner-review-79d404d0.md): generated roots have
  their own empty binding environment, support the accepted passive draft
  capture, and preserve fragment restrictions and retained context separation.
- [Bound root evaluation amendment](root-evaluation-architect-handoff.md):
  HostExecution and AgentConversation expose bound evaluation. Core owns its
  execution, exact protected Syntax implementation, narrowed route, captured
  package reference, journal sequence, cancellation and joined teardown.
- [U5 handoff](../upstream-u5-handoff-3a1fade9/upstream-repository-prerequisite-u5-implementor-handoff.md),
  especially steps 3, 4, 6 and 7: capture Component.generated before execution
  policy; resolve actual definitions once; remove generic request inventories,
  Workspace basis and old table-taking inputs; authorize live effects at their
  performers; write and read one closed marker-4 admission schema.
- [U5 accepted review](../upstream-u5-review-86c10507/planner-review.md):
  contextual selection, live destination bounds and marker-4 replay are
  accepted. Main contains this work; it is not an unreviewed proposal.
- [U3 Syntax resolution](../upstream-prerequisites-6314e187/upstream-repository-prerequisite-u3-syntax-architecture-resolution.md):
  generated scopes narrow descriptive symbols through ordinary middleware;
  named documentation retains the enclosing owner. Description grants no
  execution authority.

Read .agents/architect.md and its rulebooks before the ruling. Material changes
to accepted compatibility or public boundaries require the Product Owner's
decision under those instructions; do not delegate them to the Implementor.

## 1. Admission, record compatibility and the root caller

The attempted merge identified an in-memory policy difference. The serialized
records show a larger, deliberate contract change:

| Boundary | #890 at 79d404d0 | Main at 986948ea |
| --- | --- | --- |
| Written policy | Marker 2; allow, optional root context, optional Workspace basis, structural identities/forms and normalized request inventory | Marker 4; allow and ordered name/form/identity-URL/kind/effect rows |
| Readable policy | Closed untagged v1 and tagged v2 shapes, with the existing reconciliation rules | Only the closed marker-4 shape; older markers and extra fields refuse |
| Admission result | Earlier admitted/refused envelope | Marker 4 required on the result as well as its policy |
| Authority source | Host-provided observation/mutation tables and request ceilings | Component.generated captured before public execution policy; owning definitions supply form/effect metadata |
| Effect authorization | Includes evaluator request inventory and Workspace comparison | Actual live Permissions/provider checks; no generic evaluator inventory or Workspace snapshot |

These are not independent fields that can simply be combined. U5 expressly
removes the older inputs and compatibility reader. Restoring them while keeping
marker 4 would change a shape whose reader rejects extra members.

The root consumer must be covered by the same ruling. At 940249af,
sidekick/owner.ts calls the bound conversation method with id, source,
observations, mutations and allow. sidekick/profile.ts and controls.ts construct
conversation-owned control definitions under the older generated types. This is
live production use, not merely a stale host.ts export list. Main's removal of
unused exports cannot decide how these controls are captured or invoked.

Please return a complete contract for:

1. The root and fragment admission record shapes, marker(s), context distinction
   and exact ordered comparison. State whether existing marker-4 fragment
   history remains readable, and what happens to #883's earlier root records,
   v1/v2 records and intervening marker-3 records. Specify refusal or supported
   continuation explicitly; do not infer absent authority from missing fields.
2. The root request and control-installation boundary under captured selection:
   who supplies and captures the exact conversation's controls, when capture
   happens, and how roots remain unable to borrow entry capabilities or another
   conversation's controls. State which existing request members and public
   generated types/factories survive or are replaced.
3. The effect-policy consequence: which old evaluator ceilings are retired and
   where any still-required live restriction is enforced. Completed replay and
   unacknowledged live work must remain distinct.

Planner recommendation: build on main's accepted captured-selection and live
authorization model, preserving #883's root separation and control ownership.
Do not restore a generic legacy table channel solely to reduce rebase conflicts.
Choose a marker only after the complete closed shape and compatibility policy
are settled; neither reusing 4 nor introducing 5 is decided here.

## 2. Root Syntax descriptions and error behavior

Main's expand() sets ErrorMode to throw and installs useNarrowedSyntax(syntax)
for its generated fragment scope. That helper supplies Syntax.symbols through
middleware at min; named documentation stays with the enclosing owner.

#883's expand() chooses output mode for a generated root and throw for a
fragment. The later accepted bound-root work in PR2 narrows the exact component
route and derives a reference with available(admittedSymbols(...)); it preserves
captured package chapters and the root's own binding environment. This is more
than adding or dropping an import during the merge.

Please state the combined rule for root and fragment scopes:

- Whether and where main's descriptive Syntax middleware is installed for a
  root; which captured reference it reads, how named lookups retain the owner's
  package documentation, and when the enclosing view is restored.
- Root versus fragment ErrorMode, ordinary component-failure behavior, partial
  root output and authoritative integrity/policy/teardown failure propagation.
  Installing descriptive middleware must not silently decide these behaviors.
- That the description and exact invocation route remain separate: describing
  a name cannot authorize it, and a later contextual answer cannot replace a
  captured control or protected implementation.

Planner recommendation: apply the accepted descriptive narrowing to roots using
their owning execution's captured reference, while preserving the accepted
root/fragment error distinction. Confirm this from both contracts or name the
explicit amendment needed. Do not change error behavior merely because main's
existing helper was written for fragments.

## Return and subsequent planning

Return a decision-complete architecture artifact with the accepted public
signatures, closed serialized examples, old-history disposition, selection
ownership/timing and root/fragment Syntax and error rules. Separate decisions
settled by existing rules from amendments requiring Product Owner acceptance.
No production edit or review of a newly integrated implementation is requested.

The Planner then freezes one bottom-up integration assignment. It must account
for both PR1 and PR2, preserve the old reviewed heads, name the worktree owners,
and review replacement SHAs. Moving PR1 alone changes PR2's merge base while
leaving its consumer on the old Core API. Public host exports and pinned helper
signatures follow the ruling and concrete consumers, rather than an automatic
union of both export lists.

Private positional-versus-object argument threading and the scanner's separate
unfinished-input branch are ordinary implementation mechanics. They need no
new architecture convention. Do not turn their conflict count into additional
product decisions.

For that later plan, reuse the existing root/passive-draft, fragment/composition,
generated-selection, Syntax, conversation and Sidekick evidence. Add focused
discrimination for the chosen record compatibility, root-versus-fragment
context, exact conversation control capture and descriptive narrowing. The
Planner freezes exact commands after the interfaces are settled; no full-suite,
dependency setup, CI inspection or mutation battery is assigned by this return.

## Continuity

Exact bases are the three full SHAs above. Produced artifact:
.reviewer/issue-883/pr890-pr921-main-integration-architect-handoff.md.
Unresolved: the two combined contracts and their necessary root-consumer API
consequences. Next action: Architect ruling, then Planner integration assignment;
the Implementor continues to hold the clean reviewed heads.

Task A remains PASS at 940249af. B–D's UI choices remain pending independently.
Parse issue #922 remains deferred and outside this work. No branch, source,
remote, PR, CI or dependency state was changed for this handoff. Rebase, force
push and other publication actions require their own assigned scope.
