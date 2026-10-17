# Architect review: returned-tree validation

**PASS** — `a49229e983f35764ce59f92f43de37c15473e32f`.

This reviews #883 PR 2 increment 2 against the accepted
[validation contract](pr2-session-vocabulary-architect-handoff.md) and
[RV1–RV4 assignment](pr2-repl-validation-planner-handoff.md).
The [Implementor handback](pr2-repl-validation-implementor-handback.md) reports
the implementation, focused evidence and actual lineage.

## Revision and scope

- Branch: `agent/issue-883-pr2`
- Worktree: `.claude/worktrees/issue-883-pr2`
- Exact reviewed HEAD: `a49229e983f35764ce59f92f43de37c15473e32f`
- Parent: `135063e67ff4b39be0bba8ddbace08439969aeb8`
- Accepted rename ancestor: `9f15dc516ab8108efb3d4d19f970e32ffbe60000`
- The worktree is clean before and after the reviewer test run.

The intervening 135063e6 commit only corrects the ACP specification example and
its corresponding prose. Its interface now uses finish and new/existing,
resolving the previous review's non-blocking observation. It changes no runtime
behavior and does not alter this increment's accepted architecture or scope.

Architecture coverage includes the prior full base reading and every subsequent
architecture change through this revision. The complete four-file patch,
description issuer/reader, validator, commit path and relevant tests were read.
The REPL product specification was checked for the affected contract.

## Structural conclusions

- ReplTree.validate has the accepted synchronous Result<void> signature. It
  calls the existing validateDescriptions function, which reads issued frozen
  descriptions and accumulates findings in fresh local state. It reaches no
  node mutation, component hook, focus operation, commit lock or frame counter.
- apply retains its own validation inside commit, after any previous retirement
  joins and before prepare, frame advancement or focus/modal changes. Nothing
  records or trusts a prior validate result. There is no validation reservation.
- Commit serialization, release in finally, scope ownership and joined
  retirement are unchanged. Validation introduces no suspension or resource
  with an additional lifetime.
- The layout predicate is removed from useReplTree, validateDescriptions and
  the recursive walk. Its synthetic refusal is deliberately retired, with no
  replacement callback or second validator. Issuance, keys, focus and modality
  checks remain in the shared validator, including focus containment in the
  innermost modal and refusal of disjoint modal roots.
- architecture.md states the accepted two methods and ownership boundary.
  Leaving specs/repl-spec.md unchanged is justified: it carries the product's
  focus/input/presentation behavior, not the composition API or removed hook.
  No new product rule is needed to expose the existing validation checks.
- The patch adds no Sidekick mount, required host-recording behavior or provider
  configuration work from later increments.

No structural blocker or non-blocking architecture finding remains.

## Verification

Reviewer independently ran the assigned command at the exact reviewed HEAD:

```text
deno task test packages/cli/tests/repl-composition.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

Result: **58 passed, 201 steps, 0 failed**, exit 0, 32 seconds.

RV1–RV4 cover read-only valid/invalid validation, apply's independent refusal,
rechecking a changed desired set, and acceptance of the formerly synthetic
layout case. Existing issuance, modal/focus, commit cancellation and serialized
ownership tests also pass. Successful applies remain in the evidence, so a
validator that refuses everything cannot satisfy it.

The handback's additional consumer checks and temporary break-it controls were
read; they were not repeated. No full suite, CI inspection, dependency
installation, implementation change, commit or push was performed in review.

## Continuity

Architecture review of increment 2 is complete. Planner reviews RV1–RV4 at this
same SHA and supplies the exact base for increment 3, required custom-host
identity recording. Active provider configuration follows as increment 4.
R2 as a whole remains incomplete. Mounted section 5, terminal R7/R8 and the
36-frame comparison remain separate. No GitHub feedback was published.
