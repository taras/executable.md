# Implementor assignment: mounted Sidekick question drawer

This slice and its presentation correction are accepted at bb60ca35.
[The PASS review](pr2-question-planner-review-bb60ca35.md) closes the assignment.
This original prompt is the scope record; do not restart from a438905f.

Implement the next bounded #883 PR 2 slice in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`, branch agent/issue-883-pr2,
from signed clean `a438905f8fa98d245bb6444058bd470f1312411b`, parent
`86debcb96ba8f547d78712b2de66fcc1ed709ef9`. Verify the base and reconcile any
later delta without reset, amend or discard. Follow .agents/implementor.md.

Read the complete frozen plan in the main checkout:
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-question-drawer-planner-handoff.md`.

It contains the governing decisions, concrete source seams, MQ1–MQ5, two
discriminating controls and six exact feedback commands. This opens only the
Sidekick question drawer; the mounted message slice, configuration P1/P2 and
R2 stay accepted.

Required work:

1. Subscribe to the existing owner.questions.changes in drive's scope before
   messages can publish a question. Wake the existing loop and reread pending.
   Announce without taking tab/focus/History or changing either composer.
2. Keep question authority in the root. Project detached message/form facts and
   a stable process-local key bound to the exact pending question. Keep
   Sidekick partial form/open state separate from the entry form. A new or
   ended question resets its own state; close/tab/resize do not.
3. Mount an explicit answer opener and pane-local form through typed
   actions/intents and the existing form/window/Freedom machinery. The actual
   root answer calls only that Sidekick question's submit(values). Validation,
   canonical answer retention and designated feedback are existing operations.
   No second validator, provider, question journal or answer record.
4. Invalid answers show normalized issues and retain values. Close or leave
   the pane without answering or cancelling, then reopen with partial fields
   intact. Do not apply the entry's discard-on-close rule to Sidekick or change
   the entry rule. A Sidekick form field named message still edits that form.
5. Use one measured pane-local rectangle across fitting/admission/drawing/hit
   testing. Keep the seven-row footer and existing entry/permission drawers.
   Only the selected owner's form has targets. Reuse modal focus/restoration,
   reachable close/Exit/Stop/navigation, and preserve current route transitions.
   Sidekick drawer/form/key state has no URL or durable spelling.
6. Preserve owner Stop and whole-command shutdown. Stop withdraws only
   Sidekick's question without an answer or outcome; an entry's question stays
   independently answerable. Exit/Control-C join all owners and restore once.
7. Add the real mounted evidence MQ1–MQ5 in the plan's destinations, using
   mounted-program.ts and existing transport/repository fixtures. Align
   architecture.md and specs/repl-spec.md only for implemented behavior.

Use the plan's finite paired observations and controls, not a larger matrix.
After the final edit run its six exact commands. Verify each mutation applied,
preserve first failure output, restore byte-identically and rerun affected
evidence. Commit promptly once it passes and return the signed feedback SHA,
parent, clean-tree state, commands/results, row mapping, controls and every
fixture/assertion adaptation. Do not wait for a full suite, lint/check/JSR,
packaging build or CI.

Local CLI-private names/factoring are delegated; new product policy or
authority is not. No Core/ACP interface, canonical Elicit, schema language,
journal grammar, route codec/flag spelling, dependency or vendored kernel
change is assigned. Return a concrete boundary failure if one makes this plan
impossible rather than route around it.

Deferred: streamed preview; Configure/Retry and agent/model/effort controls;
Sidekick Sessions rows; complete terminal R5–R8; the 36-frame packet and
delivery. Do not add placeholders or treat deferred behavior as final.

No push, GitHub mutation, CI inspection, main-checkout production edit or real
terminal capture is authorized. Stop for review after this signed increment.

Continuity: base a438905f; artifacts are this prompt and linked plan.
No architecture ruling remains open for this slice. Next action is
implementation under MQ1–MQ5, not another permission request.
