# Planner review: Sidekick configuration at 00a19527

REQUEST CHANGES at `00a1952763ce12e84b84912596a539ed41230386`, parent
`3d363e38977cbfe548f4d4b8f89f67a59b1da232`, branch `agent/issue-883-pr2`.
The signature verifies G for tarasm@gmail.com and the implementation worktree
is clean. One P1 blocks acceptance of the configuration increment. The latest
accepted increment remains 3d363e38.

## P1: the selected agent does not own the session used for its turn

Core's conversationTurn in packages/core/src/agent/conversation.ts places the
session before resolving request.agent. The ACPX session path in
packages/acp/src/provider.ts asks Agent.operations.agent() without a name; the
prompt path resolves the explicitly named agent. Consequently a conversation
under a nondefault agent receives a session for the host's default agent and
cannot take its promised turn. The provider's agent/session mismatch refusal is
correct; weakening that refusal would conceal the defect.

The independent probe confirms both resolutions. The default-agent control
passes. In the nondefault case the prompt sees other-agent, while the session
sees stub-agent. This violates C3 and R7/J9's existing requirement for actual
different agents, not just retained selections. No new product or architecture
decision is needed to correct it.

The original supplied probe has imports relative to a Core test directory but
lives under .reviewer/issue-883. Running it by absolute path first failed module
resolution. That output is preserved in
pr2-configuration-agent-probe-00a19527-original.log. The separate
pr2-configuration-conversation-agent-probe-bound.test.ts changes only those
imports to the reviewed worktree's Core files. Its stub and assertions are
unchanged. The behavioral failure above is preserved in
pr2-configuration-agent-probe-00a19527-first.log.

The two R7 rows deliberately stop before sending the next message after a
switch or reopen. Their current green result establishes the association, not
the required functioning conversation. Complete those same rows after the
Core correction; do not replace their existing no-prompt/cold-open assertions.

## Rulings on the submitted configuration work

The candidate inspection before activation is accepted as the implementation
of the existing successful-setup requirement. A handle opening reaches no
agent; options inspection reaches the candidate without a model prompt and
can preserve the prior association when setup fails. An unsupported setting
reported as null is an agent answer, not a setup failure. An inspection failure
keeps its provider reason and activates no replacement. No separate approval
interview is required for this use of the existing inspection operation.

The passing focused rows establish provider-owned IDs, labels, descriptions,
groups and unsupported state; model-specific effort inspection; retained
preferences applied and read back at the next turn; rejection before a prompt;
no redundant configuration writes on the second turn; failed replacement
preserving the prior association; and busy refusals without writes. Keeping a
saved conversation's agent rather than using a new process selection is the
correct owner behavior, but its next turn remains blocked by P1.

The per-session configuration in fake-acp.ts supports the existing isolation
between inspection and conversation. The submitted architecture and REPL
specification paragraphs describe the intended accepted behavior. The
temporary test comments about the Core blocker must be removed when their
missing observations are supplied.

## Independently rerun evidence

Commands ran at the exact reviewed SHA in .claude/worktrees/issue-883-pr2.
ROOT means /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883.

| Command | Result |
| --- | --- |
| deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts | 26 tests, 147 steps, exit 0 |
| deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts | 38 tests, 146 steps, exit 0 |
| deno task test packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-presentation-style.test.ts | 25 tests, 96 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-metadata-delivery-probe-c5bec458.test.ts | 1 test, 2 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-stop-startup-probe-88c482b7.test.ts | 1 test, 2 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-stop-join-probe-88c482b7.test.ts | 1 test, 2 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-feedback-receipt-probe-f5b60c99.test.ts | 1 test, 3 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-feedback-contract-probe-97f8cb79.test.ts | 1 test, 5 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-owner-failure-probe-e3aaa61e.test.ts | 1 test, 3 steps, exit 0 |
| deno task test packages/cli/tests/plan.test.ts packages/cli/tests/plan-cli.test.ts packages/cli/tests/plan-component.test.ts packages/cli/tests/plan-host-acts.test.ts packages/cli/tests/agent-adapters.test.ts packages/cli/tests/agent-options-cli.test.ts | exit 1: 6 tests/92 steps passed, 3 tests/16 steps failed; child runs encountered registry DNS and Deno disabled __proto__ errors |
| deno task test packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts | exit 1: npm cache mkdtemp EPERM, followed by adapter-install/pending-event-loop failures; 17 steps passed, 1 failed |
| deno test --config deno.json --allow-all ROOT/pr2-configuration-conversation-agent-probe-bound.test.ts | exit 1: default-agent control passes, nondefault-agent assertion fails |

Nine commands pass, totaling 95 tests/406 steps. The two broader failed
selections are recorded as local environment limitations, not attributed to
this diff or silently counted green. Their complete first outputs survive in
pr2-configuration-review-00a19527-{adapters,workflow}.log. The other nine logs
use the same prefix with focused, consumers, forms, metadata, startup, join,
receipt, contract and owner. No rerun, full suite, CI result or mutation control
is substituted for those first outputs.

## Continuity and next action

The correction prompt is pr2-configuration-agent-implementor-prompt.md. It
authorizes the narrow Core correction within PR 2 and freezes its finite
evidence. Preserve the submitted configuration work and all earlier accepted
increments. Review changed no production files and grants no GitHub write,
push, CI inspection or dispatch.

Return a signed correction feedback commit before starting R2 cases 2/5/6.
Full R7 still requires section 5's flags, terminal Configure and busy-switch
integration. Program binding, the remaining R3/R4/R5 integration, mounted
questions/Exit/Control-C and the terminal packet remain incomplete.
