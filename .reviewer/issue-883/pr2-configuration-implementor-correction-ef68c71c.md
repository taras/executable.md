# Implementor correction at ef68c71c: Result rule; retain the routing finding

**P2 closed:** accepted at signed `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`
under [the correction review](pr2-configuration-p2-planner-review-08c95ca2.md).
P1 remains with the Architect. The assignment below is the completed P2 scope.

Continue from signed `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`, parent
a66c5d8a, on agent/issue-883-pr2 in the existing implementation worktree.
The signing interruption is over; no amend or unsigned commit is requested.

## Independent correction now assigned

The pre-commit Result correction did not land. At this exact commit,
provider-configuration.ts still declares ParsedProviderConfiguration as a local
ok:true/false union with a string reason. AGENTS.md Code Rule 13 forbids that
shape and requires Effection Result<T> with failure data on an Error.

Use Result<JsonObject> for parseProviderConfiguration and preserve its
parse/copy/freeze semantics. Update the consumer to read the error message
while keeping the existing AgentConversationError reason and classification.
Remove the redundant union; do not rename the discriminant to bypass the rule.
Preserve all configuration values, journal records, comparison and lifecycle.

Run the three original focused commands in
[the configuration handoff](pr2-session-configuration-planner-handoff.md),
then this targeted check:

```text
./node_modules/.bin/oxlint -c .oxlintrc.json packages/core/src/agent/provider-configuration.ts
```

The targeted check currently exits 1 with local/prefer-effection-result at
line 62. Its [exact-commit output](pr2-configuration-review-ef68c71c-result-lint-first.log)
is preserved. The two sort warnings are not additional acceptance blockers.
No full lint/check/JSR/suite is assigned.

Commit the independent Result correction promptly once its evidence passes,
return its exact signed SHA/parent/branch/tree status and commands/results,
and state that the separate routing finding remains pending. Preserve first
failure output. Do not amend the reported ef68c71c revision.

## Routing finding awaits architecture

[The Architect return](pr2-configuration-request-routing-architect-return.md)
reproduces a public Agent.session handler forwarding a retained request's name.
It bypasses setup.activate and lets the real ACP provider ensure a session and
send a turn without saving configuration.

Do not implement an invented authority channel, public flag, broader
coordinator accessor, global ordinary-session restriction or post-reattachment
check as its fix. Wait for the Architect disposition and Planner correction
assignment for that boundary. Keep the probes and their first outputs unchanged.

The three choices flagged in the handback need no redesign: reuse of the
existing Core parser/error, one detached construction snapshot, and refusal
when required inputs cannot be stated. Existing sameJson comparison evidence
remains applicable if its code is unchanged.

The Result correction may proceed independently; increment 4 and R2 cannot be
declared complete until both findings are closed. No owner acquisition,
mounted section 5, terminal packet, push, GitHub mutation or CI inspection opens.
