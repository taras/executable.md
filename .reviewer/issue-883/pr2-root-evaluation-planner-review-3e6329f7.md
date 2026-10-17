# Planner review: bound root evaluation at 3e6329f7

REQUEST CHANGES at `3e6329f78551978b05542d2bd9e808ee34e8f5f9`, parent
`ddf3f6f967787316a9bb842d8271ece7ef5bfc62`, branch `agent/issue-883-pr2`.
Review against the accepted [architecture](root-evaluation-architect-handoff.md)
and [E1–E9](root-evaluation-planner-handoff.md#frozen-focused-evidence).

Two of the previous review's three findings are closed. The failure-authority
finding is partly corrected: durability and Files failures survive reconciliation,
but an authoritative evaluation teardown failure still loses to an ordinary
main failure. Keep the admission gate paused for this one correction.

## Closed findings

Invocation closure now follows the canonical invocation through attend(),
including an ending before activation. The activated runner retains its own
later closure after worker cleanup joins. E1d and the archived early-refusal
case pass, alongside the post-activation control.

History read/address allocation now runs inside attempt() and its answer/join
protocol. E7e and the archived read-failure case raise the original error.
The address advances only after a successful read.

The retained evaluation failure reaches every invocation settlement, including
cancellation. Conversation release reports its retained failure after its jobs
join. E7d and strengthened CV32 pass, and all five archived owner-probe steps
pass. The two scope/evidence rulings in the prior review remain accepted.

## Remaining finding: reconciliation drops an evaluation teardown failure

Priority P1; existing E7 and previous finding 2. In
`packages/core/src/execute.ts:3515`, reconcile() returns a failed document before
consulting evaluation at line 3521. Its earlier classification branches handle
durability and Files infrastructure, but an InvocationTeardownError falls
through both. A later ordinary document error therefore replaces the exact
authoritative failure the root method raised.

The [focused ranking probe](pr2-root-ranking-3e6329f7.probe.ts) combines E7c's
real failing evaluation cleanup with E7d's held main document that subsequently
fails ordinarily. The caller receives `InvocationTeardownError: evaluation
cleanup failed`; canonical completion instead returns `Error: later ordinary
main failure`. Its successful-main control returns the evaluation error by
identity and passes. The [first failure log](pr2-root-ranking-3e6329f7.probe.log)
records both outcomes.

This is the existing authority criterion, not an added product journey. A
non-durability evaluation failure classified as authoritative by Core must not
be discarded merely because main failed too. The correction's own documented
ordering says that within a kind the evaluation precedes the document and then
teardown; the fallback branches implement the reverse precedence for evaluation.
Preserve durability-first and Files-second classification, then retain the
earlier authoritative evaluation error by identity before later ordinary
document/teardown failures. Keep the existing document-versus-teardown behavior
when there is no evaluation failure. Do not alter settleCompletion's rule that
host policies are not called after evaluation policy has already failed it.

## Focused evidence

All commands ran in `.claude/worktrees/issue-883-pr2` at the exact reviewed SHA.
No CI state was inspected. The amendment's two regression rows were combined
without changing their selection.

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/execution-protocol.test.ts packages/core/tests/document-output-api.test.ts packages/core/tests/syntax-component.test.ts
deno task test packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-placement.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/acp/tests/host-conversation.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-bound.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-syntax-documentation-bound.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-documentation-capture-bound.probe.ts
deno task validate:docs
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-root-owner-ddf3f6f9.probe.ts
```

Results respectively: 28 tests/126 steps; 39/392; 5/38; 13/69; 3/7;
documentation complete across one profile; 1/5. Total passing evidence:
89 tests, 637 steps, zero failures.

The additional command below fails one step; its control passes:

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-root-ranking-3e6329f7.probe.ts
```

## Ready-to-send correction prompt

Correct only the remaining E7 failure-ranking defect at
`3e6329f78551978b05542d2bd9e808ee34e8f5f9`. Keep durability-first and
Files-second ranking, then reconcile an authoritative evaluation failure ahead
of later ordinary main/teardown failures, preserving the original error object.
Preserve document-versus-teardown precedence when no evaluation failed, all
three invocation settlements, conversation release reporting, and the existing
host completion-policy invocation rules.

Make both steps of pr2-root-ranking-3e6329f7.probe.ts pass and integrate this
teardown/main-failure regression and its successful-main control into the
permanent host evidence. Keep the archived owner probe's five steps green and
the amendment's selected regressions unchanged. No additional mutation-control
exercise or broad suite is required. Run the focused commands, commit promptly
when they pass, and return the exact SHA/parent and commands/results.

Preserve untracked gate.ts unchanged and outside this correction. Do not resume
the admission gate before Planner acceptance. No new interface, architecture
interview, third PR, memory restructuring, push or GitHub write is required or
authorized by this review.

## Continuity

Reviewed SHA and parent are recorded above. Produced this review, the ranking
probe and its first failure log; updated both plan status/continuity records.
No production code changed. The implementation worktree still has only
untracked `packages/cli/src/repl/sidekick/gate.ts`, SHA-256
`e9c8ab8192df6fc339ce8061a3cd6fda4def289f2ebd41cce63750fe54b0207c`.
No new product or architecture decision remains. The next action is the single
correction above; full CLI acceptance and delivery verification remain separate.
