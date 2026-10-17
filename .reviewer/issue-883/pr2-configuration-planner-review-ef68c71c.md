# Planner review: active provider configuration at ef68c71c

**REQUEST CHANGES.** The focused commands pass, but retained conversation
configuration can be bypassed through supported session routing. The previously
reported Result-union violation also remains in the signed commit.

Reviewed SHA: `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`.
Parent: `a66c5d8a5391d43cf8328435bba622a79cc7076b`.
Branch: agent/issue-883-pr2. Signature: G, tarasm@gmail.com.
Worktree verified clean; 28 files, 1814 insertions and 56 deletions.
Signing is no longer a blocker.

Authority:
[configuration handoff](pr2-session-configuration-planner-handoff.md),
[accepted decision](pr2-recovery-creation-policy-architect-decision.md) and
[Implementor handback](pr2-session-configuration-implementor-handback.md).

## P1 — supported routing waives mandatory activation

The decision requires Core to save active provider configuration before native
creation, compare it before reattachment, and prevent a replaceable contextual
value from waiving the check. SC3 requires omitted configuration to refuse
before native work.

An installed Agent.session middleware handler forwards the opaque request's
name to next. This is supported by specs/acp-client-spec.md: replacing a request
with a raw string selects the ordinary unconfigured route. Through that route,
ACP resolveSession obtains no setup, skips activate and returns a Session.
conversationTurn closes its original issuance but requires no activation
acknowledgement before sending the prompt.

The checked real-ACP probe observes:

```json
{"answered":true,"ensures":1,"turns":["first"],"configurationRecords":0}
```

Its unchanged-request control refuses for the expected missing-configuration
reason and performs zero ensures. Both arms use the real Core conversation
and actual ACP provider; only the agent transport is scripted. A separate
Core probe demonstrates the same ownership gap without ACP.

This is an existing structural invariant, not a new configuration permutation:
the same supported conversation can create native state and run a turn without
saving its required configuration. It belongs in this amendment because
activate and private conversation issuance are the mechanism being introduced.

[Architect return with exact trace and probes](pr2-configuration-request-routing-architect-return.md).

A private enforcement point must preserve this requirement through supported
routing before any native create/reattach/ensure or prompt. Checking only the
Session returned to Core is too late for eager reattachment. The Architect
must reconcile the ordinary unconfigured routing contract and mandatory
conversation configuration, identify an existing before-effects mechanism or
interview the user on a necessary boundary amendment. The Implementor is not
assigned an invented authority channel or blanket ban on ordinary sessions.

## P2 — pre-commit Result correction is absent

packages/core/src/agent/provider-configuration.ts:62 still declares the local
ParsedProviderConfiguration ok:true/false union and carries failure data as a
string reason. AGENTS.md Code Rule 13 requires Effection Result<T> and Error
failure data. The targeted lint command independently exits 1 with
local/prefer-effection-result.

[Exact-commit lint output](pr2-configuration-review-ef68c71c-result-lint-first.log).

The earlier pre-commit prompt identified this same source violation; the
committed tree did not include its correction. Use Result<JsonObject> and
preserve the current caller's diagnostic/classification and journal behavior.
The two sort warnings are not additional blockers.

[Implementor correction](pr2-configuration-implementor-correction-ef68c71c.md)
allows this independent correction now while the routing boundary returns to
the Architect.

## Focused evidence

All three assigned commands independently pass at this exact SHA:

```text
deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts
```

| Selection | Result | First output |
| --- | --- | --- |
| Core | 15 tests, 79 steps, 0 failed | [Core log](pr2-configuration-review-ef68c71c-core-first.log) |
| ACP | 12 tests, 96 steps, 0 failed | [ACP log](pr2-configuration-review-ef68c71c-acp-first.log) |
| CLI | 15 tests, 86 steps, 0 failed | [CLI log](pr2-configuration-review-ef68c71c-cli-first.log) |

Total: 42 tests/261 steps, zero failures. These establish the normal activation
path, compatible/incompatible comparison, snapshots, ordinary setup behavior,
lifetime, delivery bridge and R2m2 interruption. They do not cover a routed
request that loses its activation requirement.

The targeted command:

```text
./node_modules/.bin/oxlint -c .oxlintrc.json packages/core/src/agent/provider-configuration.ts
```

fails for P2. No full lint, compiler/JSR, exhaustive corpus or CI was added.

The two isolated routing probes each have one green control and one failing
regression. First outputs are preserved. Checked verification uses the exact
worktree deno.json and asserts the control's specific configuration refusal:
[Core verification](pr2-configuration-review-ef68c71c-routing-verified.log),
[ACP verification](pr2-configuration-review-ef68c71c-acp-routing-verified.log).
The Architect return carries the exact commands, supported surface and source
trace. No production/index mutation was used for either probe.

## Flagged implementation choices

No objection to sharing Core's existing parseJson/JsonParseError through its
module surface: these are the existing pure data-normalization function and
failure type, with no new execution authority. The ACP provider need not
duplicate the parser.

The detach-once structuredClone of MCP and creation options is consistent with
SC1's stable construction-input requirement. Returning no declaration when
required inputs are unknown correctly distinguishes omission from explicit
empty values. Those choices are not the routing bypass and need no redesign
for P2.

The reported sameJson comparison mutation remains useful for SC2's normal
path. It was not independently repeated and cannot prove activation occurs
when routing chooses an ordinary string.

## Continuity and next action

Latest accepted head remains a66c5d8a. Increment 4 and R2 remain incomplete.
The Implementor may close P2 with its bounded correction and focused evidence.
P1 returns to the Architect before its implementation is assigned; a new public
flag, broader accessor or post-effects check is not approved.

Preserve the accepted rename, validation, recording, admission/Pause, Stop,
Elicit, feedback, message association and native assertion behavior. No owner
acquisition, mounted section 5, terminal R7/R8, 36-frame packet, push, GitHub
mutation or CI inspection opens.
