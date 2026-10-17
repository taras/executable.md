# Architect review: required custom-host identity recording

**PASS** — `8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7`.

This reviews #883 PR 2 increment 3 against the accepted
[host-method contract](pr2-session-vocabulary-architect-handoff.md) and
[HR1–HR4 assignment](pr2-session-recording-planner-handoff.md).
The [Implementor handback](pr2-session-recording-implementor-handback.md)
records its implementation and focused evidence.

## Revision and scope

- Branch: `agent/issue-883-pr2`
- Worktree: `.claude/worktrees/issue-883-pr2`
- Reviewed HEAD: `8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7`
- Parent/assigned base: `a49229e983f35764ce59f92f43de37c15473e32f`
- The implementation tree remains clean after review and verification.

The complete six-file patch, provider installation path, all three confirmation
sites, production workflow mapping and relevant tests were inspected. The
architecture changes are covered on top of the prior full reading and accepted
increments. No overlapping dependency or runtime change enters this increment.

## Structural conclusions

- AcpxProviderDependencies.sessions remains optional. AcpxSessionPolicy requires
  both requestSession and recordSessionIdentity. No default host mapping or
  no-op production recorder is introduced.
- checkedSessionPolicy verifies both supplied methods before provider state is
  installed or a session request, attachment or turn begins. Only undefined
  means no host. HR4 proves that a lookup-only host refuses before its lookup,
  runtime construction, ensure or prompt runs.
- The original host object is retained and methods are invoked on it, preserving
  their receiver. Nothing publishes this host through document-replaceable
  context or adds an identity route.
- The three confirmation sites gate on host presence. Reattachment retains
  deferEstablished !== true; native confirmation retains resolved.kind ===
  details. ACP construction still awaits backend acceptance before recording.
  A first turn without acceptance calls no recorder.
- Recording precedes promotion of the usable Session or continued use. Each
  existing refusal body retains its abandon/release, detach where applicable,
  and rethrow/stopped outcome. The provider's confirmed assertion remains
  available for reconciliation; the patch adds no replacement conversation.
- The workflow host is correctly unchanged: it already records and checks the
  association in its existing transaction. Existing mappings are compared,
  not overwritten. Restart and replay keep the same logical/provider identities.
- The two previously lookup-only acceptance fixtures now observe recording of
  their confirmed session keys in order. Their previous routing and identity
  assertions remain intact.
- The added error export and architecture/specification paragraphs describe
  this boundary. Configuration activation, Sidekick mounting and terminal work
  remain outside the increment.

No structural blocker remains.

## Verification

Reviewer independently ran:

```text
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/native-launch.test.ts packages/acp/tests/loaded-copy.test.ts
```

Result: **26 passed, 217 steps, 0 failed**, exit 0.

```text
deno task test packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
```

Final result: **3 passed, 21 steps, 0 failed**, exit 0.

```text
deno task test packages/acp/tests/host-conversation.test.ts packages/acp/tests/acceptance.test.ts
```

Result: **3 passed, 7 steps, 0 failed**, exit 0.

Successful final checks total **32 tests and 245 steps**. HR1–HR4 and the changed
acceptance fixtures are covered. The real loaded-copy bridge also passes.

### First workflow attempt

The first workflow invocation failed because the sandbox could not write npm's
cache under ~/.npm during embedded adapter installation. Its complete
[first output](pr2-session-recording-review-workflow-first-failure.log) was
preserved before another run. WAL12, WSR1 and WSR3 stopped at that installation
boundary; the failure was EPERM/mkdtemp, followed by incomplete-work errors.

The exact command then passed at the identical source revision with escalated
access to the existing cache. No source, dependency manifest, lockfile, vendor
snapshot or worktree preparation was changed to obtain that pass. This was a
different filesystem permission environment, not an intermittent product result.
No full suite or CI was inspected or run.

## Disposition of the reported observations

The host-presence gate need not have a separate mutation regression. Required
members, installation-time rejection, observable recording in the fixtures and
the direct trace of all three call sites establish the accepted boundary.
Reverting only the gate is behaviorally equivalent for a compliant host; no
extra malformed-input matrix is requested.

SM6's title uses established in the old state sense. That title is cosmetic;
its assertion correctly preserves the accepted-then-failed session. It does
not reopen the accepted rename, block this increment or require an additional
production correction. No further naming work is requested in this increment.

## Continuity

Architecture review of increment 3 is complete. Planner reviews HR1–HR4 at this
same SHA and supplies the exact base for increment 4, active provider
configuration. R2 as a whole remains incomplete. Mounted section 5, terminal
R7/R8 and the 36-frame comparison remain separate. No implementation, commit,
push or GitHub publication was performed during review.
