# Planner review: bound root evaluation at ddf3f6f9

REQUEST CHANGES at `ddf3f6f967787316a9bb842d8271ece7ef5bfc62`, parent
`8be2d2bc3c38c4a896d0b678e121beef28e02920`, branch
`agent/issue-883-pr2`. Review against
[the accepted Architect contract](root-evaluation-architect-handoff.md) and
[E1–E9](root-evaluation-planner-handoff.md#frozen-focused-evidence).

The bound interface, execution-minted Syntax routing, captured package
documentation and separate evaluation sequences are implemented. The supplied
focused evidence passes. Three owner-lifecycle/failure defects still violate
E1/E7. Keep the admission gate paused until the correction is accepted.

## Findings

### 1. Close the evaluator even when its runner never activates

Priority P1. In `packages/core/src/generated-root-owner.ts:343`, activate()
registers the only cleanup that marks the evaluator closed and settles readiness.
The owner is created earlier, in `execute.ts:2577`. A document can finish without
reaching activation: Execution.document can refuse before delegation, root
import can fail, or a completed document can replay without entering the body.
There is then no closure registration for the bound operation that already
escaped on the host handle.

Reproducer: install an Execution.document handler that throws before delegating,
obtain HostExecution, await its failed canonical completion, then invoke its
root method. The call waits on ready.operation indefinitely. The probe's
one-second failure watchdog fires. The control with a document that activated
and then completed refuses immediately as expected.

Make admission/readiness closure follow the entire canonical invocation,
including failure, replay and cancellation before activation. Preserve the
separate guarantee that an activated runner closes only after its work and
cleanup join. Closing a handle must not require first activating its runner.

### 2. A fatal evaluation is authoritative only on one completion path

Priority P1. `packages/core/src/execute.ts:3019` returns the main document's own
failure without consulting roots.completion. The evaluation completion policy
is consulted only for a successful main result at line 3028. Cancellation at
runInvocation's teardown, line 3320, also has no retained evaluation failure to
reconcile when the document has not returned. The conversation's synthetic
document normally ends through exactly that cancellation path.

Two cases reproduce the loss:

- Hold the main document, fail an evaluation admission append, catch its
  DurablePersistenceError, restore the writer, and release the main document
  into an ordinary failing component. Main completion returns the later
  ordinary error. Its durability failure is undefined, despite the fatal
  evaluation still belonging to this execution.
- Open a real conversation, fail the evaluation admission append, catch the
  original persistence failure and release the resource. The surrounding
  scope exits successfully. CV32 checks only the error from the call; its
  fromConversation slot is never asserted, so it does not cover this loss.

Carry authoritative evaluation failure through every invocation settlement and
teardown path. Reconcile it with the main result and teardown using canonical
failure ranking and identity, rather than applying it only as an additive
failure of success. A caught evaluation failure must not disappear when the
conversation's never-completed document is halted. Preserve halted histories;
do not invent a terminal to make cleanup report failure.

### 3. Failure while reading the first evaluation's history becomes availability

Priority P1. At `packages/core/src/generated-root-owner.ts:373`, the first
journal read and next-address allocation happen outside perform()/attempt(),
before the job has their answer and join lifecycle. If the read throws, the
worker closes the owner without forwarding that failure to the waiting job.
The caller's closed race then returns Err(HostExecutionError), describing an
interrupted execution instead of raising the original authoritative failure.

Reproducer: after a genuine held host is ready, make its journal's next read
throw a specific DurablePersistenceError, then explicitly evaluate. Main
completion fails, but the method returns a Result rather than raising that
same error. This is a different path from E7b's append failure, which passes.

Include history-read/address-allocation failure in the admitted job's owned
settlement and join protocol. Forward the actual failure before reporting
ordinary closure, and retain it for execution completion. The wrapper must
not turn a journal failure into a correctable response or availability error.

## Rulings requested in the handback

**Context ceiling: accepted evidence adjustment.** Bound root evaluations and
document fragments have separate continuations. GR12–GR14 now establish that
neither consumes the other's retained admission and that new explicit work
does not resume a response suffix. The old public-call scenario that resumed a
root admission as a fragment no longer exists. Do not restore a siteless path
just to reproduce that obsolete arrangement.

Keep the retained context term, closed parsing and whole-policy comparison.
Source inspection confirms policyHolds still compares context explicitly at
`generated-xmd.ts:1900`. GR11/GR27 establish retained shape, not an executed
context-refusal path. The main C1 mapping now states this distinction; released
fragment behavior remains required.

**Prompt/options wait on a dead element: accepted scope adjustment.** All three
members share the mailbox, so ending their wait when that element ends is a
compatible repair of its existing lifecycle contract. It needs no new public
interface or architecture interview. Retain this repair and its cleanup joins.
An authoritative failure must still survive the ending; a generic closed
answer does not satisfy that requirement, as findings 2/3 demonstrate for
evaluation. This ruling accepts the change's scope, not the remaining defects.

## Evidence

All commands below ran from
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
at the exact reviewed SHA. No CI state was inspected.

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/execution-protocol.test.ts packages/core/tests/document-output-api.test.ts packages/core/tests/syntax-component.test.ts
deno task test packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-placement.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/acp/tests/host-conversation.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-bound.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-syntax-documentation-bound.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-documentation-capture-bound.probe.ts
deno task validate:docs
```

Results, respectively: 28 tests/123 steps; 39/392; 5/38; 13/69; 3/7;
documentation complete across one profile. Total: 88 tests, 629 steps, zero
failures. The second command combines the handoff's two independent regression
rows without changing their selection.

The additional [owner probe](pr2-root-owner-ddf3f6f9.probe.ts) and its
[runtime failure output](pr2-root-owner-ddf3f6f9.probe.log) reproduce four failing
steps for the three findings above; the post-activation closure control passes:

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-root-owner-ddf3f6f9.probe.ts
```

The watchdog bounds only the failed liveness assertion. Canonical completion
establishes that the execution has already ended; no timer establishes readiness.
These cases disprove E1/E7 directly and add no product journey or speculative
input matrix. Integrate them into the permanent ownership/conversation tests.
Preserve the probe and its failure log for correction review.

## Ready-to-send correction prompt

Correct `ddf3f6f967787316a9bb842d8271ece7ef5bfc62` against the accepted
E1–E9 plan. Close pending readiness and bound-method admission when the canonical
invocation ends before activation, while retaining joined cleanup ordering for
active evaluations. Preserve authoritative evaluation failures across main
success, main failure and invocation/conversation cancellation using canonical
failure ranking and exact error identity. Put the first evaluation's history
read/address allocation under the same owned answer/join protocol so its
original failure reaches both caller and owner rather than an availability Err.

The archived owner probe must pass all five steps, including its existing
control. Integrate its cases into host-generated-root.test.ts and
agent-conversation.test.ts. Preserve the accepted context partition evidence,
the shared dead-element wait repair, captured documentation, ordinary execute
runtime separation, released fragment behavior and canonical journal security.
Do not introduce another interface proposal, public authority seam, third PR
or terminal for halted work.

Run the amendment's focused commands plus this probe, commit promptly after
they pass, and hand back the exact SHA/parent and every command/result. Do not
delay for full suites or CI. Keep gate.ts unchanged and outside the commit;
do not resume the admission gate before Planner acceptance. No push or GitHub
write is authorized by this review.

## Continuity

Reviewed base: `ddf3f6f967787316a9bb842d8271ece7ef5bfc62`, parent
`8be2d2bc3c38c4a896d0b678e121beef28e02920`. Produced this review, the owner
probe/log, and plan status/context-evidence updates. No production code changed.
The implementation worktree still has only untracked gate.ts; SHA-256:
`e9c8ab8192df6fc339ce8061a3cd6fda4def289f2ebd41cce63750fe54b0207c`.
The two requested scope/evidence rulings are settled. The only next action is
the correction prompt above; no new design decision is assigned to the
Implementor.
