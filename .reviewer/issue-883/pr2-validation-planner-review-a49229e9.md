# Planner review: returned-tree validation at a49229e9

**PASS.** Increment 2 satisfies RV1–RV4. The validation API is accepted.

Reviewed commit: `a49229e983f35764ce59f92f43de37c15473e32f`.
Parent: `135063e67ff4b39be0bba8ddbace08439969aeb8`.
Branch: `agent/issue-883-pr2`. Signature: G, tarasm@gmail.com.
Worktree verified clean before and after the independent command.

Authority: [the validation handoff](pr2-repl-validation-planner-handoff.md)
and [Implementor handback](pr2-repl-validation-implementor-handback.md).

## Contract and evidence

ReplTree exposes synchronous validate(descriptions): Result<void>. It delegates
directly to validateDescriptions, which reads the supplied descriptions and
keeps its walk state local. It reaches no mounted node, frame counter, focus
operation or lifecycle callback.

apply retains the same validator inside commit, before prepare and the frame
increment. Serialized commits and joined retirement are unchanged. There is
no cache, saved approval or path bypassing the commit's own check.

The callback parameter is removed from useReplTree, validateDescriptions and
its recursive walk. Only the synthetic custom-slot refusal is removed; issued
description, missing/duplicate key, conflicting focus, modal ordering and focus
containment checks remain.

| Row | Review |
| --- | --- |
| RV1 | On a nonempty focused tree, valid and invalid validation results preserve mounted IDs, focus, frame ID, cells and lifecycle journal. Duplicate keys, conflicting focus and incompatible modal roots refuse. |
| RV2 | Invalid apply calls made without prior validate preserve those observations. Existing modal/issued-description refusal coverage remains. |
| RV3 | A valid advance judgment does not admit a later invalid desired set; refusal preserves the tree and a valid successor commits. Source review confirms apply always judges the supplied values independently. |
| RV4 | The callback and its synthetic rejection are gone. The old duplicate-key/conflicting-focus assertions remain. The formerly synthetic layout is now accepted and mounted through the ordinary path. |

The successful apply controls are sufficient alongside the unchanged existing
composition tests. The Implementor's frame-increment and always-Ok mutation
results are separately reported; no extra mutation exercise was required or
independently repeated.

## Stack and documentation

The assigned base 9f15dc51 is an ancestor, with one intervening signed,
documentation-only commit 135063e6. That commit corrects the ACP provider-factory
example to finish and new/existing, plus the adjacent session wording. It touches
only specs/acp-client-spec.md and does not affect this API implementation.
The correction is accepted with this stack review; no rebase or rewritten
feedback commit is required.

architecture.md states the two methods, read-only validation and automatic
pre-mutation checks. Leaving specs/repl-spec.md unchanged is accepted: its
current product contracts contain no reconciliation API/predicate description
that this increment makes false. Adding a new implementation paragraph there
is unnecessary. Existing focus, input and presentation claims stand.

## Independent command

Run from the implementation worktree at a49229e9:

```text
deno task test packages/cli/tests/repl-composition.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

Result: **58 passed, 201 steps, 0 failed**.
[First output](pr2-validation-review-a49229e9-first.log).

The extra forms/layout/terminal and formatting checks in the handback are
reported separately and were not independently repeated. No broad suite,
compiler/JSR prerequisite, CI inspection or GitHub mutation was added.

## Continuity

Latest accepted PR 2 head is a49229e9. Next Implementor action:
[required custom-host identity recording](pr2-session-recording-planner-handoff.md)
from this exact SHA, as its own feedback increment with HR1–HR4 and the two
assigned commands. Active provider configuration follows that increment's
acceptance; SC1–SC7 behavior remains frozen.

No configuration implementation or R2 completion is claimed here. Owner
acquisition in program.ts, mounted section 5, terminal R7/R8 and the 36-frame
packet remain separate. No push, GitHub mutation or CI inspection is authorized.
