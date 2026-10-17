# U5 Planner review — REQUEST CHANGES

The three original blockers are fixed at `2f105ed738c5da25f348f97f708684aa4adbb4b3`. One related capture defect still violates the frozen Workflow vocabulary and runtime-bound requirements: the setup helper reads the request list twice, allowing Fetch to be selected without its request policy.

## Exact revision and scope

- Feedback SHA: `2f105ed738c5da25f348f97f708684aa4adbb4b3`.
- Tree: `923829a67736fc213ae72a0e45bf30c4cca105a5`.
- Parent/base: `3a1fade9246db937e11da6cdadc4751ec924be97`; this revision amends the prior feedback commit.
- Signature: `G`.
- Branch/worktree: `agent/upstream-u5-generated-selection`, `.claude/worktrees/u5-generated-selection`, clean at review.
- Cumulative diff: 64 files, +4514/-4877. Delta against the prior reviewed feedback: nine files, +493/-71.
- Authority: [frozen U5 handoff](../upstream-u5-handoff-3a1fade9/upstream-repository-prerequisite-u5-implementor-handoff.md), especially U5-5/U5-7 and Instructions §§5–6; [prior revision prompt](../upstream-u5-review-d2e684e2/implementor-revision-prompt.md).

No production code, branch, worktree or preservation ref was changed during review. CI and publication were not inspected or performed. The immutable source/handoff archive remains untouched.

## Original blockers closed

**R1 / U5-2:** canonical generated capture takes its own pre-policy path copy. Authored resolution now uses the detached settled options. Assembly carries a local description function, and the existing root Syntax fallback is built from the settled authored paths. No second identity installation or generated capture is introduced. EP26 is unchanged and passes. The new search-path replacement row imports the authored component while preserving the generated no-widening assertion.

**R2 / U5-7, case-colliding headers:** both bound capture and outgoing comparison refuse ambiguous differently cased names. The existing runtime terminal remains the authorization point. The retained real Evaluate/Fetch probe now reports:

```text
HEADERS {"transformed":false,"accepted":["admitted"]}
HEADERS {"transformed":true,"failure":"The HTTP request is not permitted in this scope.","accepted":[]}
```

Committed WGX13 exercises the production Workflow helper and real transport with a control. WGX14 covers invalid host bounds. WGX9 now mutates the caller's bound while the same installed policy remains live, then proves that the original request still passes and the changed requests refuse. This corrects the earlier ineffective assertion.

**R3 / U5-4:** REPL entry setup uses the shared delegate-first, undefined-only fallback. The retained real REPL probe reads the custom empty selection exactly once and refuses it both with and without the ordinary default. The committed REPL rows also cover a valid narrower selection and the ordinary no-custom control.

Canonical name ordering within existing class/form order, innermost publication, safe request-refusal normalization and the accepted EL5/EL7 premise changes remain accepted. They are not reopened by this review.

## R4 — Fetch selection and policy come from different readings

Priority P1. This is one remaining blocker under frozen U5-5 and U5-7, not a new product requirement.

In `packages/workflow/src/deno/workspace/evaluate.ts`, `useWorkflowGenerated()` captures bounds from `options.requests` at line 131. It then passes the original options object to `workflowGeneratedSelection()` at line 132, which reads `options.requests` again at line 110 to decide whether to include Fetch. At lines 134–135, an empty first capture returns without installing Permissions.

An ordinary accessor-backed options object can therefore state these two readings:

```ts
get requests() {
  reads++;
  return reads === 1 ? [] : [{ url: admittedUrl }];
}
```

The first reading installs no request policy; the second offers Fetch. A fragment then sends a destination the host's list did not admit. The [retained probe](bound-reading-probe.ts) uses production `useWorkflowGenerated()`, canonical public Evaluate and the real runtime Fetch terminal against a loopback server. It emits:

```text
{"changes":false,"reads":2,"failure":"The HTTP request is not permitted in this scope.","received":[]}
{"changes":true,"reads":2,"received":["/not-admitted"]}
```

The stable-input control states the admitted list on both readings and correctly refuses the other destination. The changing input sends `/not-admitted` without a failure. [Full output](bound-reading-probe.log) is retained. This is a performed request, not a hypothetical normalization difference.

The frozen host contract offers Fetch from this helper only when the host chose its non-empty request allowance, and keeps that allowance as a captured runtime restriction. With an empty captured list, Fetch must not be implicitly offered. The helper cannot use another reading to add the name after deciding to install no policy.

**Required correction:** capture the request input once, and derive both default Fetch membership and the installed bound from the same owned captured data. Do not pass the original options or request array back through another reading to decide membership. Preserve explicit component extensions and existing property composition. Keep the bound at runtime; do not reintroduce generic inventories, preflight request authorization or new public APIs.

**Required evidence:** add one committed production-helper integration regression for this repeated-reading defect. With the first request reading empty and a later reading advertising a bound, assert one read, no implicit Fetch admission and zero transport calls. Keep a stable non-empty positive control (existing WGX7/WGX13 may supply it). Establish that the regression fails on this reviewed revision. This closes the existing capture/vocabulary requirement rather than adding permutations.

## Verification

Independently run at this exact revision:

```sh
deno task test packages/core/tests/execution-protocol.test.ts packages/core/tests/generated-selection.test.ts packages/cli/tests/repl-execution.test.ts
deno task test packages/workflow/tests/generated-observations.test.ts
```

Results: 13 passed/127 steps and 3 passed/14 steps, respectively. Logs: [core/REPL regressions](regressions.log), [Workflow regressions](workflow-regressions.log). EP26 and the committed fixes pass. [Retained previous probes](retained-probes.log) confirm the same corrections. The new bound-reading probe demonstrates the remaining failure.

The Implementor's twelve command receipts were inspected and copied into `implementor-receipts/` for durable evidence: commands 1–6 report 26/159, 34/287, 28/171, 25/173, 30/223 and 2/19; Node and Bun each report 257 passing tests; dead-code and documentation complete; build reports the binary; compiled/npm-bin reports 7/21. Those are Implementor receipts, distinct from the independent reruns above. Before-fix outputs for R1–R3 are preserved alongside them. This review does not reinterpret their green result as proof of a case their assertions did not exercise.

## Continuity

Verdict: **REQUEST CHANGES** on `2f105ed738c5da25f348f97f708684aa4adbb4b3`, with R1–R3 closed and one blocker R4 remaining. Use the [bounded revision prompt](implementor-revision-prompt.md) in the existing authorized Implementor session/worktree. Correct only the repeated input reading and its discriminating evidence, then return a new signed feedback revision. Architect/Product Owner reviews, delivery, publication and merge remain separate. #902 stays held until U5 lands and its consumer owner removes forwarding.
