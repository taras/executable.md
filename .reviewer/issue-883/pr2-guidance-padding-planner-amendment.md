# Keep directions readable and inset the Sidekick body

**Released, 2026-10-15.** The Product Owner approved wrapping guidance/refusal
explanations and also requested padding around Sidekick chat. This amendment
resolves [the returned width conflict](pr2-pane-width-implementor-conflict.md)
and adds two horizontal terminal cells of padding on each side of the Sidekick
body. The amount is the Planner's concrete implementation of the padding
request. No further product decision is delegated to the Implementor.

Execute this with the active
[composer prompt](pr2-sidekick-message-composer-implementor-prompt.md),
[composer plan](pr2-sidekick-message-composer-planner-addendum.md) and
[equal-width amendment](pr2-sidekick-pane-width-planner-addendum.md).
Keep the equal outer widths and six-visible-value-row cap. Preserve in-flight
work and return one combined signed feedback commit.

## Exact state

Committed base remains accepted `25227d38cb8087743cd404533c7960de9423a442`,
parent `13c4900dbf0c4e57411241ada84aa00f4b55ba65`, branch agent/issue-883-pr2,
signature G / tarasm@gmail.com. Composer and width changes are preserved in
the dirty implementation worktree. No feedback commit is offered yet. Verify
the actual head/work before continuing; no reset, amend, rebase or discarding
those changes. Do not start another Implementor in the same paths.

The [Planner assessment](pr2-pane-width-guidance-planner-assessment.md)
preserves the confirmed guidance and normal-sized refusal failures. Its first
outputs remain historical evidence. This approved amendment supersedes its
pending resolution and the earlier instruction to hold.

## 1. Wrap contextual guidance without losing its directions

Contextual guidance is one inert block with the measured rows its existing
words need. This explicitly amends the former one-physical-row contract.
State stays first. The Enter action, way back, movement hint and modal-close
instruction remain visible when applicable; no required instruction is
ellipsised or dropped to satisfy the old row budget.

Use the existing full vocabulary in wide/medium and existing compact vocabulary
in narrow. Add no third wording. Word-wrap through the existing engine fitter,
keeping whole words where possible and grapheme-safe cuts where needed. This
preserves the existing first-use wording and pointer equivalence rather than
quietly shortening them because the Transcript now has fewer columns.

Retain the guidance identity and its lack of focus/input authority. Its real
height is part of measurement and chat/reading admission before commit. Each
physical row fits its measured region, and text cannot paint over a reading,
another pane or a control. Preserve the fixed seven-row footer.

At 72x20 the existing compact sentences that already fit remain one row; their
meaning and spelling need no change. At wider profiles the block can now use
more than one row instead of suppressing words. Adapt R6 and first-use readers
to observe the actual displayed block rather than require all its words on one
physical row. Do not derive their answer from the model or guidance formatter
instead of reading the committed display.

## 2. Word-wrap cold-open refusal explanations

Cold-open refusal text already spans rows through fixed code-unit chunks.
Replace that slicing for this surface with engine-measured, word-aware fitting.
Keep the original reason, its applicable focus/back control and visible Exit.
Continuation rows add no independent focus stops. A reason crossing rows is
still the same refusal; leaving it still reports failure and appends nothing.

The UI2/J1 assertions can read phrases across the explanation's owned displayed
rows. Preserve their actual reason, visible legitimate control, no-history/
session side effects and cleanup observations. A phrase is not required to land
on a single physical row after this approved wrapping change.

This does not change the separate footer action-refusal policy or bounded
failed-entry reason. Those intentionally shortened surfaces remain out of
scope. No generic error viewer, new scroll control or persistence change is
assigned.

## 3. Two-cell horizontal padding for the Sidekick body

Use two cells on the left and two on the right, inside the existing pane edge.
Apply this inset to the chat viewport and its window controls, the message
label/value block and the controls/announcements below the chat. No vertical
padding is added. Headers, tab rows and header edges remain full-width.
Bindings keeps its existing body layout. The narrow Sidekick outlet gets the
same horizontal inset, while other narrow readings remain unchanged.

The question and Configure drawers retain their accepted whole-pane rectangle
and their own existing inset. Do not shrink them to the chat-body rectangle.

The outer widths remain the accepted equal split. The body widths below are
after the existing pane edge and the new four-cell horizontal inset:

| Frame | Right outer start / width | Existing pane content width | Padded Sidekick body start / width |
| --- | --- | ---: | --- |
| 160x36 | 96 / 64 | 63 | 99 / 59 |
| 120x30 | 74 / 46 | 45 | 77 / 41 |
| 161x36 | 97 / 64 | 63 | 100 / 59 |
| 72x20 Sidekick outlet | 0 / 72, without a pane edge | 72 | 2 / 68 |

These are independent expected geometry values. Production obtains actual
content width from the padded inner container the engine measures, just as it
already measures border-free pane content. Keep whole-pane/header widths
separate from body width; do not make the header narrower by reusing the body
answer for it.

All chat/composer fitting, row counts, scrolling, hit targets and Sessions
reveal use that same padded body width. Padding is geometry, not added message
bytes. Preserve existing literal leading spaces in chat formatting and text;
do not strip them or insert gutter whitespace into saved values. Gutter cells
carry the pane's existing surface color and contain no body text/targets.

The six-row composer policy is unchanged. Compute its small-screen cap using
the actual minimum-composer frame after fixed content and the new horizontal
geometry are accounted for. Its value still sends the original string exactly
once. Per-chat reading/following and explicit Sessions reveal remain intact.

## Implementation boundary

Use the existing application.ts/program.ts/fitting.ts/layout.ts preparation and
component flow. A private measured body-width value and prepared guidance/
refusal rows have concrete consumers here; ordinary helper/data-shape mechanics
are delegated. The committed and measuring trees describe the same insets and
heights. No convergence loop, fractional renderer-bound rounding or validator
exception.

RS4's changed-line-alone comparison must use the actual padded body width,
not the former whole-pane inspection width. Preserve its exact reuse claim.

Keep separate owned fitting stores from evicting one another. If retaining
guidance/refusal/composer cuts, do not settle those line sets into the chat's
store. Preserve RS2–RS5's comparisons for unchanged history; final widths can
change absolute measurement counts. No notification, provider, entry admission,
journal, configuration or URL change is assigned.

Align specs/repl-spec.md and architecture.md with the contextual guidance block,
cold-open word wrapping, padded Sidekick body, equal widths and measured
composer. Preserve archived visual reference bytes/digests and accepted colors.

## Frozen additional evidence

These observations amend existing rows rather than create another matrix.

| Row | Required observations |
| --- | --- |
| G1 — complete body explanations | Adapt R6 across its existing wide/medium/narrow frames: every physical guidance row fits, the complete displayed block keeps state/Enter/way-back with no ellipsis, and rows below are not overwritten. Keep UI1/UI8's actual navigation wording/action claims. UI2/J1 read the cold-open explanation's real word-wrapped rows and keep their reason, Exit/Control-C, refusal outcome, byte-identical history and cleanup claims. No required direction becomes optional. |
| P1 — padded Sidekick content | Extend PW1's existing committed bounds/cell checks with the exact two-cell body inset at 160x36 and 120x30; retain the odd-width and both-tab outer geometry assertions. MC5/MC7 also show the 72x20 inset. Chat text, composer value and body controls stay within that width, gutters remain blank, headers remain full-width, and the seven-row footer stays intact. Existing MQ4/CFG6 still occupy their full accepted pane above the footer. |

Retain MC5–MC7 and PW1–PW2. Adapt helpers and assertions to current field/block
geometry without deleting their claims. When a phrase wraps, observe its owned
display rows. If an overflow fixture no longer exercises overflow, extend it
rather than omit that observation. Report every adaptation.

## Focused commands and feedback

Run the same three combined selections, unchanged:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-presentation-style.test.ts
deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
```

No new mutation battery, broad lint/check/JSR, full runtime suite, dependency/
cache/lock repair, flake repair, push, GitHub write, CI inspection or capture is
added. Preserve first failures. Historical one-row probes are not rewritten;
the permanent adapted assertions govern the approved presentation change.

Continue autonomously through the finite combined assignment. Commit promptly
when the three selections pass. Hand back one signed SHA/parent, clean state,
commands/results, MC5–MC7/PW1–PW2/G1/P1 mapping and all fixture/assertion
adaptations. Stop for review of that exact commit.

## Continuity

Base: accepted 25227d38 with preserved uncommitted composer/width work.
Produced: this released resolution, updated prompt/plans and readiness.
Settled: wrap existing body guidance/refusal wording, keep equal outer widths,
two-cell Sidekick body padding, existing drawer envelopes and six-line composer.
No unresolved product or architecture decision remains. Next Implementor
action: resume with this amendment and return one combined signed feedback
commit. Prior acceptances stay closed; teaching, the 36-frame packet and delivery
remain separate. This planning task changes no production source.
