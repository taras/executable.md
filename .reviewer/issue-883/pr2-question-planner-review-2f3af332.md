# Sidekick question-drawer review at 2f3af332

**REQUEST CHANGES — 2026-10-14.** Two mounted paths violate the existing
question/form/focus contract. Follow
[the correction prompt](pr2-question-implementor-correction-2f3af332.md).
No new product or architecture ruling is required.

## Exact revision

Reviewed `2f3af332e09a7aa8e6acda6e51e1f63aab13614e`, parent
`a438905f8fa98d245bb6444058bd470f1312411b`, branch agent/issue-883-pr2.
Signature independently verifies G, tarasm@gmail.com. The worktree is clean.
The commit changes 10 files, +1887/-162. Review changed no production or index
files and performed no push, GitHub mutation, CI inspection or capture.

## Q-P1 — the hidden form consumes Draft typing

reduceRepl obtains its input owner through openAsking (application.ts:1219,
1873), which checks the held open flag and pending key but not whether the
Sidekick form is actually presented. Rendering uses presentedAsking and
showingSidekick (4099, 4114), which also check the selected reading and profile.
Those answers can differ.

The real mounted probe opens a question from the default wide Sidekick pane
without selecting its tab, then shrinks to 72x20. The existing route correctly
shows Entries and no question form. It focuses the visible Draft field and
types ordinary. Draft stays empty; expanding shows partialordinary in the
Sidekick answer field. The recorded observation is:

```text
{"hiddenFormDraft":"","typedIntoHiddenForm":true}
```

The paired explicit-Sidekick control keeps its question visible after shrink
and correctly edits that question's own field.

This fails step 3's selected-body/target boundary, the accepted default versus
explicit shrink behavior and MQ4's preserved input/state contract. A held
partial form may remain in state without owning keys sent to another visible
input. Preserve the form; fix input ownership rather than clearing it or
changing default route behavior to avoid the state.

## Q-P2 — History close acts on the underlying form and ends the command

drawerContent/presentedRect give a route drawer precedence, but drawerFor
(application.ts:4177) selects the Sidekick key through presentedAsking even
when that route drawer is on top. Its close and scroll controls are then
Sidekick controls attached to History content.

The mounted probe opens History through the reachable footer control while
the Sidekick form is open, then presses History's close once. Instead of
closing History and returning to the still-open form, it closes the underlying
Sidekick presentation and claims focus on sidekick:answer outside the remaining
History modal. The actual command raises:

```text
ReplDescriptionError: sidekick:answer claims focus and drawer:open is the open
modal, which does not contain it.
```

The paired History-open/close control with the Sidekick form already closed
passes. The existing modal validator catches the invalid description; do not
weaken it.

This fails step 3's single presented drawer, route-drawer precedence and
preserved History/focus behavior. Close, scroll, field routing, fitting and
restoration must agree about the currently presented owner, rather than infer
it independently from a retained open form.

## Independent evidence

All six frozen commands pass on this exact commit:

| Selection | Tests | Steps | Output |
| --- | ---: | ---: | --- |
| Sidekick presentation / journey / lifecycle | 17 | 59 | [log](pr2-question-review-2f3af332-mounted-first.log) |
| Entries / history / agent execution / controls / output | 51 | 201 | [log](pr2-question-review-2f3af332-entries-first.log) |
| Storage / recovery / configuration | 11 | 63 | [log](pr2-question-review-2f3af332-recovery-first.log) |
| Journey / agent interface / agent journey / forms | 71 | 185 | [log](pr2-question-review-2f3af332-journey-first.log) |
| Route / layout admission / presentation style / source reading | 28 | 130 | [log](pr2-question-review-2f3af332-layout-first.log) |
| Execution / lifecycle | 6 | 39 | [log](pr2-question-review-2f3af332-lifecycle-first.log) |
| Total | 184 | 677 | |

Exact commands, run from the implementation worktree:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

[The reviewer probe](pr2-question-presentation-probe-2f3af332.test.ts)
contains two regression/control pairs using the real mounted program.
[Confirmed output](pr2-question-presentation-probe-2f3af332-confirmed.log)
shows both regressions red and both controls green.
[The first fully valid run](pr2-question-presentation-probe-2f3af332-final.log)
is preserved too. Probe authoring errors were corrected separately: the first
source omitted Elicit's required as capture, and an intermediate resize
assertion read accumulated frames. Those initial logs are preserved but are
not evidence of product defects. The confirmed run reads the actual resized
frame and observes the wrongly edited hidden value.

No environment limitation or U2 intermittence appeared in the six commands.
The generic unsafe-proto hint after failed expect calls in the probe does not
explain either failure.

## Non-blocking disposition

The root WeakMap binds question keys to exact pending objects; the view carries
detached form/message facts and no submit operation. Canonical validation,
answer journaling, designated feedback and the two owners remain intact.
The common form builder and separate close/preservation states follow the plan.

The three reported implementation adjustments are within scope: previewing
the presented question's own message, placing a single visible Stop row in
the drawer's fixed slot, and measuring scroll-sidekick-question. The fixture
extensions preserve the one terminal host and existing assertions. No broader
kernel or Core amendment is needed for the two findings.

The supplied [question-wakeup mutation](pr2-question-review-2f3af332-control-q1.log)
fails MQ1 alone while the entry announcement remains green, and
[close-clears-form mutation](pr2-question-review-2f3af332-control-q2.log)
fails MQ2's preservation arm while its no-close control stays green.
Review inspected these outputs and the restored source without repeating
production mutations.

The frozen suites do not cover the two inconsistent presentation-owner
transitions above. These findings restore already assigned boundaries;
no new question/schema permutation matrix is added.

## Continuity

Latest accepted head remains a438905f. The question-drawer increment at
2f3af332 is unaccepted pending Q-P1/Q-P2 correction and review. Previous
M-P1/M-P2, configuration P1/P2, the mounted message slice and R2 stay closed.

Next Implementor action: apply the linked correction from 2f3af332, promote
the two paired regressions, run the frozen evidence and return one signed
feedback commit. Deferred preview, Configure/Retry, configuration controls,
Sessions integration, terminal completion and the capture packet stay
deferred. No delivery action opens.
