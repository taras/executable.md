# Correction prompt: use the conversation's agent for its session and prompt

**Completed and accepted at 2cd171929c081cf21c321054edc57b60c37ea1e8.**
The [Planner review](pr2-configuration-planner-review-2cd17192.md) closes P1,
accepts the configuration increment and releases the next assignment: section
4's frozen R2 cases 2/5/6. The prompt below remains the historical correction
contract. Its temporary pause and reviewed-base status are superseded by that
acceptance; no production or evidence requirement is withdrawn.

Continue as Implementor from `00a1952763ce12e84b84912596a539ed41230386`
on agent/issue-883-pr2. The Planner verdict is REQUEST CHANGES, recorded in
pr2-configuration-planner-review-00a19527.md. Preserve this configuration
increment and all previously accepted work. Do not resume R2 cases 2/5/6 yet.

## Required correction

Make the selected conversation agent own both resolutions of a turn: its
canonical session placement and its canonical prompt. Core's current
conversationTurn places a session whose provider resolves an unnamed agent,
then names request.agent only for the prompt. A nondefault conversation
therefore cannot run.

This is a Core correction inside PR 2, authorized as restoration of the existing
AgentConversationRequest.agent and C3/R7 contracts. Use Core's existing lexical
agent-selection mechanism: AgentComponent in agent/function-components.ts
resolves its selection and binds unnamed agent resolution within its scope.
Apply that principle within the canonical conversation turn's own scope so
session placement sees its selected agent and the prompt agrees. Resolve the
requested agent before allocating its session. Ordinary internal mechanics are
yours; the ownership and scope are settled here.

Do not install a CLI workaround around the conversation's whole execution.
Do not change the host default, entry agent selection, provider registry or
other conversations. Keep explicit named agent resolution compositional.
Preserve the opaque one-use placement request, claimant-issued identity,
configuration settlement/readback, native-identity mismatch checks, turn
journaling and cancellation join. Do not add an agent field to the public
placement request, weaken the ACPX mismatch refusal, or create a new method.
If evidence contradicts the existing scoped mechanism's suitability, report
that concrete boundary before choosing another authority channel.

The configuration choice to inspect a candidate before activation is accepted.
Keep it: successful inspection sends no model prompt, and failed setup retains
the prior active association with the provider's reason. A valid null report
for unsupported settings remains a successful inspection.

## Frozen evidence

1. Run the bound review probe unchanged. Both default and nondefault cases must
   report the same agent for session and prompt. Its import-only adaptation
   lives in the root .reviewer directory; do not alter its assertions or stub.
2. Make the same default/nondefault distinction permanent in Core's conversation
   tests. The session stub must actually ask Agent.operations.agent(), as ACPX
   does. Keep the default case as the positive control. Restoring the old
   placement-before-binding behavior must fail the nondefault regression.
3. Complete the existing R7 switch row through the next explicit message using
   the real ACPX provider and scriptable runtime. First retain its assertions
   that switching itself sends no prompt and keeps prior chat. Then require a
   successful reply and prove the new conversation's session and prompt use
   OTHER, while the predecessor retains its original association.
4. Complete the existing R7 reopen row through an explicit message. First keep
   cold reopen free of provider work. Then require the saved agent OTHER to
   serve the turn even though the reopened owner was given a third selection.
   Observe the actual provider/session agent, not just owner.agent. Remove the
   temporary comments excluding this observation. These two real-provider rows
   provide integration evidence; no additional agent permutation matrix is
   required.
5. Preserve the existing nine configuration rows and all accepted Stop,
   feedback, metadata, Elicit and admission behavior. Align touched Core/spec
   prose with the corrected scoped selection; do not broaden the interface.

Run these focused commands from the implementation worktree. ROOT below is
/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883.

```text
deno test --config deno.json --allow-all ROOT/pr2-configuration-conversation-agent-probe-bound.test.ts
deno task test packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-placement.test.ts packages/core/tests/agent-session-use.test.ts
deno task test packages/acp/tests/host-conversation.test.ts
deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts
deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts
deno task test packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-presentation-style.test.ts
deno task test packages/cli/tests/plan.test.ts packages/cli/tests/plan-cli.test.ts packages/cli/tests/plan-component.test.ts packages/cli/tests/plan-host-acts.test.ts packages/cli/tests/agent-adapters.test.ts packages/cli/tests/agent-options-cli.test.ts
deno task test packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
deno test --config deno.json --allow-all ROOT/pr2-metadata-delivery-probe-c5bec458.test.ts
deno test --config deno.json --allow-all ROOT/pr2-stop-startup-probe-88c482b7.test.ts
deno test --config deno.json --allow-all ROOT/pr2-stop-join-probe-88c482b7.test.ts
deno test --config deno.json --allow-all ROOT/pr2-feedback-receipt-probe-f5b60c99.test.ts
deno test --config deno.json --allow-all ROOT/pr2-feedback-contract-probe-97f8cb79.test.ts
deno test --config deno.json --allow-all ROOT/pr2-owner-failure-probe-e3aaa61e.test.ts
```

The last eleven commands preserve the submitted selection. The first three
cover the demonstrated Core boundary. The review's adapters/workflow first
outputs contain local DNS, Deno __proto__ and npm-cache permission failures.
Report an environment limitation explicitly if it recurs; do not rewrite
assertions, change dependencies or treat it as a passing check. A reproducible
environment limitation does not require withholding the correction feedback
commit after its discriminating product checks pass. No full runtime suite,
CI inspection, typecheck or lint is a feedback-commit prerequisite. If ordinary
checks are also run, report them separately.

## Handback

Commit promptly after the focused product evidence passes. Return the exact
signed SHA, parent, branch and tree status, every focused command and result,
the default/nondefault observations, and the switch/reopen actual-turn evidence.
Report the single restoration control separately and verify the mutation
actually applied before interpreting its result. Update the Implementor
handback and stop for review. Nothing here authorizes a push, GitHub mutation,
CI inspection/dispatch or continuation into the remaining interruption work.

Exact base is 00a19527; latest accepted increment is 3d363e38. Produced artifacts
are this prompt and its companion review, with the root planning handoff updated.
The sole product blocker is the demonstrated conversation-agent mismatch. R2
cases 2/5/6, section 5 and complete R7 remain incomplete.
