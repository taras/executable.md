# PR #886 — preserve fatal failures through expansion middleware

**REQUEST CHANGES at `a85c36cb2edc184055b9aa3e270ba1d70b20670f`.**

Correct the component expansion boundary so a persistence or Files fatal failure
raised during middleware teardown remains the authoritative outcome even when
the component body already failed ordinarily. The ordinary body error currently
hides that fatal failure.

This consolidates the Architect's exact-head re-review in
[pr2-published-architecture-rereview.md](pr2-published-architecture-rereview.md)
and the Planner's independent current-head reproduction. It implements the
existing invocation contract and frozen structural check 1. No product decision
or architecture amendment is outstanding.

## Base and scope

Work from PR #886 head `a85c36cb2edc184055b9aa3e270ba1d70b20670f`, parent
`3815aef4eb72000c2c59f8b06a8e01ed8c9070b5`, against main
`160e354e47f6fbeb1c792e6799c1fe26b2f155fc`. Preserve the current lifecycle-test
cleanup: it removes redundant scopes, retains the comparison's separate run
scopes and passes all eight steps. That change contains no production repair.

Read repository AGENTS.md, the required Effection instructions, architecture.md,
the affected executable-MDX sections and the Architect's re-review. The
original PR 2 implementation handoff and invocation contract remain governing
documents.

Own the correction in `packages/core/src/component-expansion.ts` and focused
regressions in `packages/core/tests/component-expansion.test.ts`. Reuse existing
error classification and reconciliation semantics. Do not refactor unrelated
boundaries merely to share a helper.

#885 is merged. #887's History slice and #889's responsiveness slice are
dependent work with separate contracts and reviews. Do not repair this defect
in a descendant, rewrite their behavior, rebase the stack, or update those PRs
as part of this feedback task.

## Reproduce before changing code

Use the Architect's exact-head reproducer at
`evidence/pr886-a85c36cb-fatal-precedence.test.ts`, or the Planner's copy at
`pr886-planner-review-evidence/fatal-precedence.test.ts`. Their absolute imports
name the retained review worktrees; adapt them to the implementation checkout
before using them as local evidence. Put the permanent regression in the
existing Core suite rather than depending on these local paths.

The public `Component.around({ expand })` handler delegates the exact request
once. A function component throws an ordinary body error. The middleware's
synchronous `finally` then raises a genuine `DurablePersistenceError`.

Expected: the persistence failure wins. Actual: `observeExpansion` selects the
ordinary canonical failure, and `durabilityFailure(caught)` is undefined. The
same middleware after a successful body preserves the persistence failure and
serves as the positive control. Keep the first failing output.

## Required correction

`observeExpansion` captures `chainFailure` at lines 369–371, but its raised
canonical settlement branch at lines 377–380 reports and throws the canonical
error before examining the middleware failure. Reconcile both after the full
middleware dispatch has unwound, following `reconcileExpansion` in execute.ts
and `rankBoundFailure` in expand.ts:

1. Durability failure wins across either outcome.
2. Otherwise, Files fatal failure wins across either outcome.
3. Otherwise, an ordinary canonical failure wins over a later ordinary
   middleware failure. Middleware cannot rescue canonical failure by catching it.
4. When canonical work succeeded, middleware failure still fails the expansion.

Within each fatal kind, preserve the existing preference for the earlier
canonical failure. Preserve the distinction between no failure and a raised
value, including non-Error values.

Use the same selected outcome for the authoritative throw and detached terminal
report. Publish exactly one terminal observation after cleanup. The reporting
Error remains detached and immutable: it conveys the selected diagnostic and
explanations without exposing the canonical Error's identity, resource handles
or fatal branding.

Preserve exact-request delegation, once-only execution, private canonical
result acceptance, cancellation and cleanup ownership, existing failure
precedence, subscriber independence, and observed/unobserved execution
equivalence. Add no resource owner, public API, dependency or persistence change.

## Frozen focused evidence for this correction

Add regressions through the public expansion middleware and actual expansion
boundary for:

- Ordinary body failure competing with a middleware teardown persistence
  failure: persistence wins.
- The corresponding Files fatal competition: Files fatal wins.
- Ordinary body failure competing with a later ordinary middleware failure:
  the canonical failure remains authoritative.
- Successful body followed by fatal middleware teardown: retain the positive
  control.

Assert the selected authoritative outcome and the corresponding detached
terminal report, including its detachment. Retain the existing publication
checks for one terminal phase after cleanup and the existing canonical-failure
rescue/once-only tests. Use the accepted precedence above when reviewing any
shared reconciliation helper's existing tests; do not add a permutation matrix
without a distinct missing invariant.

The regression must fail on `a85c36cb`; restore the old selection in a controlled
local mutation after the fix and require the persistence competition to fail
again. Preserve the first substantive failure and verify exact source-byte
restoration before final focused checks.

Run the boundary regression first, then the frozen affected Core command:

```sh
deno task test packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
deno task test packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts
git diff --check 160e354e HEAD
```

No full runtime corpus, gallery rerun or CI wait is required for this feedback
commit. Delivery verification remains separate.

## Handback and next action

Commit promptly once focused evidence passes. Return the exact signed feedback
SHA, parent, base, changed files, every focused command/result, the original
failure, the restored mutation control and the selection/reporting evidence.
Return the corrected execution boundary for Architect review and Planner
accept-or-request-changes. Stop before pushing, updating PRs, merging or changing
the dependent stack.

Continuity: exact base `a85c36cb2edc184055b9aa3e270ba1d70b20670f`; artifact
`pr2-fatal-precedence-implementation-handoff.md`; established failure ordering
above is settled; one reproduced fatal-precedence blocker remains; next
Implementor action is to reproduce it and correct the boundary.
