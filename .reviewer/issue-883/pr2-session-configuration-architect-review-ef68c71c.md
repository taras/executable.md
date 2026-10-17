# Architect review: active provider configuration

**PASS** — `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`.

This reviews #883 PR 2 increment 4 against the accepted
[configuration amendment](pr2-recovery-creation-policy-architect-decision.md),
[vocabulary handoff](pr2-session-vocabulary-architect-handoff.md), and
[SC1–SC7 assignment](pr2-session-configuration-planner-handoff.md).
The [Implementor handback](pr2-session-configuration-implementor-handback.md)
records the implementation and its comparison control.

## Revision and scope

- Branch: `agent/issue-883-pr2`
- Worktree: `.claude/worktrees/issue-883-pr2`
- Reviewed HEAD: `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`
- Parent/assigned base: `a66c5d8a5391d43cf8328435bba622a79cc7076b`
- Implementation worktree: clean before and after reviewer verification.

The 28-file patch, affected specifications, private issuance and delivery
bridge, conversation journal and replay, ACP construction inputs, Sidekick
assembly and focused tests were inspected. The architecture delta was read
against the previous complete architecture reading and accepted increments.
The parent is the assigned cast-free fixture correction above accepted
8fec6316; it changes no production boundary. No dependency or generated-artifact
change enters this increment.

## Structural conclusions

- The conversation binds its configuration requirement inside the genuine
  request issuance. Public session middleware gains no reader, replacement
  field or conversation identity. The installed provider receives activation
  through the existing coordinator bridge, with the original receiver kept.
- Activation spends its attempt before suspension. Refusal or cancellation
  cannot authorize finish or retry on the same handle. Issuance and provider
  closure refuse stale use; ordinary setups with no conversation requirement
  still authorize without saving configuration and preserve their existing
  raw or configured Session behavior.
- Core parses into its own recursively detached and frozen JSON. The first
  activation awaits the configuration's durable operation before answering
  successfully. Provider, resolved command and all four configuration values
  are saved. Later activation compares them without appending or replacing
  the saved record. JSON object member order is ignored; array order is kept.
- Reopening reoffers configuration before the retained turns and performs no
  activation or provider work merely to read the chat. The native identity
  assertion remains a separate canonical fact. Configuration does not replace
  that assertion or authorize resending an unacknowledged first turn.
- ACP activates after resolving the command and construction inputs, before
  route construction, reattachment or native creation. A mismatch therefore
  preserves the previous conversation, configuration and identity. Its
  availability preparation remains distinct from native conversation work.
- The production Sidekick assembly uses the command's provider dependencies
  with explicit empty coding-agent tools and MCP servers, strict routing,
  denied permissions and no system-prompt customization. The journey and
  recovery harnesses now install that assembly. Entry and ordinary Session
  behavior retain their own configuration.
- SC2 exercises compatible and incompatible continuation across processes
  against the persistent store. SC6 reads the actual configuration event in
  the held first-turn acknowledgement window. Existing Stop, Elicit,
  model/effort, message correlation and native reconciliation observations
  remain in the focused selection.

No structural finding remains.

## The three handback choices

**Exporting parseJson and JsonParseError is accepted.** ACP reuses Core's
existing JSON validation and copying boundary. These are data utilities; the
export exposes no execution authority or private configuration admission.
ProviderSessionConfiguration remains independent of ACP transport types.

**Detaching MCP servers and new-session options once is accepted.** ACP's
declaration and construction read the same detached inputs. Core separately
copies and freezes what it admits. The nested-mutation observation demonstrates
that edits to the host's original containers alter neither the saved values
nor the construction options.

**Stating no configuration when the provider cannot state all four members is
accepted.** Omitted tool or MCP inputs are not explicit empty lists. A retained
conversation refuses incomplete configuration before native work; an ordinary
setup requires none and saves none. Explicit systemPrompt null states that the
provider's own prompt is kept. No new defaults or partial comparison are added.

These choices conform to the accepted amendment and need no further product
decision.

## Verification

Reviewer independently ran the three frozen commands at the reviewed HEAD:

```text
deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts
```

Result: **15 passed, 79 steps, 0 failed**, exit 0.

```text
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts
```

Result: **12 passed, 96 steps, 0 failed**, exit 0.

```text
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts
```

Result: **15 passed, 86 steps, 0 failed**, exit 0.

Total: **42 tests, 261 steps, zero failures**. No rerun or source modification
was needed. The handback's comparison-bypass control and check/format results
are Implementor evidence, not reviewer reruns. No full suite or CI was inspected
or run.

## Continuity

Architecture review of increment 4 is complete. Planner reviews the frozen
SC1–SC7 evidence at this exact SHA and reconciles the remaining R2 assignment.
This verdict does not declare R2 or PR 2 complete. Mounted section 5 owner
acquisition, terminal R7/R8 and the 36-frame comparison remain separate.
No production change, implementation commit, push or GitHub publication was
performed during this review.
