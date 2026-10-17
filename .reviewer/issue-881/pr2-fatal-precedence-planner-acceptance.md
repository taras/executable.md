# PR #886 fatal-precedence correction — Planner acceptance

**PASS at `ecca5c459b77bed653bcdeab5efd4f9ab656bb2e`.**

The correction satisfies
`pr2-fatal-precedence-implementation-handoff.md`. The reproduced fatal-precedence
finding is closed for Planner review. This record does not issue the separate
Architect review verdict requested by that handoff.

## Reviewed revision

- Branch: `agent/issue-881-pr2-fatal`.
- Exact parent: `a85c36cb2edc184055b9aa3e270ba1d70b20670f`.
- Recorded main base: `160e354e47f6fbeb1c792e6799c1fe26b2f155fc`.
- Signature: valid (`G`). Worktree: clean.
- Delta: only `packages/core/src/component-expansion.ts` and its existing test
  suite. The lifecycle-test cleanup is unchanged.

## Finding closure

The raised canonical-settlement branch now examines both the canonical failure
and the middleware-chain failure after unwind. The private selector applies
the established order: durability first, Files fatal second, canonical ordinary
failure otherwise. Canonical-first nullish selection preserves the earlier
failure within each fatal kind. A separate chain-failed flag preserves failure
presence independently of its raised value. The absent and successful canonical
branches retain their existing behavior.

One selected value feeds the authoritative throw and the detached terminal
report. Existing terminal publication still occurs after dispatch unwind and
uses the once-only terminal guard. No public API, persistence, cancellation
owner or subscriber lifetime changes.

The four new regressions use public expansion middleware and real expansion.
They prove persistence and Files fatal competition, ordinary canonical
precedence, and the successful-body fatal control. The fatal reports preserve
the selected diagnostics while remaining frozen, distinct from the canonical
Error, and without its fatal branding. Existing publication, teardown, rescue
and once-only checks remain green.

The Planner independently reran the original two-case reproducer against this
exact checkout. Both cases now throw the original DurablePersistenceError and
report `fatalPreserved:true`; the ordinary-body competition failed at the
parent in the previous review. The supplied mutation record restores the old
selection and breaks both competition assertions while preserving the ordinary
case and positive control. Its reported restored SHA-256 matches the current
source: `2aed06e7108ea104ffd6d8ea87b6c258a8e83ee6a1a89e7d325051f1d1b313bb`.
The Planner did not rerun the mutation against the implementation worktree.

## Independent commands

Run from `.claude/worktrees/pr2-fatal`:

```sh
deno task test packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
# 53 tests / 418 steps; exit 0

deno task test packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts
# 14 tests / 52 steps; exit 0

deno test --allow-all --node-modules-dir=manual --cached-only --frozen --config deno.json /private/tmp/pr886-fatal-review-ecca5c45/fatal-precedence.test.ts
# Original reproducer: 1 test / 2 steps; exit 0

git diff --check 160e354e HEAD
# exit 0
```

Outputs and the exact-head probe are retained in
`pr2-fatal-precedence-planner-evidence/`, with a SHA-256 manifest. No full corpus,
gallery rerun, production edit, commit, push, PR update or CI inspection was
performed by this review.

## Next action

Return `ecca5c459b77bed653bcdeab5efd4f9ab656bb2e` and the handback to the
Architect for the requested execution-boundary re-review. No Planner blocker
remains for this correction. The Implementor remains stopped before publication
or dependent-stack changes. Delivery verification remains separate.
