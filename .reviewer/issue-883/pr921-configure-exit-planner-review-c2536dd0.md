# Configure exit correction: PASS

Reviewed on 2026-10-16. Exact feedback commit:
`c2536dd0494d0744d9af851c9bd60dd06f607e32`.
Parent `2ac3cb28778c19d25c2b98e540469c2aa9e9b784` is preserved;
tree `cc39e06b5b36b49421fa3f96ed22576de44db5c5`.
Signature independently verified G / tarasm@gmail.com. The PR2 owner worktree
is clean on `agent/issue-883-pr2-main-integration`.

The frozen [Configure assignment](pr921-configure-exit-planner-handoff-6ca23952.md)
is satisfied. Escape and visible Close now use the same discard/restore
transition. The presented frame determines whether Configure owns Escape;
History still closes first. Configure alone uses Scroll up/down labels.

## Independent verification

All commands ran once against this exact tree, with first output retained.

| Command | Result | First output |
| --- | --- | --- |
| `deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr921-configure-close-probe-6ca23952.test.ts` | 1 test / 2 steps, exit 0 | [probe log](pr921-configure-exit-review-c2536dd0-command-1-first.log) |
| `deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts` | 37 / 144, exit 0 | [Sidekick log](pr921-configure-exit-review-c2536dd0-command-2-first.log) |
| `deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-layout-admission.test.ts` | 55 / 139, exit 0 | [journey log](pr921-configure-exit-review-c2536dd0-command-3-first.log) |

Total: **93 tests / 285 steps, zero failures**. The preserved probe is unchanged.
The Implementor additionally reports check/lint exit 0 and completed docs
validation. Those checks were not repeated for this focused review. CI was not
inspected and is not a condition on this PASS.

## Acceptance and scope

- CX1 pairs real Escape with Tab-to-Close/Enter, with an unapplied model and
  typed composers. Both paths discard choices, restore the opener and add no
  preference, provider operation or prompt. Reopening shows the saved state.
- CX2 reaches a genuinely off-window model and Apply at 120x30, then reaches
  Close through traversal. Its held-turn arm closes the modal without stopping
  the turn; releasing the provider completes the reply and preserves the draft.
- CX3 closes History first while retaining Configure's selected model; the next
  Escape closes Configure without saving, and reopening discards the choice.
- CX4 checks the pane's new labels and real scrolling at wide and medium sizes,
  alongside the sidebar's unchanged Earlier label as the scope control.

The production diff is limited to `application.ts`: the old Close transition
is extracted into `closedConfigure`, Escape calls it under existing presented
ownership, and Configure chooses its own labels. Question/permission close,
owner jobs, history, provider lifetimes, evaluation and admission are unchanged.
The only existing test expectation adapted is Configure's own scroll label.
Affected specification prose states the implemented exits and labels.

The Implementor's reported break-it control distinguishes the repaired Escape
and label paths from the already-correct Close arm. No additional mutation
battery was required or repeated here.

The original Tab report remains unreproduced in the fresh, overflow and busy
representatives. This acceptance covers those finite scenarios; it does not
claim every possible list and terminal size. The existing half-filled-question
pointer journey remains green; a new Escape/question matrix is not required
by the frozen assignment. Neither limitation leaves a required correction open.

## Continuity and next action

Padding 6ca23952 and silent-reply presentation 2ac3cb28 remain accepted. With
this PASS, all three final presentation corrections are closed. PR1's accepted
source remains `85da74b938434773d7faf3caa5e2ca007328fdca`; PR2's delivery source is
`c2536dd0494d0744d9af851c9bd60dd06f607e32`.

The same designated Implementor now follows the [delivery continuation](pr890-pr921-final-delivery-continuation-c2536dd0.md):
recheck main, preserve sources, rebase replacements bottom-up, complete delivery
verification and publish through the existing #890/#921. This PASS introduces
no further UI assignment. #928–#931 and the other recorded follow-ups remain
separate. No production file, implementation ref, remote PR or CI state was
changed by this review.
