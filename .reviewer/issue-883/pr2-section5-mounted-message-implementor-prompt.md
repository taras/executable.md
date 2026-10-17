# Implementor prompt: mounted Sidekick/message path, #883 PR 2

The mounted slice and its two-finding correction are accepted at a438905f.
[The final review](pr2-mounted-planner-review-a438905f.md) closes this assignment.
This original prompt remains the scope record; do not restart from 004de839.

Implement the bounded section 5 slice in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
on `agent/issue-883-pr2`, from exact signed clean base
`004de839e85e53cff4d960cb515729d350383f30`, parent
`08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`. Verify the base; reconcile a later
delta without reset, amend or discard. Follow .agents/implementor.md.

Read the frozen plan in the main checkout:
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-mounted-message-planner-handoff.md`.
It is the complete assignment, including M1–M8, the six exact commands and the
notification control. It replaces the mounted-section-5 hold **only for this
slice**. P1/P2, increment 4 and R2 stay closed.

Connect the real owner to runReplProgram's existing root and mounted tree:

1. Acquire one useSidekickOwner in drive's scoped loop lifetime, after its root
   callbacks exist and before first composition. All fresh/reopened executions
   use it, including both legacy single-file and paired storage. Tab/entry/
   History changes never create another owner. Cold acquisition projects only.
2. Pass the existing repository into the root's private plumbing. Establish
   paired storage on the first explicit legacy Send through repository.upgrade,
   holding new admissions and preserving the same entry session/task and
   MovableWriter. Update the root's current execution before acknowledging
   establish; no provider work precedes publication.
3. Bind rootReads, awaited fills and submitForSidekick to the same state,
   Admitting slot, current writer and actual-start checks human Run uses.
   Preserve cold reservation reconciliation, prefix binding and entry ownership.
4. Add the CLI-private owned change stream and awaited root message-admission
   operation specified by the plan. Reserve Send and capture text/message
   revision/draft revision synchronously. After the message append acknowledges,
   the owner waits for the loop to clear only the submitted Message revision
   and release only the takeover that has not been replaced by a newer Draft
   edit. Only then does the cycle continue. The existing unconditional
   instructed() clear must become revision-safe. Notifications wake the existing
   loop; they grant no authority and create no polling.
5. Feed immutable current chat/busy/agent/refusal facts to the existing builder.
   Mount Message Sidekick, Send and Stop through typed actions and Freedom.
   Wide/medium default right tab is Sidekick while Draft retains initial focus;
   narrow defaults Entries unless view=sidekick. Explicit activation focuses
   Message. Busy Message stays editable, Send cannot activate, Stop joins only
   Sidekick, and prepared text never sends automatically. Keep seven footer
   rows, History, Draft/Run/Pause and the existing one-burst behavior. No owner
   or operation reaches a view component.
6. Spawn message/Stop work on the root task; do not await a provider, entry or
   slow Stop cleanup in the keyboard reduction. Exit/Control-C/EOF/failure join
   root-owned work and release resources before returning. Preserve fatal
   durability/policy/teardown classification.
7. Add real-program/mounted-tree evidence M1–M8 in the plan's destinations,
   using controlled transport/terminal and existing fixtures. Preserve owner
   and R2 assertions. Align specs/repl-spec.md and architecture.md with what
   this increment implements and report every test adaptation.

This slice includes acknowledged chat and busy state, not streamed preview.
Do not mount Configure or Sidekick question controls, change Elicit admission,
invent an answer or completion, or claim deferred drawers/Sessions catalog/
terminal captures are complete. Those final requirements remain later slices.
Do not change Core/ACP APIs, configuration policy, route/flag spelling,
dependencies, generated artifacts or unrelated accepted behavior.

Run all six exact commands in the plan after the final edit. Confirm the one
notification mutation discriminates, preserve its first output and restore
before final checks. Its observation is the retained first reply while the
automatic follow-up remains held, not only a final reply after job completion.
Commit promptly once the finite evidence passes; no full
suite/lint/check/JSR or CI wait is required for feedback.

Return the signed SHA, parent, branch, tree status, commands/results, M1–M8
mapping, control and fixture/assertion adaptations. Stop for review. No push,
GitHub write, CI inspection, terminal packet or work beyond this slice opens.

Continuity: exact base 004de839; artifacts are this prompt and the linked plan.
P1/P2 and R2 are closed. This assignment settles the mounted acquisition join;
local helper names/factoring remain yours. Next action is implementation and
one signed feedback commit under the frozen evidence.
