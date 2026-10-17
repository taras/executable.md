# Keep a failed Preview as one item through cleanup

**Closed: PASS at 10b17a40, 2026-10-14.**
[The review](pr2-preview-planner-review-10b17a40.md) closes both findings at
signed clean 10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a, preserving f8b4e035.
This correction is complete; the instructions below are historical. No Preview
correction remains assigned.

Correct the remaining Preview ownership/evidence findings from signed clean
`f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`, parent
`b44098ffd18ebc2bb7f6f46a38a3f09a55889959`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Follow .agents/implementor.md. Verify HEAD/tree, preserve both signed commits and
unrelated work, and reconcile advancement without reset, amend or discard.

Read the main-checkout records:

- `.reviewer/issue-883/pr2-preview-planner-review-f8b4e035.md`
- `.reviewer/issue-883/pr2-section5-preview-planner-handoff.md`
- `.reviewer/issue-883/pr2-section5-preview-architect-decision.md`

The original DUPLICATE_ID collision is closed. PV1's held complete controls,
PV2's held parse withdrawal and PV5's observing audit/checkpoint control are
closed. The internal sidekickChatRows factoring is accepted. Do not redo those
fixes. No new product or architecture ruling is needed.

## Required work

1. Correct failed settlement/cleanup so the actual live Preview becomes exactly
   one saved Incomplete under the same presentation identity. Currently the
   failure path binds watching.turn to its real acknowledged turn, then the
   ensure calls interrupted() with default null and forgets it. The composition
   mounts both the saved attempt and a transient unfinished Preview. Merely
   retaining the turn value is insufficient if acknowledging it still changes
   the row's key from response to attempt.
2. Preserve the registered live item's key using the Architect's authorized
   process-local alias from the actual bounded canonical association. Let
   acknowledgement update which saved attempt that item represents, not rename
   the item. Cleanup must not erase that established association or resurrect
   its live counterpart. The alias is display bookkeeping only; its local shape
   is delegated. Cold saved-attempt keys may remain distinct and truthful, with
   no inferred response number and no new durable record. Keep the earlier
   reply, saved reason and Retry association; retain unsaved Stop Incomplete
   without inventing a turn/response/acceptance. Preserve revocation and new-work
   separation under the original ruling.
3. Run the new probe unchanged and promote its failed-generation regression and
   success control. It captures real owner.previewing/history before and after
   the held generation and joins the caller through cleanup, then composes the
   actual facts through sidekickChatRows(). The parent fails with two rows;
   success stays green. Both count and original-key continuity are required.
   Use these actual snapshots in the permanent identity row instead of building
   a live snapshot from a future response record. This factored production
   composition evidence is sufficient; no new debug API or node framework.
4. Finish the one missing PV5 return observation in the existing held-cleanup
   row. Record whether the first chat.prompt() has answered; from beside it,
   while the provider cleanup is still held, assert it has not answered and
   no Prompt result is published. Release the gate, then assert the existing
   authoritative failure/no-follow-up result. The current sibling only checks
   publication and its own callback order, which cannot prove when the prompt
   returned. Do not change Core failure semantics to manufacture this evidence.

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-single-item-probe-f8b4e035.test.ts
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-correlation-probe-b44098ff.test.ts
```

Align only affected identity/cleanup prose. Preserve all existing held-controls,
parse/disclosure, audit/checkpoint, preferences, Stop/entry independence and cold
recovery assertions. No parser, journal, public Core/provider contract or
authority change. This is the existing one-item/lifetime requirement, not a
new evidence matrix. The new parent failure and passing success control supply
discrimination; no additional mutation battery. Earlier three controls remain
accepted unless their connections actually change.

Run both probes unchanged and all ten frozen commands after the final edit.
Preserve first failure output and report every fixture/assertion adaptation.
Command 4's npm EPERM recurred in Planner review; do not change shared caches,
dependencies or production/tests for that environment. Report your actual
results. U2 did not recur; unrelated flake repair remains outside scope.

Once the focused evidence passes, commit promptly with signing enabled and
return exact SHA, parent, branch, signature, clean/untracked status, commands/
results and the two remaining finding mappings. Continue to the signed handback
with progress updates; do not end after individual files or rows. Return early
only for a concrete settled-contract conflict. No full-suite/check/lint/JSR,
packaging, capture or CI prerequisite is added.

Configure/Retry and all prior acceptances stay closed. Preview remains
unaccepted pending this correction. No Sessions integration, complete terminal
packet, capture, main-checkout production edit, dependency change, push, GitHub
mutation or CI inspection. Next action is this narrow correction from f8b4e035,
then Planner review of its exact signed feedback SHA.
