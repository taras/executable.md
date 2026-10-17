# Make Configure easy to close from the keyboard

**Completed: PASS at c2536dd0, 2026-10-16.** The
[exact-SHA review](pr921-configure-exit-planner-review-c2536dd0.md) independently
passes the unchanged probe and both frozen selections, 93 tests / 285 steps.
This assignment is closed. The same Implementor proceeds to
[bottom-up rebase and final delivery](pr890-pr921-final-delivery-continuation-c2536dd0.md)
from PR1 85da74b9 and PR2 c2536dd0. All instructions below describe the completed
correction and its historical starting inventory; they do not assign another
implementation pass or hold the delivery gate closed.

Follow `.agents/implementor.md`. Escape and the visible Close control must both
close the presented Sidekick Configure drawer. Its scrolling controls say
**Scroll up/down**, rather than Earlier/Later, while keeping all advertised
choices reachable.

## Current state and sequence

Observed HEAD: `6ca239527abe9d012be01fffc79197e882c52ca3`, signed G, clean,
on `agent/issue-883-pr2-main-integration` in `.claude/worktrees/issue-883-pr2`.
Padding is accepted and stays closed. The existing designated Implementor is
the sole writer; do not start another session in this worktree.

The [control-only reply correction](pr921-control-only-replies-implementor-handoff.md)
is already assigned. Finish and review that separate successor first, then
apply this correction as its own signed successor from the actual reviewed
head. Recheck owner/head/status before starting; preserve all accepted commits.
Both corrections must be included before the delivery restack. No production
source or ref was changed to prepare this handoff.

## Reproduction and direct trace

The [preserved probe](pr921-configure-close-probe-6ca23952.test.ts) ran through
the real mounted program at 6ca23952, replacing only the existing fixture's
terminal/transport seams. Its [first output](pr921-configure-close-probe-6ca23952-first.log)
is retained: Tab reached the visible Close control and Enter closed it; Escape
left Configure open and displayed `no drawer is open.` The probe exits 1 with
one passing and one failing step. No rerun or source fix was made here.

`DRAWER` in `components/rows.ts` emits `close-drawer` on Escape. Its reducer
branch handles a route drawer or the presented Sidekick question and otherwise
refuses. It does not handle Configure. The visible Close control correctly
emits `close-configure`, whose reducer already discards unapplied choices and
restores focus to the opener. These two paths disagree.

The reported inability to Tab to Close was not reproduced in the fresh probe.
Do not invent a cause or declare every Configure state healthy from that one
control. Add the bounded overflow/busy observations below and fix any actual
traversal or presentation defect they expose.

`drawerFor()` also uses the generic `EARLIER`/`LATER` labels for Configure's own
`configure-scroll` actions. These move the settings viewport, not History or
the chat. Removing scrolling would make off-window models/Apply unreachable;
correct the labels while preserving their functions.

## Required behavior

1. One Escape closes the **presented Configure** drawer with exactly the same
   semantics as its Close control: discard unapplied choices, save nothing new,
   send no message, and restore focus to its Configure opener. Preserve both
   composers and any independent pending question. Do not cancel or roll back
   an already admitted acknowledged save as an extra effect of closing.
2. `[close]` remains visible outside the settings window, mounted and reachable
   with Tab/Shift+Tab, Enter and pointer. It cannot scroll away with choices.
   Traversal stays inside the actual modal and adds no second focus store.
3. Route drawer precedence remains: if History is over Configure, the first
   Escape closes History alone and exposes the preserved Configure; the next
   Escape closes Configure. Hidden Configure cannot consume Escape intended
   for another presented reading. Sidekick question close keeps its established
   partial-answer rule; ordinary entry/permission close semantics are unchanged.
4. Configure's viewport controls read `[↑ scroll up]` and `[↓ scroll down]`.
   Their keys/actions, order, target ownership and scrolling behavior remain.
   Configure shows no Earlier/Later labels in its own pane. The sidebar/chat
   windows and History/other drawers retain their existing labels and styling.
5. Off-window model/effort choices, Refresh and Apply remain reachable through
   the real viewport controls. Preserve pane-local geometry, seven-row footer,
   busy Stop behavior, requested-versus-verified facts and provider identities.

Use the existing presented-frame fact to decide ownership, not the mere held
open flag. Reuse Configure's existing close semantics. Production scope is
`application.ts` and, if needed, its existing typed `components/rows.ts` input
boundary; private props/action threading is delegated. No renderer, generic
input decoder, lifecycle, owner job, storage, evaluation or route-codec change.

## Frozen focused evidence

| Row | Observation |
| --- | --- |
| CX1: Configure exits | Promote the probe's paired keyboard paths into the existing mounted configuration corpus. Start with typed composers and an unapplied choice. One Escape closes without a new preference/provider operation and restores the opener; Tab to actual Close plus Enter does the same. Use the current screen/committed focus marker, not a dispatch to the action. |
| CX2: overflow/busy Close | At 120x30 with the existing many-choice fixture, scroll to an off-window choice and Apply, then reach Close by real traversal. Repeat the exit while a message is held busy: Close is still reachable, closes the drawer without stopping the message, and both composers survive. Reuse existing CFG6 and busy fixtures; no new terminal host or provider matrix. |
| CX3: precedence | Open History over a partially edited Configure. One Escape closes History while Configure remains and keeps its choices; one more Escape closes Configure under its discard rule. Existing question/permission close tests stay green. |
| CX4: scrolling vocabulary | Inspect Configure's pane at wide/medium: Scroll up/down controls are drawn and targetable, Earlier/Later is absent from that pane, and a real scroll reaches the off-window choice. An ordinary pane/History control retains its old label as the scope control. |

These rows may share journeys and existing fixture data. No permutation matrix
or mutation battery. Preserve the original source-identities and no-write/no-
provider assertions. Adapt only Configure-specific expected scroll labels;
do not globally change every Earlier/Later expectation.

Run the preserved probe unchanged plus these two selections on the final tree:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr921-configure-close-probe-6ca23952.test.ts
deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-layout-admission.test.ts
```

Capture first failures. Fix affected failures before committing; do not weaken
the validator or focus claims. Align only affected Configure navigation/close
spec prose. Check/lint/JSR/full runtime suites and CI are not new feedback
prerequisites.

Once evidence passes, promptly create one signed feedback successor and return
SHA/parent/tree/signature, exact commands/results, CX1–CX4 mapping, adaptations
and limitations. Stop for review of that commit before restacking. Padding PASS
and the silent-reply correction's own review stay separate.

## Continuity

The user reports Configure cannot be closed by keyboard and still uses
Earlier/Later. Escape failure is independently reproduced; fresh Tab-close is
the passing control, with bounded overflow/busy evidence assigned. No question
is outstanding for this correction. Delivery includes padding, silent-reply
presentation and this Configure correction after their reviews. #928–#931,
broader UI alignment and other deferred work remain separate.
