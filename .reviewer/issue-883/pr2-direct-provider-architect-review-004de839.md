# Architect review: direct provider correction at 004de839

**PASS** — `004de839e85e53cff4d960cb515729d350383f30`.

P1 is closed architecturally. The configuration increment satisfies the settled
architecture, including the correction for supported middleware changing the
session. P2 remains closed. The
[Planner review](pr2-direct-provider-planner-review-004de839.md) has already
accepted DP1–DP5 and SC1–SC7 at this same SHA. Both required feedback reviews
now pass; recording the resulting increment 4/R2 disposition is the next
coordination step. This is not a declaration that PR 2 is ready to merge.

## Exact revision and contract

- Branch: `agent/issue-883-pr2`.
- Worktree: `.claude/worktrees/issue-883-pr2`.
- Reviewed SHA: `004de839e85e53cff4d960cb515729d350383f30`.
- Parent: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
- Signature independently read as G; signer and author `tarasm@gmail.com`.
- Implementation tree clean before and after reviewer checks.

The 17-file patch was inspected against the
[Architect handoff](pr2-direct-provider-architect-handoff.md),
[frozen Planner assignment](pr2-direct-provider-planner-handoff.md),
[original finding](pr2-configuration-request-routing-architect-return.md) and
[review at the parent](pr2-configuration-result-architect-review-08c95ca2.md).
The [Implementor handback](pr2-direct-provider-implementor-handback.md)
maps the evidence and reports its additional checks and controls.

## Why the correction passes

Core reads `AgentConversationProvider` once in `held`, after claiming the
component identity and before binding conversation history. That object is
passed locally to the jobs. No agent/session/options/prompt dispatch goes
through ordinary Agent middleware on this path. Missing service refuses
readiness without binding the conversation, appending configuration or Prompt
records, completing the root or calling a provider. Generated-root evaluation
keeps its existing mailbox and execution-owned evaluator.

ACP's production factory installs the object for its exact concrete handle and
the coordinator delivered to that factory. The coordinator remains in closures;
the Context and public handles expose no coordinator or history writer. Every
method checks that handle's liveness through the private state lookup. Prompt
does so on subscription and remains cold. The ordinary per-dispatch selector
is unchanged and is not cached across tests. Explicit-agent session and prompt
paths bypass contextual agent dispatch; ordinary entry points retain it.

The before-effects path is:

```text
Core opens original request with its configuration requirement
    |
provider.session(original request, selected agent)
    |
delivered coordinator.sessionSetup(original request)
    |
resolve command and actual construction inputs
    |
setup.activate(provider, command, configuration)
    |
Core saves/acknowledges first configuration, or compares the saved one
    |
only success permits route publication, creation or reattachment
    |
setup.finish -> exact completed Session recorded on private issuance
    |
Core confirms exact result -> shared prompt runner -> direct cold stream
```

Activation and configuration comparison are not replaced or weakened.
Completion evidence is written only after successful settlement, including the
authentic configured-use wrapper. Core checks the exact result before asking
for a stream. An unfinished or substituted Session reaches no prompt. This
check is distinct from activation before native effects and from the unchanged
native-identity checks. Cancellation during configuration settles nothing;
issuance closure, one-use consumption and setup-owner closure retain their
existing behavior.

`runPrompt` remains the one canonical consumer and record builder. Its internal
direct-provider argument supplies the selected agent and exact completed
Session. The extracted audit wrapper is shared with ordinary Agent middleware;
each consumed stream gets one ledger and an exact-stream audit lookup. The
permission observer stays outside policies. Publisher begin/publication,
checkpoint association, actual configuration from the started Session,
sequence allocation, failure recording and stream teardown remain on the
existing path. Turn ownership and cancellation joining are unchanged and their
focused lifecycle/recovery checks pass.

DP1 proves the specific missing-configuration refusal through real ACP with and
without name-forwarding middleware. DP2 proves a complete chat uses its own
nondefault agent and session while rewriting handlers are bypassed. DP3 proves
exact request completion and configured-use identity. DP4 observes permissions
and checkpoint publication through the direct stream. DP5 observes unsupported
provider readiness refusal. The existing configuration, cold-reopen,
model/effort, native identity, cancellation and generated-root checks pass.

## Independent focused evidence

Every command ran from the exact implementation checkout. First output was
captured before any rerun; none failed and none was rerun. This review's logs
are in `/private/tmp/xmd-883-004de839-review.v0M2kR/`.

```text
deno task test packages/core/tests/{agent-session-setup,agent-session-use,agent-session-use-loaded-copy,agent-conversation,agent-components,root-provider}.test.ts
16 passed, 84 steps, 0 failed; exit 0

deno task test packages/acp/tests/{provider,permission-bridge,host-conversation}.test.ts
13 passed, 98 steps, 0 failed; exit 0

deno task test packages/cli/tests/{repl-sidekick-recovery,repl-sidekick-configuration,repl-sidekick-journey,repl-sidekick-lifecycle,repl-history}.test.ts
15 passed, 86 steps, 0 failed; exit 0

deno task test packages/core/tests/agent-function-components.test.ts
11 passed, 63 steps, 0 failed; exit 0

deno task test packages/acp/tests/loaded-copy.test.ts
1 passed, 4 steps, 0 failed; exit 0

deno test --config ./deno.json --allow-all --filter 'ACP configuration request routing probe' /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configuration-acp-request-routing-ef68c71c.probe.ts
1 passed, 2 steps, 0 failed; exit 0

deno task test packages/core/tests/agent-session-launch.test.ts
10 passed, 73 steps, 0 failed; exit 0
```

The six assigned commands total **57 tests / 337 steps**. Including the launch
consumer gives **67 tests / 410 steps**, zero failures. The unchanged real-ACP
probe prints:

```json
{"answered":false,"ensures":0,"turns":[],"configurationRecords":0}
```

Original probes and first logs remain unchanged. The reviewer did not repeat
the Implementor's mutations, 518-test package sweep, typecheck or lint. The
configuration comparison is unchanged, so its prior SC2 control remains
applicable. No exhaustive suite, packaging build or CI inspection was performed.

## Non-blocking reconciliation

Both fixture repairs are appropriate: they add
`activate("stub", "stub-cmd")` before `finish` and propagate a refusal. These
ordinary requests require and save no retained configuration. No assertions
were removed or weakened, and both suites independently pass. The Planner has
already reconciled the launch suite as a known consumer of setup changes.

The handback misdates the missed activation. Git history identifies
**ef68c71c**, the configuration increment, as introducing the refusal
`this session setup has not been activated`. `8fec6316` has no activate member.
The coverage hole is real, but it does not establish that the earlier
identity-recording increment was accepted with these failures. The Planner
review records the same correction. This does not reopen P2 or require another
production change; the reported original failure logs in the Implementor's
scratchpad were not independently inspected.

The rules' numbering gap is acceptable. Rules 23–25 and Code Rule 15 match the
assigned wording. Importing unrelated main rule 22 or renumbering the accepted
references would violate the bounded instruction transfer.

The `/api` import conforms to the accepted package boundary. Core declares
`./api` in both manifests. `scripts/build-npm.ts` derives an entry point for
each export and supplies both root and trailing-slash sibling mappings to npm,
so the existing build mechanism represents this import. Deno and the focused
loaded-copy check pass. Actual JSR/dnt artifacts remain delivery evidence; no
package-path defect is established and no export alias is requested.

## Continuity

P1 is closed at the reviewed SHA, and the configuration increment has
architectural PASS. P2 remains closed. The Planner has accepted the frozen
evidence at this exact SHA. No required architecture correction remains for
this increment. Next: record overall increment 4/R2 disposition and identify
the next already-planned work without reopening these decisions. Mounted
section 5 and terminal work keep their separate assignments.

This review changes main-checkout review records only. No implementation
source, specification, index, commit, push, GitHub state or CI state changed.
