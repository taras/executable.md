# PR 2 architecture review — #886

**REQUEST CHANGES** on `3815aef4eb72000c2c59f8b06a8e01ed8c9070b5`.
One blocker remains: the new component expansion boundary discards a fatal
middleware failure when canonical component work already failed ordinarily.
The accepted contract requires fatal precedence across both outcomes.

## Reviewed boundary

Reviewed [PR #886](https://github.com/taras/executable.md/pull/886) against main
`160e354e47f6fbeb1c792e6799c1fe26b2f155fc` on 2026-10-09. The exact PR head and
base were checked again before recording this verdict.

#885 has merged. #887 depends on #886 and owns the subsequent History slice;
this review does not cover it. The concurrent #805 session-rendering proof
changes test infrastructure rather than the private REPL production boundary.
The original corrected reference remains the #881 reference; newer features
remain outside this slice.

The reviewed tree is byte-identical to accepted feedback revision
`acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e`. Its main base is byte-identical to
the previous integrated base `c7d54769d56661bef38cee8549b148f3bf87a904`.
Both comparisons pass `git diff --exit-code`. This review independently checks
the published head against the seven frozen requirements in
[pr2-planner-handoff.md](pr2-planner-handoff.md).

## R1: preserve fatal precedence when middleware unwinds

The [accepted invocation contract](pr2-invocation-contract.md) requires the
existing policy-failure pattern: canonical failure cannot be rescued, while
durability and Files fatal precedence remains authoritative. The
[implementation handoff](pr2-implementation-handoff.md) repeats this requirement
under “Surround the complete canonical invocation.” This finding belongs to
frozen checklist item 1; it introduces no new architecture criterion.

At the reviewed head, `packages/core/src/component-expansion.ts:369` captures
the middleware chain's failure. Lines 377–380 then select a previously raised
canonical failure unconditionally, without inspecting the chain failure for a
fatal cause. The terminal reporting Result is also built from that ordinary
canonical failure.

The established `Execution.document` reconciliation in
`packages/core/src/execute.ts:3244` first examines both canonical and policy
failures for durability failure, then Files fatal failure, and only then applies
canonical ordinary-failure precedence. `rankBoundFailure` in
`packages/core/src/expand.ts:1590` follows the same ordering. The new boundary
loses the later fatal failure before either enclosing boundary can recognize it.

The [reproducer](evidence/pr886-architecture-fatal-precedence.test.ts) uses the
supported public `Component.around({ expand })` middleware and real
`expandSegments` execution. It delegates the exact request once. A function
component raises an ordinary body error; the middleware's synchronous `finally`
raises a genuine `DurablePersistenceError` during unwind. No counterfeit
request, mutable context authority or hostile reporting object is involved.

Expected: the persistence failure remains the authoritative fatal outcome.
Actual: expansion throws `Error: ordinary body failure`, and
`durabilityFailure(caught)` is `undefined`. The same middleware after a
successful body preserves the persistence failure, establishing the control.
The [first valid regression output](evidence/pr886-architecture-fatal-precedence.log)
contains one passing control step and one failing competition step.

This changes which authoritative outcome wins after a fatal failure. It is an
execution-boundary defect, not diagnostic wording or ordinary Error identity.
Correcting reconciliation belongs within this PR because the PR introduces
the boundary that suppresses the fatal outcome. No persistence change or
product decision is needed.

## Other structural checks

No additional blockers were found in the remaining frozen boundaries:

- Exact request identity is checked before the terminal claims work; private
  settlement retains once-only execution authority. The previous foreign-request
  correction remains present.
- Invocation cleanup retains its existing owner and ordering. Session-owned
  phase readers do not join dispatch while awaiting its terminal phase. Entry
  release clears live observations after owned work and consumers unwind.
- Generated execution retains the existing capability boundary. Private
  occurrence context supplies presentation attribution without becoming
  execution or durable authority.
- Static inspection uses the canonical scanner, evaluates no header or body,
  and preserves the installed document envelope. Replacement uses retained
  owner and exact source ranges. Published observations and explanatory
  aggregate members retain the earlier immutability correction.
- No Journal schema or persistence mechanism changes. Historical views suppress
  live overlays, use selected-prefix facts and retain the actual output owner.
- Immutable readings and semantic actions remain inside the measured admission,
  mounted-tree, focus and frame-target path. Width probes create no mounted
  nodes or targets; source and preview wrapping use engine measurements.

Ordinary visual acceptance remains with the Planner. The existing 44-pair
gallery and control record are not relabelled as new captures from this review.

## Focused evidence

Prepared an isolated detached worktree at the exact reviewed head with
`deno task setup`, then independently ran:

```sh
deno task test packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
# exit 0 — 53 tests / 414 steps
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-journey.test.ts
# exit 0 — 94 tests / 316 steps
deno task test packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts
# exit 0 — 14 tests / 52 steps
git diff --check 160e354e 3815aef4
# exit 0
```

Saved outputs: [Core](evidence/pr886-architecture-core.log),
[CLI](evidence/pr886-architecture-cli.log) and
[lifecycle](evidence/pr886-architecture-lifecycle.log). Total: 161 passing tests
and 782 steps. These passing checks do not exercise the reproduced competition.

The reproducer imports the reviewed source in the retained isolated worktree
`/private/tmp/xmd-pr886-architecture-review`. Run it from the repository:

```sh
deno test --allow-all --node-modules-dir=manual --cached-only --frozen --config /private/tmp/xmd-pr886-architecture-review/deno.json .reviewer/issue-881/evidence/pr886-architecture-fatal-precedence.test.ts
# exit 1 — successful-body control passes; ordinary-body/fatal-cleanup case fails
```

The isolated checkout remains clean. No production changes, CI inspection or
GitHub review publication were performed.

## Implementor handoff

Review and correct PR #886 from exact head
`3815aef4eb72000c2c59f8b06a8e01ed8c9070b5`, based on main
`160e354e47f6fbeb1c792e6799c1fe26b2f155fc`.

The accepted `Component.expand` contract requires the existing fatal-failure
precedence across canonical work and middleware, including middleware unwind.
The attached regression shows an ordinary body error suppressing a genuine
`DurablePersistenceError` raised by a delegating middleware's `finally`.
`observeExpansion` currently chooses `settlement.raised` before considering
fatal causes in `chainFailure`.

Restore the established ordering across both failures: durability first, Files
fatal second, then canonical ordinary failure before a later ordinary policy
failure. Preserve the existing earlier-failure preference within each fatal
kind. A middleware must still neither rescue canonical failure nor replace it
with a later ordinary error. The authoritative throw and the detached terminal
report must describe the same selected outcome after full unwind.

Add focused regressions at this boundary for the reproduced ordinary-body /
fatal-middleware competition, the Files fatal counterpart, and the preserved
ordinary-failure ordering. Keep the successful-body fatal control. Assert the
authoritative fatal outcome and corresponding detached terminal report; use
the existing publication checks for one terminal observation after cleanup.
Reuse established reconciliation semantics without widening public APIs,
changing persistence, or creating new resource owners.

Run the affected Core expansion/invocation regressions first. Once focused
checks pass, commit promptly and return the exact feedback SHA, parent and
every focused command and result. Return the changed architecture boundary
for review. #887 remains dependent work; its History contract is unchanged.
