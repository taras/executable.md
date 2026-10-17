# Implementor handoff: require custom hosts to record confirmed session identity

**PASS, 2026-10-13:** accepted at
`a66c5d8a5391d43cf8328435bba622a79cc7076b`, parent 8fec6316.
[Planner review](pr2-recording-planner-review-a66c5d8a.md) closes the cast-free
HR4 correction and accepts increment 3. Its focused file independently passes
9 tests/82 steps; earlier unchanged boundary evidence is recorded separately.
This assignment is closed. Active provider configuration starts on a66c5d8a.

A supplied custom session host must save the identity the provider confirmed.
The integration remains optional; an ordinary directory-based session continues
without a second host mapping.

## Starting point and accepted interface

This is increment 3, after Planner acceptance of the
[rename](pr2-session-rename-implementor-handoff.md) and
[REPL validation API](pr2-repl-validation-planner-handoff.md).
Starting SHA: `a49229e983f35764ce59f92f43de37c15473e32f`, parent
`135063e67ff4b39be0bba8ddbace08439969aeb8`, on agent/issue-883-pr2.
[The validation review](pr2-validation-planner-review-a49229e9.md) is PASS;
the intervening ACP specification correction is accounted for there.
Start from this exact revision, with a clean implementation worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Record that exact SHA. Do not combine this behavior change with the rename.

Authority:
[the Architect handoff](pr2-session-vocabulary-architect-handoff.md) and
[accepted host-method decision](pr2-session-vocabulary-architect-decision.md).

```ts
export interface AcpxSessionPolicy {
  requestSession(request: AcpxSessionRequest): Operation<AcpxSessionDetails>;
  recordSessionIdentity(
    details: AcpxSessionDetails,
    identity: AcpxSessionIdentity,
  ): Operation<void>;
}
```

AcpxProviderDependencies.sessions remains optional. When supplied, both methods
are required. Do not introduce no-op production recording, a default host
database or a conversation reconstruction path to satisfy the type.

## Implementation

1. In packages/acp/src/provider.ts make recordSessionIdentity required. Validate
   a supplied custom host before work can proceed; a structurally malformed
   host missing this method refuses instead of falling through as though no
   custom host had been supplied.
2. At the three existing identity-confirmation sites, gate on host presence,
   not optional method presence. Preserve the sites' order: confirmed ACP
   first-turn acceptance or existing-session reattachment, then host recording,
   then continued use. Native creation keeps its existing assertion point.
   No confirmation means no recording.
3. Preserve refusal cleanup. A host recording failure abandons/releases the
   provider handle under existing ownership and prevents further use through
   that association. Recording validates an existing association rather than
   overwriting it. Do not change the Session or store identity on refusal.
4. Update packages/cli/src/workflow-agent.ts and all custom-host test fixtures
   to implement the required method. The production workflow host already
   supplies the existing recording body; rename-only work preserved it.
   Routing-only test hosts now explicitly record/observe confirmed identities
   in their fixture rather than silently omitting the responsibility.
5. Update the host-integration interface and confirmation/refusal contract in
   specs/acp-client-spec.md, architecture.md and affected module rosters.
   This changes requiredness, not the optional presence of the integration.

## Frozen evidence

| Row | Required observation |
| --- | --- |
| HR1 — confirmed creation and reopen | A supplied real custom host receives the exact session details and provider-confirmed identity after accepted creation; reopening/reattachment validates and records that same identity before another turn. Retain existing mapping/native assertions and fixed logical-session identity. |
| HR2 — no confirmation | A first ACP turn without creation acceptance calls no recording method. Keep the existing failed-before-acceptance case. A turn accepted before later failure retains the confirmed identity under the existing rule. |
| HR3 — refusal cleanup | The existing host refusal releases/abandons the provider handle and prevents further use through the refused association, preserving the provider assertion. Keep the existing reattachment/reconciliation control. Native confirmation exercises the same required method at its existing call site. |
| HR4 — malformed and absent | A supplied host missing recordSessionIdentity refuses before creation/reattachment/new turn; it is not treated as absent. The existing ordinary no-custom-host path still creates/continues a directory-based session without a host database. |

Use the existing ACP provider and native-launch fixtures and workflow session
integration. Most observations already exist under their renamed methods.
Add one malformed-host regression paired with the ordinary absent-host control;
do not build a new storage or crash matrix. Keep recorded identity ordering
observable, not merely "the request returned Err."

Run:

```text
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/native-launch.test.ts packages/acp/tests/loaded-copy.test.ts
deno task test packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
```

These cover the three provider confirmation sites, the actual provider/host
boundary, optional ordinary path and production custom workflow mapping.
No exhaustive runtime pass, check, check:jsr, lint or CI prerequisite is added.

Commit promptly when HR1–HR4 and both commands pass. Return exact signed SHA,
parent/branch/tree status, commands/results, the affected host fixtures and
their preserved assertions. Preserve first failure output. Stop for Planner
review; configuration starts only on this increment's accepted SHA.

Produced artifact: this file. Architecture and requiredness are settled.
Actual base is a49229e983f35764ce59f92f43de37c15473e32f.
Next Implementor action: implement steps 1–5 and return this feedback
commit. Configuration, owner acquisition in program.ts, mounted section 5,
terminal R7/R8, the 36-frame packet, push, GitHub mutation and CI inspection are
not part of this increment.
