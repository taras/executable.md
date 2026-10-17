# Architect review: Result correction at 08c95ca2

**P2 PASS** — `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
**Increment 4 remains REQUEST CHANGES for P1.**

The [P2 assignment](pr2-configuration-implementor-correction-ef68c71c.md)
is satisfied. The separate supported-routing violation in the
[Architect return](pr2-configuration-request-routing-architect-return.md)
remains present. My earlier overall architectural PASS at ef68c71c missed that
supported path and is superseded by this disposition. Its normal-path evidence
and acceptance of the three reported implementation choices remain applicable.

## Reviewed revision

- Branch: `agent/issue-883-pr2`
- Worktree: `.claude/worktrees/issue-883-pr2`
- HEAD: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`
- Parent: `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`
- Two source files; 28 insertions, 25 deletions. Implementation tree clean.

The complete correction was inspected against its parent. No architecture or
specification text changes in this correction. The previously read architecture
and affected configuration contracts remain the review boundary.

## P2 is closed

parseProviderConfiguration returns Effection Result<JsonObject>. The local
ParsedProviderConfiguration union is removed. Successful parsing still copies
and freezes the JSON before returning Ok. Each refusal uses the private
ProviderConfigurationUnstated Error; its text is unchanged. The conversation
reads parsed.error.message and keeps its existing AgentConversationError.
This is a distinct contextual refusal, not a redundant rebuilding of Err.

The deleted type was not part of Core's public module exports or a specification
contract. No journal value, record name, comparison, routing, activation or
lifetime changes. P2 introduces no structural finding.

Reviewer independently ran:

```text
./node_modules/.bin/oxlint -c .oxlintrc.json packages/core/src/agent/provider-configuration.ts
```

Exit 0. The local/prefer-effection-result error is gone. The two existing
unicorn/no-array-sort warnings remain and are outside this correction.

```text
deno task test packages/core/tests/agent-conversation.test.ts
```

**9 tests, 37 steps, zero failures**, exit 0. This includes SC3's specific
missing-configuration refusal and its no-record/no-prompt assertions.
The Implementor's three-command result of 42 tests/261 steps is recorded in
the [handback](pr2-configuration-result-implementor-handback.md); it was not
independently repeated for this two-file correction. No full suite or CI was
run or inspected.

## P1 remains a structural blocker

Reviewer independently reran the unchanged, checked real-ACP probe at this HEAD:

```text
deno test --config ./deno.json --allow-all --filter 'ACP configuration request routing probe' /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configuration-acp-request-routing-ef68c71c.probe.ts
```

The unchanged-request control passes. The name-forwarding regression fails,
exit 1, with the same observed result:

```json
{"answered":true,"ensures":1,"turns":["first"],"configurationRecords":0}
```

The [complete first output at this HEAD](pr2-configuration-review-08c95ca2-acp-routing-first.log)
is preserved. The original return's probes and outputs are unchanged.

This uses the supported Agent.session middleware route, actual ACP provider,
real Core conversation and existing scripted transport. Forwarding the name
drops the issuance that carries admission. ACP's session handler ignores its
continuation and calls openSession directly. resolveSession obtains a setup
only for a request object, so the string path skips activation. Core then
prompts on the returned Session without a configuration record.

That violates the accepted requirement to save configuration before creation
and compare it before reattachment. Native work and a turn occur without that
mandatory check. The correction belongs to this increment, which introduces
the activation requirement. A check after session resolution cannot prevent
eager native reattachment.

The existing private provider-installation terminal delivers a coordinator at
installation time; it does not guard each session resolution. The launch
coordinator's existing sessionSetup reads an exact request; it cannot recover
the owned conversation requirement from a string. No existing before-effects
guard was established by this review. A new provider/Core handshake or changed
routing boundary needs the Architect's design and, if its ownership or public
contract changes, the Product Owner boundary interview. No such change is
approved here.

## Next Architect prompt

Resolve P1 on branch agent/issue-883-pr2 at
08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd; P2 is closed and must not be
reopened. Read the configuration decision, Planner handoff and request-routing
Architect return linked above. The checked real-ACP probe has a green
unchanged-request refusal control and a failing name-forwarding regression:
one ensure, one turn and zero configuration records. Preserve the probes and
their first outputs.

Identify the earliest Core-owned enforcement seam that preserves mandatory
configuration through supported routing before native creation, ensure,
reattachment or prompting. Trace the exact before-effects path. Preserve
descriptive-name derivation, ordinary sessions outside retained conversation
work, options inspection, model/effort handling, native assertions, one-attempt
activation and joined cancellation. Do not use replaceable Context state,
a public retained-session flag, a CLI forwarding promise or a post-effects
check. Do not implement a new authority channel or broaden the coordinator
without resolving that boundary with the Product Owner.

Prepare the smallest concrete design, inventory the affected provider/Core
members and use the system-boundary interview if a new contract or ownership
seam is necessary. Record the accepted decision and Planner handoff at
pr2-configuration-request-routing-architect-decision.md before implementation
is assigned. Keep the one unchanged-request control and one real-ACP routing
regression; add no speculative permutation matrix.

R2 remains incomplete. No mounted section 5, terminal packet, production edit,
implementation commit, push, GitHub mutation or CI inspection opens. This review
changed only review records in the main checkout.
