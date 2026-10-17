# Core PR 1 Planner review — REQUEST CHANGES

Reviewed commit: `d45bbfc6b4857684e4d51dc710837bb2f8bfa0a5`.
Parent and refreshed base: `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`.
The reviewed worktree is clean. This is implementation feedback against the
frozen C1–C3 matrix, not a merge verdict.

C1 and C2 have passing focused evidence and no blocking finding in this review.
C3 is not accepted. Fix the cancellation ownership defect and supply the
native provider assertion evidence before starting CLI PR 2. These findings
apply the accepted contract; they introduce no new architecture decision.

## Findings

### P1 — Cancelling the prompt caller does not join provider teardown

In `packages/core/src/agent/conversation.ts:286`, the prompt caller's cleanup
only resolves `cancelled`. It never waits for the worker to finish handling that
signal. The caller also clears `live.busy` in its `finally` at line 302. The
worker subsequently waits for `turn.halt()` in `deliver`, but that worker belongs
to the long-lived conversation rather than the cancelled caller.

A probe using the committed test provider installs an asynchronous cleanup on
the held turn. With that cleanup blocked, `caller.halt()` returns. The probe
expected `halt waits` and received `halt returned`. Its cleanup gate is released
after the observation so the test itself joins its work and exits.

This violates the accepted Core interface: “Cancelling the turn's owning scope
cancels/joins that work” (`core-interfaces-proposal.md`, prompt lifecycle).
A CLI cycle therefore cannot treat completion of its cancellation as proof that
provider work has stopped. CV11 misses this because its provider has no held
teardown.

Make the caller observe completed cancellation and provider cleanup before its
halt finishes. Keep the conversation unavailable to another turn through that
cleanup. Preserve cleanup failures under the accepted fatal teardown contract.
Add this discriminating held-teardown regression to the C3 tests, then prove
fresh explicit work still starts without replaying the cancelled turn.

### P2 — The handback's native identity evidence does not test native identity

The frozen C3 row explicitly requires an injected provider assertion proving
established identity mismatch and pre-mapping reconciliation without exposing
a claimant. The handback marks this met by CV12–CV14 and CV16.

CV12 and CV13 compare the logical host history id and agent. CV14 constructs an
`agent_prompt` error record by hand and refuses it before opening. CV16 checks
configuration readback. The shared provider calls `placement.complete` with
`kind: "established"` and a fixed session key. None injects an authenticated
native provider assertion or interrupts accepted identity establishment before
mapping acknowledgement. Those are different contracts from logical history
ownership and configuration.

Add the two representative scenarios already required by C3, through
`useAgentConversation` and the canonical provider identity seam: an established
native identity mismatch, and an accepted first-turn assertion before mapping
acknowledgement. Demonstrate canonical reconciliation to that same identity, or
truthful refusal when the canonical facts cannot establish it, with no blind
resend or replacement session. Do not substitute a fabricated failed Prompt
record for the actual interruption boundary. Keep claimant issuance internal.
Update the handback mapping to cite the actual evidence and correct production
behavior if those scenarios expose a defect.

## Evidence

Reviewer ran at the exact feedback commit:

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
```

Result: **17 tests, 81 steps passed**.

Reviewer also ran:

```sh
deno test --allow-all --frozen --config deno.json /private/tmp/issue-883-cancel-probe.test.ts
```

Result: **failed**, one test/step. The tested source is archived unchanged in
[pr1-cancellation-probe.test.ts](pr1-cancellation-probe.test.ts). Run from the
review worktree; its imports refer to that exact local checkout.

First behavioral failure:

```text
C3 cancellation ownership probe ...
  C3 cancellation waits for provider teardown ... FAILED

error: Error: expect(received).toBe(expected) // Object.is equality
Expected: "halt waits"
Received: "halt returned"
  expect(answered.value).toBe("halt waits");
                         ^
    at file:///private/tmp/issue-883-cancel-probe.test.ts:287:26

FAILED | 0 passed | 1 failed (1 step)
```

An earlier probe invocation failed to register because `it()` was outside a
`describe()` block. That harness mistake was corrected before the behavioral
probe above; it is not product evidence or an intermittent result.

The Implementor separately reports the handoff's two regression commands,
scanner/root-selection/corpus regressions, documentation validation, oxlint
and formatting as passing. This review did not repeat them. No CI was inspected.

## Ready-to-send revision prompt

Revise Core PR 1 from `d45bbfc6b4857684e4d51dc710837bb2f8bfa0a5` against
`.reviewer/issue-883/pr1-planner-review.md`. Fix prompt cancellation so the
caller's halt joins the provider's teardown, keeps overlap refused until that
work ends, and preserves authoritative teardown failures. Turn the archived
held-teardown probe into a focused C3 regression and retain the fresh-work
cancellation evidence.

Complete the frozen C3 provider assertion evidence: test an established native
identity mismatch and the accepted-first-turn/pre-mapping-acknowledgement
boundary through the real canonical identity seam, without exposing a claimant,
resending accepted work or replacing the conversation. Fix any behavior those
tests disprove and correct the handback's criterion mapping.

Run the handoff's three focused Core commands and affected explicit regressions.
Commit promptly after that evidence passes and return the new exact SHA, parent,
commands/results and updated criterion mapping for Planner review. Do not start
CLI PR 2, push, open a PR or change MEMORY.md as part of this revision.

## Continuity

The settled architecture, two-PR delivery order and accepted foundation remain
unchanged. PR 1 requires the two corrections above; PR 2 waits for a passing
Planner verdict on the revised feedback commit. No GitHub action or memory
restructuring was performed.
