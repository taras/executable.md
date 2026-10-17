# Remove successful silent replies from Sidekick chat

**Completed: [PASS at 2ac3cb28](pr921-control-only-planner-review-2ac3cb28.md).**
ER1–ER5 pass with independent 59 tests / 239 steps. No further silent-reply
correction is assigned. Start the separate Configure exit/navigation correction
from this exact signed successor before the delivery restack. Instructions
below are retained as this completed increment's contract.

**Next after this correction's review:** the user also assigned
[Configure keyboard exits/navigation](pr921-configure-exit-planner-handoff-6ca23952.md).
Keep it separate from this commit. Finish and review that successor before
delivery restack; do not mix another correction into the current tree.

**Start gate satisfied: padding PASS at 6ca23952.**
The [exact-SHA review](pr921-padding-planner-review-6ca23952.md) independently
passes all three padding selections, 146 tests / 469 steps. The same designated
Implementor may start this separate correction now from
`6ca239527abe9d012be01fffc79197e882c52ca3`, signed G, clean when reviewed.
Preserve this commit; do not amend it or restack before this correction's review.
The earlier observed 27da762b/in-progress inventory below is historical.

Follow `.agents/implementor.md` and the
[Architect decision](pr921-control-only-replies-architect-decision.md).
Remove “<agent> answered without saying anything.” A successful reply containing
only REPL controls is useful agent work and adds no chat utterance or empty row.

## Owner and start gate

Use the existing designated Implementor and `.claude/worktrees/issue-883-pr2`,
branch `agent/issue-883-pr2-main-integration`. Observed HEAD was
`27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`, with the approved padding/color
increment in progress. Recheck state with the existing owner; do not open a
second writer or overwrite its changes.

Finish the [padding continuation](pr921-padding-width-approved-continuation-27da762b.md)
first, including its signed feedback commit and exact-SHA review. Then record
that actual reviewed successor as this correction's base. Preserve it and its
ancestors. This correction is a **separate signed successor**, not an addition
to the padding commit. Do not restack for delivery before this correction is
reviewed. If the head has already moved, reconcile the actual reviewed state;
do not replay the old snapshot or assume the observed SHA remains current.

## Required correction

- Suppress successful final replies without Output in the shared chat
  presentation. Do not leave an empty row, metadata sentence, agent-name-only
  line or stale Preview behind. Preserve the visible person request.
- Keep explicit Output, failures, interrupted attempts, questions and actionable
  status visible. Carry retained evaluation failures through the screen-facing
  reply projection; do not hide them under the silent-success rule.
- Keep saved-without-evaluated-response status distinct from a recorded success.
- Make Sessions reveal target a visible existing item: the reply/status when
  present, otherwise the containing request established from the same chat's
  request/feedback history. Include automatic follow-ups. Do not infer ordinal
  identities or manufacture a chat message as an anchor.
- Apply the same presentation on cold reopening without changing any byte or
  asking any provider. Preserve all turn/control/feedback history and agent
  feedback behavior. Follow the Architect's bounded unknown-association rule
  rather than borrowing unrelated context.

The allowed source boundary is `application.ts`, `program.ts`, and only the
detached presentation association in `sidekick/model.ts` if required. Preserve
evaluation, owner lifetimes, feedback routing, entry admission, storage and
canonical identities. Reuse the existing mounted terminal, real histories and
scripted transport seams. Do not add a second terminal host or renderer hook.

## Frozen focused evidence

| Row | Required observation | Destination |
| --- | --- | --- |
| ER1: silent success | Drive real control-only success through mounted Send. After acknowledgement, the person request remains but no placeholder, empty agent row or Preview remains in the actual composition/frame. Assert the control result and literal feedback reached the next turn and the saved turn/control/feedback records still exist. | mounted `repl-sidekick-journey.test.ts` / presentation |
| ER2: explicit Output | The same real control path followed by explicit Output shows that Output normally. Preserve exact content and its existing identity/ordering claim. The superseded PV1 notice assertion becomes an assertion of no silent utterance alongside the real follow-up, rather than simply being deleted. | journey / existing output selection |
| ER3: unsuccessful no-Output | A real evaluated reply failure without Output remains visible with its recorded reason. Existing provider-failure, interrupted/Stop and pending-question assertions stay green. Assert the failed saved outcome as well as screen text so a generic fabricated status cannot pass. | mounted presentation/journey and existing lifecycle |
| ER4: Sessions | Select a successful control-only turn and an automatic control-only follow-up from Sessions in a populated chat whose containing request is initially off-window. The actual window reveals that request, retains turn identity/status and creates no reply row as an anchor. The visible-Output control still reveals its own output. Preserve both composers/selection boundaries and distinguish the requested chat from another chat. | mounted presentation, existing Sessions fixture |
| ER5: cold reopen | Reopen the real files from those success/failure journeys through `runReplProgram`: successful silent replies remain absent, explicit Output and failures remain visible, and Sessions still reaches associated context. Compare exact file bytes before/after opening and assert zero provider/session/prompt work from the read. Reuse cases/data rather than invent a second history. | mounted presentation plus recovery corpus |

Rows may share fixtures and a mounted journey; the table is not a demand for
five new test groups. Existing valid saved-without-response, Preview correlation,
cross-chat identity, question and failure controls must retain their claims.
No new malformed-history, provider/runtime or mutation matrix is assigned.

Run both focused selections against the final tree:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
```

These selections add evidence that padding tests alone cannot supply. Preserve
the first output of each failure before retrying. Fix affected failures and
rerun their selection; do not weaken assertions merely to remove the notice.
Only the explicit former expectation of the unwanted notice is superseded.

Update the affected chat/reveal specification and architecture prose alongside
the implementation. When the focused evidence passes, promptly create one
signed feedback commit. Return exact SHA/parent/tree/signature, commands/results,
ER1–ER5 mapping, fixture/assertion adaptations and any remaining limitation.
No full lint/check/JSR/runtime suite or CI prerequisite is added to this feedback
boundary. No push or rebase before this successor's review.

## Continuity

This assignment follows the padding successor and precedes the already released
final restack/delivery. Both signed corrections must be carried into PR2's
delivery head. PR1 remains accepted at 85da74b9 until its planned restack. Recheck
current main at that later boundary. #928–#931 and the other deferred follow-ups
stay separate; no mockup-alignment claim is made. The Architect/Planner has
changed reviewer records only, not implementation, refs or existing owner work.
