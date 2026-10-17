# Sidekick question correction review at bb60ca35

**PASS — 2026-10-14.** Q-P1 and Q-P2 are closed. The bounded mounted
Sidekick question-drawer slice is accepted at this exact revision, under
MQ1–MQ5 and the two promoted regression/control pairs.

## Exact revision

Reviewed `bb60ca35661c2988ef647cc7a456470482d06e2e`, parent
`2f3af332e09a7aa8e6acda6e51e1f63aab13614e`, branch agent/issue-883-pr2.
Signature independently verifies G, tarasm@gmail.com. The worktree is clean.
The correction changes three files, +207/-6, without amending its parent.
Review changed no production or index files and made no push, GitHub mutation,
CI inspection or capture.

## Findings closed

**Q-P1:** reduceRepl now receives the Sidekick question key derived from the
painted view. openAsking requires that key to match the exact held/pending
question before routing form input. program.ts updates that fact beside
rendered from the initial committed paint, its focus-correction paint and
both corresponding loop paints. An unpainted remount publishes no new frame;
it does not substitute a proposed view for the frame the person acted against.

The hidden form keeps its partial state. In the unchanged mounted probe,
narrow Entries receives ordinary in its focused Draft, and the expanded
Sidekick form still contains only its original partial value:

```text
{"hiddenFormDraft":"ordinary","typedIntoHiddenForm":false}
```

The explicit-Sidekick control still edits its own visible form after shrink.
No route is selected on resize, no form values are cleared to avoid the state,
and no field-name heuristic chooses the input owner.

The trailing frame-derived reducer parameter is an accepted CLI-private
mechanic. It carries a presentation fact, not permission authority or a new
service. Its absent default presents no Sidekick form. The exact-question
root submission guard remains in place.

**Q-P2:** presentedAsking now yields to the route drawer, so History gets its
own content, width, window, close and scroll controls. One close returns to the
underlying open question with partial values intact. The separate sidekick-answer
focus claim is silent under another route modal or when its pane is hidden.
validateDescriptions and the one Freedom focus store are unchanged.

The promoted History regression asserts the form and original partial value
return and the command remains running; the closed-form control keeps ordinary
History close working. Nothing dismisses a permission or answers another owner.

## Independent focused evidence

All six frozen commands pass on their first review runs:

| Selection | Tests | Steps | Output |
| --- | ---: | ---: | --- |
| Sidekick presentation / journey / lifecycle | 18 | 63 | [log](pr2-question-review-bb60ca35-mounted-first.log) |
| Entries / history / agent execution / controls / output | 51 | 201 | [log](pr2-question-review-bb60ca35-entries-first.log) |
| Storage / recovery / configuration | 11 | 63 | [log](pr2-question-review-bb60ca35-recovery-first.log) |
| Journey / agent interface / agent journey / forms | 71 | 185 | [log](pr2-question-review-bb60ca35-journey-first.log) |
| Route / layout admission / presentation style / source reading | 28 | 130 | [log](pr2-question-review-bb60ca35-layout-first.log) |
| Execution / lifecycle | 6 | 39 | [log](pr2-question-review-bb60ca35-lifecycle-first.log) |
| Total | 185 | 681 | |

Exact commands, run in the implementation worktree:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

The unchanged reviewer probe also passes, one test / four steps:

```text
deno test --allow-all --config ./deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-question-presentation-probe-2f3af332.test.ts
```

[Complete probe output](pr2-question-review-bb60ca35-probe-first.log).

[The supplied restoration output](pr2-question-review-bb60ca35-control-qp.log)
shows both regressions red and both paired controls green. Q-P1 consumes Draft
keys again; Q-P2 fails because History does not leave after one close.
Leaving the new focus-claim guard installed changes Q-P2's failure from the
original ReplDescriptionError to the still-unmet close observation. That
restoration is sufficient: the control proves the required behavior remains
discriminating without requiring the secondary command-failure guard to be
removed too. The original exact exception remains preserved in the base review.

The handback reports diff-confirmed mutation and byte-identical restoration.
Review inspected its output and the restored source, reran all assigned
evidence, and did not mutate production. The previous question-wakeup and
partial-close controls stand because those connections did not change.
No existing assertion or fixture was adapted.

No environment limitation or U2 intermittence occurred in this review.
The earlier local U2 flake record remains unresolved; a green current run does
not establish a fix. No full suite, lint/check/JSR or CI result is used for this
feedback verdict.

## Continuity

Latest accepted head: signed clean bb60ca35. Q-P1/Q-P2 and the bounded
question-drawer slice are closed. MQ1–MQ5 now stand with their original
evidence plus the two presentation-ownership pairs. Previous mounted
M-P1/M-P2, configuration P1/P2 and R2 stay closed.

Next is a separate bounded Planner assignment for the remaining section 5
work, beginning with Configure/Retry and agent/model/effort controls.
No next implementation assignment opens merely from this verdict; the
Implementor holds at bb60ca35.

Streamed preview, Sessions integration, remaining terminal acceptance and
the 36-frame packet remain incomplete. No delivery verdict, push, GitHub
mutation, CI inspection or capture is implied.
