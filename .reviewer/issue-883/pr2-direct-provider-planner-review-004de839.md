# Planner review: direct provider correction at 004de839

**Coordination complete:** the separate Architect review also passes at this
SHA. [The reconciliation](pr2-r2-completion-reconciliation-004de839.md) records
increment 4 accepted, P1/P2 closed and R2 complete. The review below preserves
the evidence and sequence at the time of Planner acceptance.

**PASS.** The correction satisfies DP1–DP5 and preserves SC1–SC7 at
`004de839e85e53cff4d960cb515729d350383f30`. P1 is closed for Planner review;
P2 remains closed. The separate exact-commit Architect review requested by the
assignment is the next review, before recording overall increment 4/R2 closure.
No new implementation or delivery work is assigned here.

## Reviewed revision and authority

- Branch: agent/issue-883-pr2.
- Worktree: `.claude/worktrees/issue-883-pr2`.
- SHA: `004de839e85e53cff4d960cb515729d350383f30`.
- Parent: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
- Signature independently verified: G, tarasm@gmail.com.
- Tree independently verified clean; 17 files, 1224 insertions, 175 deletions,
  one new source file. No implementation edit was made during this review.

Reviewed against [the frozen Planner assignment](pr2-direct-provider-planner-handoff.md)
and [Architect handoff](pr2-direct-provider-architect-handoff.md), with
[the Implementor handback](pr2-direct-provider-implementor-handback.md).

## Implementation and evidence

AgentConversationProvider has the four accepted methods, one stable Context
key and one consumer-facing export from Core /api. createAcpxProvider installs
it for its concrete state and delivered coordinator. Each method uses the
private live-state lookup; prompt defers lookup and work until subscription.
The ordinary partition selector remains per-dispatch and supplies no fixed
conversation service.

held() reads the service once, before bind and readiness, and passes it as a
local to the jobs. No Agent agent/session/options/prompt dispatch remains on
the conversation path. Missing service follows the existing readiness and
resource-release protocol without completing the durable root. Model/effort,
native identity checks and generated-root evaluation retain their behavior.

Private issuance records the exact result after successful finish, including
the configured use. conversationTurn checks identity against that result before
prompting and closes the issuance in finally. Activation still guards provider
effects first; completion evidence is not substituted for activation.

runPrompt remains the shared canonical consumer. The extracted internal
auditedPromptStream supplies the direct stream's audit once and is also used by
ordinary middleware. Permission observation stays outside policies, with the
same exact-stream lookup, publisher, checkpoint and journal implementation.

| Row | Acceptance evidence inspected |
| --- | --- |
| DP1 | Permanent real-ACP two-arm case refuses specifically for missing configuration, with zero ensures, turns and configuration records; it excludes the unsupported-service error. The original unchanged probe independently gives the same refusal. |
| DP2 | Complete real-ACP chat under a nondefault agent bypasses the installed agent/session/prompt rewriting handlers, retains its own native identity/session key and configuration, and answers. The prior SC1 ordering assertion remains green on the same production activation path. |
| DP3 | Both unfinished-session and finish-then-substitute cases refuse before any prompt; the successful control passes the exact finished configured use and retains its verified model/effort. |
| DP4 | A direct saved-conversation turn retains both decided permission requests exactly once with their safe fields in arrival order. Its real delivered coordinator supplies the terminal checkpoint; publication carries that checkpoint/session key and the same begun handle, and appends once. Existing AF audit/publisher rows preserve the ordinary path. |
| DP5 | Ordinary-middleware-only provider refuses readiness, reaches no ordinary dispatch or prompt and writes no conversation records/root terminal. Existing cold-open, replay, options, Stop/join and root-evaluation rows pass. Source trace establishes one read and concrete-state liveness without a Context replacement matrix. |

SC1–SC7 remain satisfied in the assigned files, including separate-process
compatible/incompatible reopen, missing configuration, setup lifetime,
receiver-bound delivery, R2m2's assertion window and retained consumers. The
configuration comparison is unchanged; its previously recorded discriminating
control remains applicable. P2's parser was not changed.

The five new mutation controls are reported in the handback and were not
independently repeated. They are supplementary evidence; the inspected source,
permanent scenarios and independently rerun commands establish this verdict.
The original probes and first outputs were not edited during this review.

## Independent focused commands

All six assigned commands pass at the exact reviewed SHA:

```text
deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts
deno task test packages/core/tests/agent-function-components.test.ts
deno task test packages/acp/tests/loaded-copy.test.ts
deno test --config ./deno.json --allow-all --filter 'ACP configuration request routing probe' /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configuration-acp-request-routing-ef68c71c.probe.ts
```

| Selection | Result | First output |
| --- | --- | --- |
| Core | 16 tests, 84 steps, 0 failed | [Core](pr2-direct-provider-review-004de839-core-first.log) |
| ACP | 13 tests, 98 steps, 0 failed | [ACP](pr2-direct-provider-review-004de839-acp-first.log) |
| CLI Sidekick | 15 tests, 86 steps, 0 failed | [CLI](pr2-direct-provider-review-004de839-cli-first.log) |
| AF | 11 tests, 63 steps, 0 failed | [AF](pr2-direct-provider-review-004de839-af-first.log) |
| ACP loaded copy | 1 test, 4 steps, 0 failed | [Loaded copy](pr2-direct-provider-review-004de839-loaded-first.log) |
| Unchanged probe | 1 test, 2 steps, 0 failed | [Probe](pr2-direct-provider-review-004de839-probe-first.log) |

Total: **57 tests, 337 steps, zero failures**. The unchanged probe prints:

```json
{"answered":false,"ensures":0,"turns":[],"configurationRecords":0}
```

The newly identified fixture consumer was also independently verified:

```text
deno task test packages/core/tests/agent-session-launch.test.ts
```

10 tests, 73 steps, zero failures; [launch output](pr2-direct-provider-review-004de839-launch-first.log).
Combined independent evidence: 67 tests, 410 steps. No environment limitation
occurred. The reported whole-package sweep, check, lint and formatting results
were not independently repeated; no full suite or CI was added to this review.

## Fixture repairs and selection reconciliation

Accept both mechanical stub repairs. AF and session-launch now call activate
with omitted configuration on their ordinary requests before finish, propagating
any refusal. Their assertions are unchanged, and ordinary activation saves no
conversation configuration.

The omission of session-launch from the earlier setup selection is a concrete
consumer gap. Include that file in future focused selections when changing the
setup activation/finish contract; AF is already assigned for shared prompt
changes. No broader automatic suite expansion follows from this observation.

Historical clarification: git history places the activation requirement in
ef68c71c, not the required identity-recording increment 8fec6316. The two stubs
predate that requirement. The handback's description of two accepted increments
carrying this failure is therefore inaccurate: configuration remained under
REQUEST CHANGES. This does not affect the repair or verdict. The Implementor
reports its first failure logs preserved in scratch; those logs were not
independently inspected here.

## Reported documentation and packaging points

The rule-number gap is accepted: the assignment explicitly limited transfer to
23–25 and the approved Code Rule 15 wording. Importing unrelated main rule 22
or renumbering the approved rules is not part of this correction.

The ACP import from @executablemd/core/api is the approved consumer-facing
surface, and the assigned Deno checks exercise it. No feedback packaging build
was assigned. JSR/npm and other required delivery checks remain delivery work;
this is not a claim that those checks have run.

Affected specs and architecture text describe the fixed provider, private
completion and shared audit while preserving ordinary middleware behavior.
No new settings, journal convention or ordinary-session restriction appears.

## Continuity

Planner acceptance: DP1–DP5 and SC1–SC7 at exact SHA 004de839. P2 stays closed.
Next: Architect review of this exact signed commit, as the correction assignment
requires, then record the resulting increment 4/R2 disposition. The Implementor
holds at the clean head. This Planner PASS opens no mounted section 5, owner
acquisition, terminal packet, push, GitHub mutation or CI inspection.
