# PR 1 Planner feedback

**REQUEST CHANGES** on `f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa`.
The colour, pane and drawer slice has three unmet frozen requirements. Its
structure, measured drawer decoration and scope separation can remain.

Reviewed parent: `56afe3af7a960d00494cd495b00274b5986e812a`.
Base: `e68f128121cd802623ab7797a016b0c66ce91176`.
Branch: `agent/issue-881-pr1`; worktree: `.claude/worktrees/issue-881-pr1`.
The worktree is clean at the exact feedback commit. Review covers the full
two-commit change against that base and the current frozen
[PR 1 handoff](pr1-handoff.md), including its UI16/UI17 window clarification.
No CI was inspected. Nothing was pushed or published.

## What passes

The Planner ran:

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-forms.test.ts
# 28 tests / 102 steps passed; exit 0
git diff --check e68f128121cd802623ab7797a016b0c66ce91176 f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa
# exit 0
```

The implementation retains one keyed element per row, immutable structural
runs, the shared measuring/committing operation builder and a model-blind
renderer. There is no Core, lifecycle, Journal, persistence, dependency or
runtime-entrypoint change. Local token helpers/types stay delegated.

The pane/drawer surfaces, bounded title, waiting title accent, measured inset
and short-row role separation are visible. UI16/UI17 remain at 72×20, advance
through the real window action and retain their behavioral assertions. The
description export inventory and journey reader changes fit those mechanics.

The Planner opened all 35 pairs through the 13 original contact sheets,
covering every supported profile and both supplied resize endpoints. All 262
files in the implementation evidence checksum manifest match. The saved cold
Journal/provider signatures are identical before and after inspection. The
reported audit reproduces 376 held checks; its result does not establish the
three missing requirements below. The four control patches and their first
failure outputs were inspected; their failures discriminate the tested behavior.

## R1: retain the roles of visible characters when a row overflows

`packages/cli/src/repl/layout.ts:800` sends every overflowing row through the
single-colour fallback. This prevents the engine's per-operation wrapping
defect, but removes the frozen role separation from already classifiable,
visible characters. This is not the allowed fallback for unclassified text or
an unfinished draft.

The failure exists in the frozen gallery, without inventing another scenario:

| Capture | Actual captured cell, one-based | Frozen expectation | Actual |
| --- | --- | --- | --- |
| `plan-review-160x36` | `<` at row 21, column 22 | `#4e8b9c` delimiter | `#c8d2d9` |
| `plan-review-160x36` | `Elicit` at row 21, column 23 | `#7fd3e8` tag | `#c8d2d9` |
| `plan-review-160x36` | `schema` at row 21, column 30 | `#8fa7b8` attribute | `#c8d2d9` |
| `completed-details-72x20` | `A lightweight` in the field-name/value row, row 9, column 40 | `#e6ecf1` value | `#8b959c` label |

The last row demonstrates that the fallback affects the approved form example
as well as source syntax. The visible value stops reading differently from its
field name at narrow size.

The overflow regression at `repl-presentation-style.test.ts:1908` checks that
displayed characters remain a source prefix, then checks colours on a separate
short row. It never asserts the overflowing row's visible token colours.
Likewise, `pr1-evidence/audit.py` accepts a tag either in its roles **or** as a
single-colour row. Those are weaker expectations than the frozen handoff.

Preserve character order and the existing admitted row/rectangle while keeping
the semantic colours of characters that are visible. This does not request
multiline editing, new source wrapping/access behavior, generated-source
replacement or another renderer. The local rendering mechanics remain the
Implementor's decision. If the engine makes the frozen behavior impossible
within that boundary, return the concrete constraint for architecture resolution;
do not silently adopt an ordinary-source exception.

Extend the existing overflow regression to assert the visible delimiter, tag,
attribute/quoted value/reference roles, alongside its character-prefix checks.
Assert narrow field label/value separation on the existing populated form.
An overflowing focused row also retains its existing cyan focus cue. These
assertions enforce P1-T1–P1-T3, rather than expanding acceptance.

## R2: use independent literals for the frozen committed-cell expectations

The new P1 tests import production `REPL_PALETTE` and use it for expected RGB,
for example at `repl-presentation-style.test.ts:1443` and throughout P1-T1–P1-T4.
The handoff explicitly requires independent literal expectations derived from
the original archive. The implementation handback's statement that these
expectations are literals and none is imported from production is incorrect.

A production palette drift changes both drawing and the expected value, so
these tests can stay green while the original colour contract breaks. The
separate gallery audit contains literals but does not replace the required
named-rectangle regressions; it also permits R1's weaker source presentation.

Give the new frozen colour/surface assertions an independent reference fixture
or literal constants, with the archive hash and source provenance. Do not read
expected RGB from production helpers. Existing pre-PR1 tests do not need an
unrelated rewrite. Keep the character, rectangle and weight assertions and
correct the implementation handback's evidence description.

## R3: reproduce the frozen populated-question resize journey

The handoff freezes a populated project question drawer, its refusal at 60×15,
then its recovery at 160×36 with the same drawer and values. The submitted
`resize-recovered-160x36` shows **Permission · Write visual-review.txt**.
`pr1-evidence/journey.py:137` performs the resize inside `stage_permission`,
and the audit explicitly expects a Permission title for that capture.

That is a valid permission capture, but it does not prove recovery of the
editable question and its populated values. Replace the two resize endpoints
with the frozen project-question sequence. Preserve the same values and current
question across refusal/recovery, then inspect the actual restored frame and
existing controls. Keep the total at 35 pairs; no extra journey is required.

## Non-blocking observations

The reported first-field focus-ring and typing-to-last-selected-field defects
are pre-existing observations. Their interaction mechanisms are not introduced
by this presentation diff. They do not enlarge PR 1's scope, and this review
does not create a follow-up issue or require their repair. The later lifecycle,
generated-source and History contracts remain separate architecture work.

## Revision prompt

Revise PR 1 from `f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa` to satisfy R1–R3:

1. Correct overflowing-row presentation so visible classifiable characters keep
   the frozen roles and focus cue, without losing or reordering text. Preserve
   the current measured geometry, window behavior and one node/target per row.
   Extend the existing overflow and populated-form checks to reject single-colour
   fallback. Remove that exception from the audit and handback.
2. Replace production-derived expected RGB in the new P1 assertions with an
   independent archive-derived literal fixture. Preserve their existing behavioral
   assertions and correct the evidence description.
3. Capture the two frozen resize endpoints with the populated project question,
   retaining its values, rather than substituting a permission drawer.

Run the frozen three-file command, the applicable existing controls and the
overflow control, restore production bytes between controls, and rerun the
positive command plus `git diff --check`. Preserve first failures. Once the
focused evidence passes, create the feedback commit promptly and return its
exact SHA/parent and all commands/results. Capture the 35-pair gallery from that
revision, inspect every pair, and return corrected provenance, manifests and
checksums. Do not change the frozen criteria, add lifecycle/History work, wait
for CI, push or open a PR as part of this feedback revision.

Continuity: exact reviewed SHA `f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa`;
review artifact `.reviewer/issue-881/pr1-planner-review.md`; blockers R1–R3;
next Implementor action is the bounded revision above. This verdict does not
accept PR 1 or complete #881.
