# Padding and header surfaces: PASS at 6ca23952

The shared body padding, Transcript title inset, header-colored top space,
pane-colored navigation and 36-column sidebar satisfy BP1–BP5. No padding
correction remains. The separate control-only reply correction is next, before
the delivery restack.

## Exact revision

- SHA: `6ca239527abe9d012be01fffc79197e882c52ca3`.
- Parent: `27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`, preserved.
- Tree: `d4723eecaccf17892c341f773330ff19ff3e927b`.
- Signature independently verified: G, tarasm@gmail.com.
- Branch: `agent/issue-883-pr2-main-integration`.
- Worktree: `.claude/worktrees/issue-883-pr2`, clean throughout this review.

Reviewed against the [approved continuation](pr921-padding-width-approved-continuation-27da762b.md),
[width ruling](pr921-body-padding-width-planner-amendment-27da762b.md),
[styling addendum](pr921-padding-header-colors-planner-addendum-27da762b.md)
and [Implementor handback](pr921-padding-width-implementor-handback-6ca23952.md).

## Independent verification

Each frozen command ran once against this exact tree and exited 0. First outputs
are retained; no failed invocation was discarded or rerun.

| Selection | Result | First output |
| --- | --- | --- |
| presentation-style / layout-admission / source-reading | 30 tests / 112 steps, zero failures | [command 1](pr921-padding-review-6ca23952-command-1-first.log) |
| Sidekick presentation / journey / lifecycle / configuration | 44 tests / 171 steps, zero failures | [command 2](pr921-padding-review-6ca23952-command-2-first.log) |
| agent-interface / agent-journey / journey / forms | 72 tests / 186 steps, zero failures | [command 3](pr921-padding-review-6ca23952-command-3-first.log) |

Total: **146 tests / 469 steps, zero failures**.

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

`git diff --check 27da762b 6ca23952` exits 0. Check and lint are reported green
by the Implementor; they were not independently repeated and are not conditions
on this feedback verdict. No CI was inspected.

## Why the evidence is sufficient

BP1/PW establish the actual shared-column geometry and gutter cells at wide
and medium, plus the independent odd-width table. Sidebar/Transcript/right are
36/62/62 at 160, 36/42/42 at 120 and 36/63/62 at 161. The band remains full
width while the title moves inside it. Source inspection confirms row widths,
fitting and window admission read the measured body rather than the outer pane;
existing layout/target checks remain in the selected corpus.

BP2 reaches wrapped retained content through the real reading window, and the
source-reading selection protects retained text and ordering. BP3 drives the
mounted controls, both composers and resize round trip. Narrow body lookup uses
each body's own id, falling back to its pane, so the Sidekick's narrow body
cannot silently supply the Transcript's width through their shared region.

BP4 uses the existing three-turn fixture and measured presentation labels at
both sizes: the longest unrecorded state and recorded state remain whole, every
turn label ends in a complete state, the three labels remain distinct, and
the filtered All control is whole after a real filter action. Together with
the independently checked body geometry, this resolves the returned width
conflict at medium as well as wide.

BP5 checks the title, complete header edges, top-row surfaces under both tabs,
pane navigation with and without focus, and the ordinary Exit surface as a
positive control. Source inspection confirms all eight pane navigation
descriptions use the semantic role, while the fitting-catalog fixture correctly
has six visible controls. Drawer scrollers and generic actions are unchanged.

The implementation stays in the assigned presentation modules. It changes no
renderer/input protocol, evaluation, admission, provider or saved history.
The complete measured guidance-envelope checks and existing form ownership
rows remain green.

## Adaptations and limits

The three screen-slicing helpers now use the layout's width functions to read
the correct pane; PW retains the independent literals that prove those widths.
These helpers observe geometry rather than validate its policy.

J3 closes History for the underlying positive and negative content assertions,
then reopens it for its own rows. The two entry-selection assertions likewise
move the covering layer aside without changing the selected position. This
restores their ability to distinguish prefixes rather than relying on modal
occlusion. Exact expected text and reconstruction claims are retained.

The no-space token is observed by joining current Transcript rows only, with
their enclosure decoration removed. Its narrow helper is confined to that
distinctive unbroken token; ordinary prose keeps its existing joining helper.
Other retained outputs are reached through their own window controls, not read
from history in place of the screen.

Medium source text has less horizontal room and wraps more. That is the
accepted width tradeoff; its content remains reachable. This review establishes
the finite padding criteria, not #931 mockup alignment or a capture packet.
Earlier failures/isolation logs stay preserved. The EH1/UI10 delivery obligation
remains separate and is not waived by this PASS.

## Next action

The padding start gate is closed successfully. The same designated Implementor
may now execute [the control-only reply handoff](pr921-control-only-replies-implementor-handoff.md)
from exact 6ca23952, in a separate signed successor. Do not begin the delivery
rebase until that presentation correction is reviewed. The delivery head must
include both accepted padding and the reviewed correction. PR1 remains accepted
at 85da74b9; recheck current main at the later restack boundary. No branch was
rewritten or pushed by this review, and unrelated worktrees were not changed.
