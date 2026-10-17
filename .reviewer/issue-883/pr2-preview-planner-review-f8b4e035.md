# Preview correction review: REQUEST CHANGES at f8b4e035

The DUPLICATE_ID collision is closed. Failed settlement still leaves two screen
items for one generation, and the identity of the acknowledged item differs
from the live Preview. Finish that existing one-item requirement and one missing
held-cleanup observation. The other evidence corrections are closed.

## Exact revision

- SHA: `f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`.
- Parent: `b44098ffd18ebc2bb7f6f46a38a3f09a55889959`, preserved.
- Branch agent/issue-883-pr2; signature G, signer tarasm@gmail.com.
- Implementation worktree `.claude/worktrees/issue-883-pr2`, clean, no untracked
  files; six files, +394/−73.
- Latest accepted prerequisite remains 81523318; the Preview slice is unaccepted.

The governing assignment is [the b44098ff correction](pr2-preview-implementor-correction-b44098ff.md)
under [the frozen plan](pr2-section5-preview-planner-handoff.md) and
[the Architect ruling](pr2-section5-preview-architect-decision.md). No new
product or architecture question is raised.

## Closed corrections

The preserved correlation probe passes unchanged, 1 test / 2 steps, including
the real response:2 / saved turn:1 divergence. The prior successful reply and
failed successor now coexist without crashing. Its permanent regression/control
run through the same real mounted/history path. responseOf() is gone and the
cold failed-item namespace does not collide with response keys.

PV1 now holds after the complete candidate controls arrive and observes no
control/fill/entry before provider completion. PV2 holds the invalid final
prefix before settlement and observes withdrawal independently of evaluation.
PV5's nonthrowing observing control now asserts the actual permission audit,
checkpoint association, exact begin handle and one append. Those observations
are closed; do not redesign or multiply them.

Factoring sidekickChatRows() as a CLI-local frozen display composition is
accepted. It introduces no execution authority or durable mapping. The PV2 wake
substitution and the earlier three mutation results remain accepted; their
connections did not change. No repeated mutation battery is required.

## Remaining PV-P1: failed settlement duplicates and renames the live item

owner.ts handles failed generation at lines 1442–1448 by reading the bounded
association and calling interrupted(actualTurn). That associates the live slot
with the saved attempt. But its ensure at lines 1394–1399 later calls
interrupted() without an argument. The default null at line 562 overwrites
watching.turn at line 575, forgetting the association during normal cleanup.

program.ts then composes the saved attempt under its turn key and the transient
slot under its response key. Both display the same failed generation. Even if
the cleanup stopped resetting the association, switching the live row from its
original response key to a new attempt key would still replace its identity
rather than carry one item through settlement.

[The new paired probe](pr2-preview-single-item-probe-f8b4e035.test.ts) captures
the actual owner's live facts while generation is held, lets the turn settle
and joins its task/cleanup, then runs both readings through the production
sidekickChatRows(). It invents no live snapshot, saved record or association.
[First output](pr2-preview-single-item-probe-f8b4e035-first.log) shows:

```text
failed generation:
  before: response:1                 preview
  after:  turn:1:incomplete           saved Incomplete
          response:1                 transient unfinished Preview
  saved turn remaining on slot: null

successful generation control:
  before: response:1                 preview
  after:  response:1                 reply
```

The failure arm expects one row and receives two; the successful arm passes.
The key comparison in that same probe also requires the settled item to retain
the live key. Fix both consequences of the same ownership transition.

The new permanent identity row does not catch this: it reconstructs a live
snapshot using the response from the future successful record, and checks only
success. Capture the real live facts before releasing generation instead.
For this correction, that actual owner/composition comparison plus the existing
keyed mounting contract is sufficient identity evidence; no production debug
API or extra node-observation framework is needed.

Use the already authorized process-local alias from the actual acknowledged
attempt to its registered response item. Acknowledgement supplies association;
it must not rename that item. Cleanup must not forget an established association
or resurrect an already represented live body. A cold reader may use the saved
turn's distinct identity because it has no live item to preserve. Keep saved
failure/Retry facts and truthful unsaved Stop presentation separate; add no
durable mapping or saved acceptance.

## Remaining PV-E1: observe the failure return while cleanup is held

The held teardown is now real, but agent-conversation.test.ts lines 772–778
only check that no Prompt was published, sleep, and release it. The sibling
never checks whether chat.prompt() at line 780 returned during that hold.
The final torn array proves the sibling ran, not when the prompt answered;
the later second prompt/resource teardown can wait for cleanup independently.

Add one explicit return observation beside this existing held turn. While the
cleanup gate is held, assert the first prompt has not answered and no result
was published; release it, then assert the authoritative failure. Keep the
audit/checkpoint control and existing failure classification assertions intact.
This is the already assigned observation, not a new lifecycle permutation.

## Independent focused evidence

All ten frozen commands and the old correlation probe ran at this exact SHA.
Every first output is preserved; no focused command was rerun. Each log records
its full invocation.

| Selection | First result | Output |
| --- | --- | --- |
| Core canonical/ordinary consumers | 33 tests / 205 steps, green | [core](pr2-preview-review-f8b4e035-core-first.log) |
| Pure preview / disclosure corpus | 7 / 81, green | [policy](pr2-preview-review-f8b4e035-policy-first.log) |
| ACP conversation / loaded copy | 4 / 11, green | [ACP](pr2-preview-review-f8b4e035-acp-first.log) |
| Workflow checkpoints / CLI hosts | 1 / 29 passed; 3 tests / 1 step failed in this environment | [workflow](pr2-preview-review-f8b4e035-workflow-first.log) |
| Mounted Sidekick / owner lifecycle | 22 / 81, green | [mounted](pr2-preview-review-f8b4e035-mounted-first.log) |
| Entries / history / controls / output | 51 / 201, green | [entries](pr2-preview-review-f8b4e035-entries-first.log) |
| Storage / recovery / configuration | 16 / 89, green | [recovery](pr2-preview-review-f8b4e035-recovery-first.log) |
| Ordinary journeys / agent interface / forms | 71 / 185, green | [journey](pr2-preview-review-f8b4e035-journey-first.log) |
| Route / layout / source reading | 28 / 130, green | [layout](pr2-preview-review-f8b4e035-layout-first.log) |
| Execution / lifecycle | 6 / 39, green | [lifecycle](pr2-preview-review-f8b4e035-lifecycle-first.log) |
| Unchanged old correlation probe | 1 / 2, green | [correlation](pr2-preview-review-f8b4e035-correlation-probe-first.log) |

Nine selections pass **238 tests / 1022 steps**, plus the preserved two-step
probe. No U2 recurrence. Command 4 again reaches npm embedded-adapter installation
and hits EPERM under `/Users/tarasmankovski/.npm/_cacache/tmp`; it has the same
review-environment limitation recorded at b44098ff. No cache/dependency repair
or production/test workaround was attempted. The Implementor's all-green
242 / 1055 and check = 0 are reported evidence, not independent Planner results.
Neither that environment limitation nor CI is the reason for this verdict.

The new single-item probe independently fails its regression and passes its
control, 1 test with 2 steps. No production mutation was used to reproduce it.

## Disposition

Execute [the narrow correction](pr2-preview-implementor-correction-f8b4e035.md)
from this signed head. Keep the collision fix, held-controls/parse-withdrawal
observations, permission/checkpoint evidence and prior acceptances closed.
The remaining work is failed-settlement identity/cleanup and the missing held
return observation. Return one signed feedback commit with both preserved
probes and the ten final focused commands. Deferred features and delivery remain
unopened. No implementation edit, commit, push, GitHub mutation, CI inspection
or capture was made by the Planner.
