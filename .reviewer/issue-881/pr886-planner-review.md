# PR #886 — Planner review of the published head

**REQUEST CHANGES at `a85c36cb2edc184055b9aa3e270ba1d70b20670f`.**

Base: main `160e354e47f6fbeb1c792e6799c1fe26b2f155fc`. The published head and
base were rechecked and remain those revisions. This record incorporates the
Architect's [exact-head re-review](pr2-published-architecture-rereview.md).

## P1 — ordinary body failure hides fatal middleware teardown

`packages/core/src/component-expansion.ts:378` selects a raised canonical
settlement before inspecting the failure from middleware unwind. If the body
raised an ordinary Error and delegating middleware's finally raises a genuine
DurablePersistenceError, the persistence failure is discarded. The caller sees
the ordinary body error; the complete observation reports that ordinary error
as well. This prevents enclosing reconciliation from recognizing that the
Journal failed and applying fatal-failure precedence.

The supported public middleware reproducer was independently run against this
exact head. Its successful-body control preserves the persistence failure. Its
ordinary-body competition fails: the actual thrown value is Error with message
`ordinary body failure`, and `durabilityFailure(caught)` is undefined. The first
output is retained in
[fatal-precedence.log](pr886-planner-review-evidence/fatal-precedence.log), with
the [exact-head probe](pr886-planner-review-evidence/fatal-precedence.test.ts).

This violates the existing invocation contract and frozen structural check 1.
Restore established ordering across canonical and middleware outcomes:
durability, then Files fatal, then canonical ordinary failure before later
ordinary middleware failure. Preserve earlier-failure preference within each
fatal kind and make the authoritative throw and detached terminal report
describe the same selected outcome after full unwind.

The current production tree is byte-identical to the earlier accepted feedback
tree at acadbbdb. That earlier Planner acceptance missed this competing-failure
case; it does not close the reproduced blocker. The published delta changes
only lifecycle-test scopes and contains no production correction.

## Other review results

The lifecycle scope removal preserves the assertions and the comparison's
separate run scopes. The test adapter owns each test's task and cleanup. All
eight steps in the changed lifecycle suite pass as part of the supplemental
command. File-specific lint has no errors, with one existing sort warning.

The main base is byte-identical to the earlier integrated base c7d54769. All
other reviewed files match the previously accepted tree. The earlier visual
and live-journey evidence is retained as historical evidence for that unchanged
production tree; it is not presented as a new gallery captured at this SHA.
No additional blocker was found in this delta review.

## Independent verification at a85c36cb

Prepared the isolated detached worktree
`.claude/worktrees/pr886-planner-review` using `deno task setup`. Sandboxed
setup could not reach the package registry and was stopped; setup with network
access completed before checks began. No declared dependencies or tracked files changed.

Reran the three frozen commands listed in
`pr2-planner-acceptance-evidence/focused-commands.json` from this exact-head
worktree:

| Command group | Result |
| --- | --- |
| Core expansion, inspection and invocation | 53 tests / 414 steps; exit 0 |
| CLI source, execution, admission, presentation, forms and journeys | 94 tests / 316 steps; exit 0 |
| Lifecycle and Agent execution | 14 tests / 52 steps; exit 0 |
| Exact-head fatal-precedence probe | exit 1; control passes, competition fails |
| `git diff --check 160e354e HEAD` | exit 0 |

All logs, remote revision metadata and the probe are retained in
[pr886-planner-review-evidence/](pr886-planner-review-evidence/), with a SHA-256
manifest. The review worktree is clean. Passing frozen checks do not exercise
the reproduced competing-failure case.

## Consolidated Implementor handoff

Use [pr2-fatal-precedence-implementation-handoff.md](pr2-fatal-precedence-implementation-handoff.md).
It incorporates the Architect's required selection order, exact base, permanent
regressions, authoritative throw and detached-report checks, focused commands,
and return-for-review boundary. No new architecture or product decision is
required. History and responsiveness retain their separate contracts.

No production edits, push, PR update, GitHub review posting, merge or CI
inspection were performed. Delivery verification remains separate.
