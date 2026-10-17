# Header cleanup: PASS at 27da762b

The horizontal Bindings/Sidekick header, single labels and one blank row above
the three shared-column headings satisfy UH1–UH5. Route drawers leave the whole
measured guidance block visible. No correction remains under this assignment.

## Exact revision

- Reviewed SHA: `27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`.
- Parent: `7613cddf4f8478b905d6a56d67fb0aa9a2588d25`, preserved.
- Tree: `8eabb472fd49a753c34af034b1d173d49ea9a054`.
- Signature independently verified: G, tarasm@gmail.com.
- Branch: `agent/issue-883-pr2-main-integration`.
- Worktree: `.claude/worktrees/issue-883-pr2`, clean when inspected.

Reviewed against the [header plan](pr921-ui-headers-planner-handoff-7613cddf.md),
[guidance amendment](pr921-ui-headers-guidance-planner-amendment-7613cddf.md)
and [Implementor handback](pr921-ui-headers-implementor-handback-27da762b.md).

## Independent evidence

All three frozen commands ran once against the exact reviewed tree. Their first
outputs are retained; no failure or rerun was discarded.

| Selection | Result | First output |
| --- | --- | --- |
| presentation-style / layout-admission / source-reading | 28 tests, 109 steps, zero failures; exit 0 | [command 1](pr921-ui-headers-review-27da762b-command-1-first.log) |
| Sidekick presentation / journey / lifecycle / configuration | 44 tests, 170 steps, zero failures; exit 0 | [command 2](pr921-ui-headers-review-27da762b-command-2-first.log) |
| agent-interface / agent-journey / journey / forms | 71 tests, 185 steps, zero failures; exit 0 | [command 3](pr921-ui-headers-review-27da762b-command-3-first.log) |

Total: **143 tests / 464 steps, zero failures**.

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

`git diff --check 7613cddf 27da762b` also exits 0. The Implementor reports check
and lint exit 0; those commands were not independently repeated and are not
conditions on this feedback verdict. CI was not inspected.

## Acceptance and adaptations

UH1 is observed in committed cells, bounds and targets at wide and medium,
under both active readings. The tab band spans the inner column; its children
take their own label widths. The duplicate title and selected suffix are gone.
The active style remains distinct while the other tab holds keyboard focus.

UH2/UH4 use the mounted program and existing terminal fixture for activation,
resize and retained composer values. The selected-pane helpers observe the
displayed body instead of matching a tab label that is always present. Existing
question notification, form ownership and narrow-profile rows remain green.

UH3 uses actual padding in the three shared columns, with no described row or
target in the gap. The lower Entries group receives no second padding. Existing
width, inset, composer, footer, header-edge and window checks remain in the
selected corpus.

UH5 measures every published guidance row and checks its cells and extent
against the committed History layer at 160x36, 120x30 and 200x60. At least one
case wraps. The old horizontal bounds and bottom edge remain; its window has
room and reachable controls. A mounted row opens History and closes it with one
Escape while preserving both texts and the selected reading.

Source inspection confirms the rectangle is settled after fitted guidance is
measured, with one extra measurement when the envelope moves. It is carried
through subsequent composer measurement, final window admission and presentation.
The shared route layer reads that same rectangle. Narrow and pane-local Sidekick
drawers retain their existing rules. No renderer, input, provider or durable
record change is introduced.

The drawer helper reads the drawn top rule within the retained horizontal
envelope. It does not search for the word History or duplicate guidance fitting.
All three Decision: approve sites reach the same exact output through the
transcript's own scroll control. G5 retains opacity and horizontal/bottom checks;
D1 reads its answer-label styling in the scrolled frame where it is now visible.
These adaptations preserve the original claims. The five earlier failures and
P=0 isolation remain historical evidence, not an accepted failing baseline.

## Continuity

The header assignment and its continuation are complete at this SHA. Replacement
PR1 remains accepted at 85da74b9; replacement PR2 integration remains accepted at
7613cddf beneath this successor. No additional header successor is assigned.

The designated Implementor holds the clean 27da762b head. History self-stacking,
conversation labels, the narrow pending-question layout, EH1/UI10 delivery repair,
Parse #922, teaching, captures and delivery/publication remain separate. This
review writes only reviewer records and authorizes no push, GitHub mutation or
new implementation slice.
