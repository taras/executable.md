# PR 2 architecture re-review — #886

**REQUEST CHANGES** on `a85c36cb2edc184055b9aa3e270ba1d70b20670f`.
The previously reported fatal-precedence blocker remains and reproduces on this
exact head. The published revision changes lifecycle tests only; it contains no
production correction.

## Reviewed boundary

Reviewed [PR #886](https://github.com/taras/executable.md/pull/886) on 2026-10-10
against main `160e354e47f6fbeb1c792e6799c1fe26b2f155fc`. The head's parent is
the previously reviewed `3815aef4eb72000c2c59f8b06a8e01ed8c9070b5`.
The PR head and base were read again after the checks and remain unchanged.

The complete delta from the previous review is
`packages/cli/tests/repl-lifecycle.test.ts`: it removes redundant scoped wrappers
from individual tests while preserving the assertions and the comparison's
separate run scopes. All production code, specifications and architecture are
unchanged. The [previous architecture review](pr2-published-architecture-review.md)
records the full seven-item structural trace; this review checks the new delta
and reproduces its remaining blocker rather than relabelling earlier evidence.

#885 remains merged. #887 depends on #886; the new #889 performance slice
depends on #887 and changes private REPL fitting/application code. Neither
descendant is a dependency of this review or covered by its verdict. The older
corrected reference and accepted #881 contracts remain authoritative.

## R1 remains: a body failure suppresses a fatal middleware failure

Frozen checklist item 1 in [pr2-planner-handoff.md](pr2-planner-handoff.md), the
[invocation contract](pr2-invocation-contract.md), and the implementation handoff
require authoritative failure selection to preserve existing durability/Files
fatal precedence across canonical work and middleware cleanup.

At this exact head, `packages/core/src/component-expansion.ts:369` retains the
middleware failure in `chainFailure`, but lines 377–380 unconditionally throw
`settlement.raised` when canonical work failed. This bypasses fatal causes in
the middleware failure and reports the ordinary canonical error as terminal.
The established `Execution.document` reconciliation at
`packages/core/src/execute.ts:3244` instead examines both outcomes for durability
failure, then Files fatal failure, before ordinary canonical-failure precedence.
The component boundary discards the fatal cause before enclosing reconciliation
can recover it.

The [exact-head reproducer](evidence/pr886-a85c36cb-fatal-precedence.test.ts)
uses public `Component.around({ expand })` middleware around real
`expandSegments` execution. It delegates the exact request once. The component
raises an ordinary error and the middleware raises a genuine
`DurablePersistenceError` from its synchronous `finally` during unwind.

Expected: the persistence failure wins. Actual: the ordinary body failure wins
and `durabilityFailure(caught)` is `undefined`. The successful-body control
preserves the persistence failure. The [fresh output](evidence/pr886-a85c36cb-fatal-precedence.log)
records one passing control step and one failing regression step.

This uses an in-scope supported middleware surface and changes which
authoritative outcome wins after a fatal failure. The correction belongs in
this PR's new expansion boundary. It requires no new product decision,
persistence change or architecture amendment.

## Fresh verification

Prepared `/private/tmp/xmd-pr886-r1-architecture-review` at the exact head with
`deno task setup`. The initial sandboxed preparation could not download packages;
it was stopped before rerunning setup with network access, which completed.

```sh
# In the prepared exact-head worktree:
deno task test packages/cli/tests/repl-lifecycle.test.ts
# exit 0 — 1 test / 8 steps
git diff --check 160e354e a85c36cb
# exit 0

# From the repository containing this record:
deno test --allow-all --node-modules-dir=manual --cached-only --frozen --config /private/tmp/xmd-pr886-r1-architecture-review/deno.json .reviewer/issue-881/evidence/pr886-a85c36cb-fatal-precedence.test.ts
# exit 1 — control passes; ordinary-body/fatal-cleanup competition fails
```

The [changed lifecycle suite output](evidence/pr886-a85c36cb-lifecycle.log)
is saved separately. The prior 161 tests / 782 steps belong to `3815aef4`;
they were not rerun or attributed to this head. The isolated checkout remains
clean. No production code was changed, CI status inspected or GitHub review posted.

## Implementor handoff

Correct PR #886 from exact head
`a85c36cb2edc184055b9aa3e270ba1d70b20670f`, based on main
`160e354e47f6fbeb1c792e6799c1fe26b2f155fc`.

The accepted `Component.expand` contract preserves fatal-failure precedence
across canonical work and middleware unwind. The attached exact-head regression
shows an ordinary body failure suppressing a persistence failure raised by
delegating middleware's `finally`. The current revision changes tests only;
the required production correction remains absent.

Restore established selection across both failures: durability first, Files
fatal second, then canonical ordinary failure before later ordinary policy
failure. Preserve the existing earlier-failure preference within each fatal
kind. Middleware must still neither rescue canonical failure nor replace it
with a later ordinary error. The authoritative throw and detached terminal
report must describe the same selected outcome after full unwind.

Add focused boundary regressions for the reproduced persistence competition,
its Files fatal counterpart, and preserved ordinary-failure ordering. Keep the
successful-body fatal control. Check the authoritative fatal outcome and the
corresponding detached terminal report, retaining one terminal observation after
cleanup. Preserve public APIs, persistence and existing resource owners.

Run affected Core expansion/invocation regressions, commit once focused checks
pass, and return the exact feedback SHA, parent and every focused command and
result. Return the corrected boundary for architecture review. The dependent
History and performance slices retain their separate contracts and reviews.
