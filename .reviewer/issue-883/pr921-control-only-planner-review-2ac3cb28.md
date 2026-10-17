# Control-only reply presentation: PASS at 2ac3cb28

Successful replies without Output contribute no chat utterance or empty row.
Failures preserve their recorded reason, and Sessions reveals existing visible
context instead of inventing an anchor. ER1–ER5 pass. No correction remains
under this assignment.

## Exact revision

- SHA: `2ac3cb28778c19d25c2b98e540469c2aa9e9b784`.
- Parent: `6ca239527abe9d012be01fffc79197e882c52ca3`, preserved.
- Tree: `8aaa6b36967461e3e9d686518da5ea33592016ca`.
- Signature independently verified: G, tarasm@gmail.com.
- Branch: `agent/issue-883-pr2-main-integration`.
- Worktree: `.claude/worktrees/issue-883-pr2`, clean when inspected.

Reviewed against the [Architect decision](pr921-control-only-replies-architect-decision.md),
[focused handoff](pr921-control-only-replies-implementor-handoff.md) and
[Implementor handback](pr921-control-only-replies-implementor-handback-2ac3cb28.md).

## Independent focused evidence

Both selections ran once on this exact tree and exited 0. Their first outputs
are retained; no failure was discarded or hidden by a rerun.

| Selection | Result | First output |
| --- | --- | --- |
| mounted presentation / journey / lifecycle | 39 tests / 139 steps, zero failures | [command 1](pr921-control-only-review-2ac3cb28-command-1-first.log) |
| recovery / controls / output | 20 tests / 100 steps, zero failures | [command 2](pr921-control-only-review-2ac3cb28-command-2-first.log) |

Total: **59 tests / 239 steps, zero failures**.

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
```

`git diff --check 6ca23952 2ac3cb28` exits 0. The Implementor reports check,
lint and documentation validation green; these were not independently repeated
and are not conditions on this verdict. CI was not inspected. Reported break-it
controls are preserved in the handback, not claimed as independently repeated.

## Acceptance

ER1 drives real controls through mounted Send. The exact shared chat composition
contains only the person's request, while both saved turns, operation outcomes
and the literal ordered feedback delivered to the follow-up remain. ER2 retains
the prior explicit-Output path and strengthens the superseded notice assertion
with exact composed rows rather than removing the assertion alone.

ER3 drives an evaluated no-Output failure and checks the recorded reason and
saved failed outcome beside the correcting reply. Source inspection confirms
the reason now reaches presentation instead of being overwritten with undefined.
Only final successful replies lacking Output are suppressed: incomplete,
preview, saved-without-evaluated-response and question paths are unchanged.

ER4 selects both the person turn and silent automatic follow-up from Sessions,
with older/current chats distinguished and the target initially off-window.
It observes the containing request, no inserted anchor, the explicit-Output
control, retained turn status and composer restoration. ER5 reopens real files
through the mounted program, keeps silent replies absent and failures/Output
visible, preserves the chat file's exact bytes and adds no provider/session work.
The selected recovery/identity corpus also remains green.

The reveal asks the same composed/fitted rows what is actually visible. It
prefers a turn's own result, then its request and the derived containing person
request, so it cannot choose a suppressed row's missing key. `answers` is derived
from the existing per-conversation request stream; the unchanged owner serializes
one person message followed by that exchange's feedback requests. It is not a
global latest-message lookup, text match or conversion between response and turn
numbers. This association is used only for detached presentation, not authority,
feedback ownership or durable identity.

The one-line `owner.ts` addition completes the inert EMPTY reading for the new
required projection member. It changes no owner operation, scheduling, lifetime
or feedback behavior and is accepted as a mechanical type adaptation. The names
`answers` and `request` express their local presentation roles; no rename or
new public boundary is required.

## Limits and continuity

Reveal retains its prior first-row placement. A wrapped reason may continue
below the visible window; ER5 honestly checks the visible prefix. The complete
recorded reason is retained in the composition and remains scrollable. This is
not loss of the failure or a new reason to expand this correction.

A history with no provable containing request gets no fabricated context. The
bounded unknown-association branch is established by construction, not a newly
added successful-silent-history fixture. That follows the accepted absence
contract; no extra malformed-history matrix is required.

Padding remains PASS at 6ca23952. **Next is the separately assigned Configure
exit/navigation correction**, from exact 2ac3cb28, under
[its focused handoff](pr921-configure-exit-planner-handoff-6ca23952.md).
The handback's immediate-restack sentence does not supersede that assignment.
The same owner may start it now and must return its signed successor for review
before delivery restack. PR1 remains accepted at 85da74b9. All reviewed PR2
presentation commits enter delivery; #928–#931 and other deferred work stay
separate. No source, branch or remote was mutated by this review.
