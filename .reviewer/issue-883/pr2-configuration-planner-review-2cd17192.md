# Planner review: Sidekick configuration correction at 2cd17192

PASS at `2cd171929c081cf21c321054edc57b60c37ea1e8`, parent
`00a1952763ce12e84b84912596a539ed41230386`, branch `agent/issue-883-pr2`.
The signature verifies G for tarasm@gmail.com and the implementation worktree
is clean. P1 is closed and section 4's configuration increment is accepted.
Complete R7 still includes the deferred terminal/flag integration in section 5.

## Accepted correction

conversationTurn resolves the conversation's named agent before allocating a
session, then binds unnamed agent resolution within that turn's scoped work.
It uses the same Agent.around mechanism as the canonical AgentComponent and
passes explicit names through with name ?? agent. The session provider and
prompt therefore resolve the same selection, including a nondefault agent.
The binding ends with that turn; no CLI workaround or execution-wide default
change is introduced.

The placement remains opaque and one-use, with no agent field or new public
method. Claimant issuance, configuration settlement/readback, native identity
checks, canonical Prompt persistence and cancellation joining remain in the
same turn path. The ACPX agent/session mismatch check is unchanged. The four
prose updates describe the corrected scope without widening an interface.

The unchanged bound probe now passes both observations: stub-agent for both
halves of the default control, and other-agent for both halves of the
nondefault case. CV1a/CV1b permanently make the session stub ask the same
unnamed agent operation as ACPX. The nondefault row also verifies that an
explicit named-explicitly resolution still answers for itself.

Both R7 rows retain their original pre-message assertions before taking an
actual turn. Switching sends no prompt and preserves prior chat, then the new
conversation's first turn answers Second. Cold reopening sends nothing, then
the saved agent answers Reopened. despite the reopened owner's third selection.
The real ACPX provider establishes conversation sessions for [AGENT, OTHER],
the observed turn handles identify those sessions, and no session uses the
third selection. A reply through this unchanged provider also establishes the
prompt-side agreement: its prepare path compares the resolved agent command
with the exact issued session and refuses a mismatch before calling the runtime.
This is sufficient actual-provider evidence; no further agent matrix is needed.

The previous review's inspection-before-activation ruling stands. Provider
choices, null unsupported settings, model-specific effort, next-turn retained
preferences, apply/readback order, rejection without a prompt, failed setup
preserving the old association, and busy refusals remain covered by the nine
configuration rows. The temporary exclusions for switch/reopen turns are gone.

The Implementor reports a verified restoration control removing only the
scoped binding: CV1b and the nondefault probe fail while their default controls
pass. Review did not repeat that production mutation. The independently run
probe and permanent regressions agree with the reported distinction.

## Independently rerun evidence

All fourteen frozen commands ran at the exact reviewed SHA in
.claude/worktrees/issue-883-pr2. ROOT below is
/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883.

| Command | Result |
| --- | --- |
| deno test --config deno.json --allow-all ROOT/pr2-configuration-conversation-agent-probe-bound.test.ts | 1 test, 2 steps, exit 0 |
| deno task test packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-placement.test.ts packages/core/tests/agent-session-use.test.ts | 12 tests, 67 steps, exit 0 |
| deno task test packages/acp/tests/host-conversation.test.ts | 1 test, 4 steps, exit 0 |
| deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts | 26 tests, 147 steps, exit 0 |
| deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts | 38 tests, 146 steps, exit 0 |
| deno task test packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-presentation-style.test.ts | 25 tests, 96 steps, exit 0 |
| deno task test packages/cli/tests/plan.test.ts packages/cli/tests/plan-cli.test.ts packages/cli/tests/plan-component.test.ts packages/cli/tests/plan-host-acts.test.ts packages/cli/tests/agent-adapters.test.ts packages/cli/tests/agent-options-cli.test.ts | exit 1: 6 tests/92 steps passed; 3 tests/16 steps failed in child runs with registry DNS and Deno disabled __proto__ errors |
| deno task test packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts | exit 1: npm cache mkdtemp EPERM, followed by adapter-install/pending-event-loop failures; 17 steps passed, 1 failed |
| deno test --config deno.json --allow-all ROOT/pr2-metadata-delivery-probe-c5bec458.test.ts | 1 test, 2 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-stop-startup-probe-88c482b7.test.ts | 1 test, 2 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-stop-join-probe-88c482b7.test.ts | 1 test, 2 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-feedback-receipt-probe-f5b60c99.test.ts | 1 test, 3 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-feedback-contract-probe-97f8cb79.test.ts | 1 test, 5 steps, exit 0 |
| deno test --config deno.json --allow-all ROOT/pr2-owner-failure-probe-e3aaa61e.test.ts | 1 test, 3 steps, exit 0 |

Twelve commands pass independently, totaling 109 tests/479 steps. The two
broader selections encounter the same local environment limitations recorded
at 00a19527. They are not counted green or attributed to this correction.
Their first complete outputs, and all passing outputs, are preserved in
pr2-configuration-review-2cd17192-{bound,core,acp,focused,consumers,forms,adapters,workflow,metadata,startup,join,receipt,contract,owner}.log.
No rerun overwrote them. The Implementor separately reports all fourteen
passing, totaling 121 tests/608 steps; that is reported evidence, not an
independent result from this review environment.

The demonstrated blocker and its real-provider consumers pass. The frozen
prompt explicitly permits reporting an environment limitation without
withholding feedback. These repeated restrictions add no product finding or
architecture decision. No full suite, check/lint rerun, CI inspection or GitHub
result informs this feedback verdict.

## Continuity and next action

Exact accepted head is 2cd171929c081cf21c321054edc57b60c37ea1e8. Produced
artifacts are this review, the fourteen preserved logs, the completed correction
prompt and updated main planning handoff. The historical 00a19527 review and
first failing probe remain preserved. Review changed no production file.

The configuration blocker is closed. Continue section 4's frozen R2 cases
2/5/6 through the real conversation owner, provider/writers and fresh-process
restart. Cases 1/3/4 and all earlier accepted increments stay closed. Keep cold
open free of work; reconcile the same native identity, restore retained effects
without replaying a suffix, and establish feedback delivery from canonical
turn facts before any resend. Return a focused signed feedback commit.

Program binding, remaining R3/R4/R5 integration, mounted question/configuration
drawers, field preservation across tabs, busy-switch Stop integration,
Exit/Control-C, CLI flags and the terminal comparison packet remain incomplete.
This acceptance does not close full R7 or the complete CLI PR. No push,
GitHub mutation or CI inspection/dispatch is authorized.
