# PR #921 review at d906c636

Verdict: **REQUEST CHANGES** — two reproduced presentation findings. The three
assigned focused commands pass. Earlier accepted Core, ACP, owner, recovery,
configuration, Preview, Sessions and responsiveness decisions stay closed.

## Reviewed revision and scope

- PR: https://github.com/taras/executable.md/pull/921
- Head: d906c6360533aaf894f5424dd4689aceedf08c3b.
- Parent / last accepted feedback: 25227d38cb8087743cd404533c7960de9423a442.
- PR base: agent/issue-883-pr1 at 79d404d04d02c3840892473b6f1b2cf540f3edd1,
  stacked on PR #890. This is not a diff against main.
- Implementation worktree: .claude/worktrees/issue-883-pr2, branch
  agent/issue-883-pr2, exact head, signature G / tarasm@gmail.com, clean before
  and after review.

I resolved the PR and stack, inspected the branch-wide file roster and reviewed
the new 25227d38..d906c636 source, tests, fixtures and prose against the released
composer, equal-width and guidance/padding assignments. This review adds focused
verification of that last increment; it does not claim a fresh independent
review of every previously accepted line across the entire stack.

Governing assignments:

- pr2-sidekick-message-composer-planner-addendum.md — MC5–MC7.
- pr2-sidekick-pane-width-planner-addendum.md — PW1–PW2.
- pr2-guidance-padding-planner-amendment.md — G1/P1 and the resolved width conflict.

## 921-P1 / P2 — the minimum composer can leave no chat

Source: packages/cli/src/repl/program.ts:3515–3520.

At the supported 72x20 profile, select a turn in the current chat through
Sessions while the Sidekick has a pending question. The resulting frame keeps
Back to current chat, Configure, the question announcement and opener, the
composer label and its minimum one value row, the working announcement and
Stop. Those fixed rows exhaust the body: the actual chat viewport height is
zero. Both window controls remain drawn, with no message between them.

The measured capacity is zero, but Math.max(1, capacity) makes it an allowance
of one anyway. Reducing the value further is impossible because the composer
is already at its minimum. This silently violates the released contract that
normal drawable states leave at least one chat row and that a minimum-frame
conflict is returned rather than hidden.

Evidence:

- pr921-narrow-question-capacity-probe-d906c636.test.ts drives the real
  presentation pipeline: pending question yields a 68-column, zero-height chat
  viewport; the same busy selected-chat frame without the question yields two
  rows. Regression fails, control passes.
- pr921-mounted-narrow-question-probe-d906c636.test.ts independently drives
  runReplProgram through the existing mounted fixture. It sends a first message
  and retains PREVIOUS-REPLY, asks a real canonical Elicit question, clicks the
  first turn in Sessions, then resizes to 72x20. The retained reply disappears
  because no chat row exists. The no-question control shows it. Regression
  fails, control passes.
- Outputs: pr921-narrow-question-capacity-probe-d906c636-first.log and
  pr921-mounted-narrow-question-probe-d906c636-valid-schema-first.log.

Resolve the minimum-layout conflict before accepting this increment. Do not
paper over zero capacity as one, weaken the one-chat-row observation, remove
required controls, or change the supported minimum profile without a settled
product decision. The existing assignment explicitly calls for returning this
conflict when the minimum frame cannot satisfy it.

Probe construction note: the mounted driver's first two attempts used an Elicit
fixture missing `as`, then missing `additionalProperties:false`. Core correctly
refused each. Their outputs are preserved under `-first.log` and
`-corrected-first.log`; neither is evidence of a product failure. The final
driver uses a valid closed schema and supplies the failing product observation.

## 921-P2 / P2 — Sidekick padding also changes Bindings

Source: packages/cli/src/repl/application.ts:7897–7900.

The right column is always wrapped in sidekickBody(), including when Bindings
is selected. chatColumn() places the binding rows at bodyWidth(), so they are
also shifted two cells and narrowed four cells. The accepted amendment states
that Bindings keeps its existing body layout; padding applies to the Sidekick
body, not to the alternate reading.

The real committed binding geometry is:

| Size | Pane interior x / width, required for Bindings | Binding row x / width |
| --- | --- | --- |
| 160x36 | 97 / 63 | 99 / 59 |
| 120x30 | 75 / 45 | 77 / 41 |

Evidence: pr921-bindings-padding-probe-d906c636.test.ts executes an entry that
publishes a binding, selects Bindings and reads its actual committed bounds.
Both sizes fail. First output is preserved in
pr921-bindings-padding-probe-d906c636-first.log.

Scope the padded body to the Sidekick reading and retain the full measured pane
interior for Bindings. PW1 currently expects SIDEKICK_BODY under both tabs,
which encodes this scope mistake; preserve both-tab outer-width checks while
making the body assertions distinguish the two accepted layouts. Retain the
existing Sidekick padding and full-pane drawer checks as controls.

## Independent focused verification

All commands ran at the exact clean head; no result predates it.

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-presentation-style.test.ts
deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
```

| Command | Tests / steps | Result |
| --- | --- | --- |
| 1 | 51 / 171 | PASS |
| 2 | 24 / 132 | PASS |
| 3 | 73 / 225 | PASS |
| Total | 148 / 528 | zero failures |

First outputs: pr921-review-d906c636-command-{1,2,3}-first.log. No reruns were
needed. git diff --check 25227d38..d906c636 also passed.

No production changes or mutations, commit, push, GitHub review/comment,
CI inspection, capture, broad lint/check/JSR or exhaustive runtime suite occurred.
The unfamiliar-agent teaching walkthrough, 36-frame packet and delivery gates
remain separate from this feedback review.
