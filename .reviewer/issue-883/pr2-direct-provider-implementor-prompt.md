# Implementor assignment: correct saved-conversation routing for #883 PR 2

Continue on `agent/issue-883-pr2` in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
from exact signed base
`08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`, parent
`ef68c71ca26d24856e6a4a1e9d24943bd37876d1`. The Planner verified it clean.
Verify again; reconcile any later delta without reset, amend or discard.

**This assignment replaces the previous routing hold.** Implement P1 through
the accepted direct-provider boundary. P2 stays closed. Do not declare P1,
increment 4 or R2 accepted before the feedback commit is reviewed.

Records live in the main checkout, outside your implementation worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/`.
Read [the complete Planner plan](pr2-direct-provider-planner-handoff.md) and
[the Architect handoff](pr2-direct-provider-architect-handoff.md). The plan's
ordered work, DP1–DP5, preserved SC1–SC7 and commands are the frozen assignment.
Follow the repository instructions and .agents/implementor.md.

## Implement one coherent correction

1. Add Core's AgentConversationProvider interface and Context in
   agent/conversation-provider.ts, exported under that same name only from
   @executablemd/core/api. The exact four methods are:

   ```ts
   agent(name: string): Operation<string>;
   session(request: AgentSessionRequest, agent: string): Operation<Session>;
   options(agent: string, request?: AgentOptionsRequest): Operation<AgentOptions>;
   prompt(
     content: string,
     options: PromptOptions & { agent: string; session: Session },
   ): Operation<Stream<AgentPromptEvent, string>>;
   ```

   Context key: `executablemd.agent.conversation.provider`; default undefined.
   Keep AgentProviderFactory(options, coordinator): Operation<void> unchanged.

2. Have createAcpxProvider install that object for its exact concrete
   useAcpxProvider state and factory-delivered coordinator, alongside ordinary
   Agent middleware. Reuse private lookup/liveness checks. Direct session and
   prompt use the explicit agent through local resolution, never Agent.agent.
   Keep createPartitionedAcpxProvider dynamically selected per ordinary dispatch;
   it does not acquire fixed-service support through this correction.

3. Capture the object once in Core's AgentConversationHost held() scope after
   installation and before readiness. Missing object answers the explicit
   unsupported-saved-conversation AgentConversationError through existing
   readiness cleanup, with no provider work, configuration/Prompt record or
   completed durable root. No fallback to middleware. Pass the captured object
   to agent/session/options/prompt jobs; cold opening/replay calls none of them.

4. Keep original one-use request issuance and admitting(active), model/effort
   sealing, and setup.activate before any native work. Extend private issuance/
   setup bookkeeping to remember the exact result of successful finish,
   including configured use. The conversation accepts only that result and
   refuses any uncompleted or substituted Session before asking for a prompt
   stream. Keep issuance.close in finally and all native identity checks.
   Completion evidence is private and does not replace before-effects activation.

5. Supply the captured provider to the existing internal runPrompt consumer.
   Ordinary Prompt retains Agent.prompt dispatch. Reuse journal.ts's internal
   stream-audit wrapping for the direct path exactly once, retaining the
   outside-policy requestPermission observer and exact-stream ledger lookup.
   Preserve publisher begin/association, coordinator-issued checkpoint,
   started/terminal events, partial text, actual configuration, canonical
   recording, sequences, durability precedence and joined cleanup. Streams stay
   cold and refuse on subscription after provider closure.

6. Migrate conversation-only Core test stubs to install the direct service
   inside their genuine provider factory. Preserve their behavior; replace
   obsolete unnamed Agent lookup observations with explicit selected-agent
   observations. Keep real ACP/CLI conversation tests on the production factory,
   constrained Sidekick assembly and disk-backed recovery store. Add the finite
   permanent DP1–DP5 evidence from the plan. Keep original reviewer probes and
   first logs unchanged; the real-ACP regression must refuse missing
   configuration, not merely report that no service was installed.

7. Align specs/acp-client-spec.md, affected Agent/module expectations in
   specs/executable-mdx-spec.md and architecture.md; preserve ordinary middleware
   contracts. Carry only the exact approved architecture rules 23–25 and their
   paragraph plus AGENTS.md Code Rule 15 from the main checkout, as transcribed
   in the plan. Do not overwrite unrelated main edits. P2's Result shape stays.

Local helper names and factoring are yours. Do not split at an intermediate
state where conversation dispatch has moved but configuration, provider or
permission auditing is missing.

## Feedback evidence

Run all six commands from the implementation worktree after the final edit:

```text
deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts

deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts

deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts

deno task test packages/core/tests/agent-function-components.test.ts

deno task test packages/acp/tests/loaded-copy.test.ts

deno test --config ./deno.json --allow-all --filter 'ACP configuration request routing probe' /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configuration-acp-request-routing-ef68c71c.probe.ts
```

DP1 proves the specific missing-configuration refusal under ordinary routing;
DP2 proves complete real-ACP work bypasses agent/session/prompt substitution;
DP3 proves genuine exact finish with a configured-use positive control; DP4
proves direct permission audit and checkpoint/publisher association; DP5 adds
only the missing-service readiness case and retains the existing job/lifetime
coverage. SC1–SC7 remain intact. See the plan for exact observations and fixture
destinations. Reuse the prior SC2 comparison mutation if its code is unchanged;
repeat that control only if you change the comparison. No new permutation or
mutation matrix is assigned.

Preserve first failure output before rerunning. Report environment limitations
separately. Do not wait for full lint/check/JSR, exhaustive runtime suites or CI
before making the feedback commit. Delivery owns those gates.

No settings UI, live updates, new journal format, inspection exchange,
capture(), public completion receipt, permission Context flag, broader
coordinator, global ordinary-session restriction, other API refactor, mounted
section 5, program owner acquisition, terminal packet, push, GitHub mutation or
CI inspection is authorized.

Once the assigned focused evidence passes, commit promptly as one signed
feedback correction. Hand back SHA, parent, branch, signature, clean-tree
status, every command/result, DP1–DP5 and SC1–SC7 mapping, comparison-control
status, and any fixture assertion adaptations. Stop for Architect and Planner
review of that exact commit.

Continuity: base `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`; artifacts are
this prompt and pr2-direct-provider-planner-handoff.md. The architecture is
settled within this scope. P2 remains closed; P1, increment 4 and R2 remain
unaccepted. Next action is this correction and its signed feedback handback.
