# Implementor correction: question presentation at 2f3af332

**Closed at bb60ca35, 2026-10-14.**
[The PASS review](pr2-question-planner-review-bb60ca35.md) accepts both fixes
and the bounded drawer slice. This prompt is historical and assigns no
further implementation.

Correct two failures of the existing question-drawer assignment: a hidden
Sidekick form must not consume Draft text, and History controls must act on
History when it is the top drawer.

Follow .agents/implementor.md. Work in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`, branch agent/issue-883-pr2,
from exact signed clean base
`2f3af332e09a7aa8e6acda6e51e1f63aab13614e`, parent
`a438905f8fa98d245bb6444058bd470f1312411b`.
Verify the head and reconcile any later delta without reset, amend or discard.

Read [the review](pr2-question-planner-review-2f3af332.md) and
[the frozen drawer plan](pr2-section5-question-drawer-planner-handoff.md).
The current revision and all existing MQ1–MQ5 assertions are preserved.
No product or architecture decision is delegated.

## Required correction

Make the current presented form/drawer govern input, controls and focus.
Retaining an open Sidekick form in process state does not establish that it
is visible or that it owns the top modal. Use the current selected reading,
profile and route-drawer precedence consistently. Private factoring and how
that derived fact reaches the reducer are implementation mechanics.

For Q-P1:
- From the default wide Sidekick pane, opening its answer form and shrinking
  to narrow leaves the existing route selecting Entries. The form remains
  pending and its partial fields stay stored, but Draft typing edits Draft.
- The explicit Sidekick-selected control continues to edit its visible form
  after shrink. Preserve the accepted default/explicit route behavior; do not
  select a different reading on resize or clear partial values to avoid this.
- Choose input ownership from the presented target/owner, not an open flag,
  a field-name heuristic or a form that happens to remain in state.

For Q-P2:
- A route drawer takes precedence over the Sidekick form for content, width,
  scroll actions, close action and focus restoration.
- History opened over a Sidekick form closes with one ordinary close action.
  Return to the previously open question with its partial fields intact.
  No outside focus claim is made while History still owns the modal.
- Preserve History and other existing route drawers. Do not force the person
  to close Sidekick first, require two close actions, suppress the error,
  weaken validateDescriptions or add another focus store.

Keep the exact-question root check, independent forms/providers, canonical
schema/answer path and Stop lifetimes. No Core/ACP API, schema, response
ceiling, journal, route codec, permission or vendored kernel amendment is
needed. Do not broaden the fix into unrelated modal redesign.

## Finite evidence

Promote both regression/control pairs from
pr2-question-presentation-probe-2f3af332.test.ts into the mounted presentation
destination, reusing mounted-program.ts. The probe lives in the main checkout:

`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-question-presentation-probe-2f3af332.test.ts`

Preserve these exact distinctions:
1. Enter the default wide Message box through focus traversal, without
   activating the Sidekick tab. Open the question, shrink, focus visible Draft
   and type. Draft changes; the hidden question's previous value does not.
   The explicit-Sidekick control still edits its own visible form.
2. Open History from the question modal, close it once, and return to the open
   question without a command failure or lost partial state. The paired case
   with the Sidekick form already closed keeps ordinary History close working.

Read only frames belonging to the current size for resize assertions.
Use explicit readiness observations and the real mounted actions, not reducer
fixtures that inject the desired active owner. No additional size/schema
permutations are assigned.

Run the original six commands after the final source/spec edit:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

Also run the reviewer probe unmodified:

```text
deno test --allow-all --config ./deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-question-presentation-probe-2f3af332.test.ts
```

All four probe steps must pass. Verify discrimination by restoring the
reviewed ownership condition(s): the corresponding regressions fail while
their paired controls stay green. If one shared fix covers both failures,
one restoration showing both regressions red and both controls green is
sufficient. Confirm every mutation applied before interpreting the result,
preserve first output, restore byte-identically and rerun affected evidence.

The prior question-wakeup and partial-close controls stand unless their
connections materially change. Preserve MQ1–MQ5 and the previous mounted,
entry, recovery and configuration assertions. Report every fixture/assertion
adaptation. No full suite, lint/check/JSR, packaging build or CI wait is required
for feedback.

Commit promptly as one signed feedback correction once this finite evidence
passes. Preserve 2f3af332 as parent rather than amending it. Return exact SHA,
parent, branch, signature, clean-tree status, commands/results, paired
observations and discrimination evidence. Stop for review.

## Continuity and limits

Base: 2f3af332. Artifacts: this prompt, the linked review/original plan and
the named probe. Settled decisions: visible input owns typing; the top
presented drawer owns its controls and focus. No architecture ruling remains
open for this correction. Latest accepted prerequisite is a438905f; this
question increment remains unaccepted until corrected and reviewed.

Previous M-P1/M-P2, configuration P1/P2 and R2 stay closed. No preview,
Configure/Retry, configuration controls, Sessions integration, terminal
packet or delivery work opens. No push, GitHub mutation, CI inspection,
main-checkout production change, dependency change or capture is assigned.
