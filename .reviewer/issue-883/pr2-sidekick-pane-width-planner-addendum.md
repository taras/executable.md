# Give the Sidekick half the space after the sidebar

**Guidance conflict resolved; padding added:** execute
[the released resolution](pr2-guidance-padding-planner-amendment.md) with this
width amendment. The Product Owner approved wrapping guidance/refusal
explanations and requested Sidekick padding. Equal outer widths remain;
the new two-cell inset creates a separately measured Sidekick body width.
Preserve in-flight work and resume the combined assignment. No decision remains
pending. G1/P1 extend existing evidence under the same three commands.

**Released, 2026-10-15.** The Product Owner approved splitting the space after
the sidebar equally between Transcript and the right pane. This adds the width
change to the already-released
[composer assignment](pr2-sidekick-message-composer-implementor-prompt.md).
Preserve the in-flight composer work and return one combined feedback commit.
No width decision remains pending.

## Base and current work

Committed head remains accepted `25227d38cb8087743cd404533c7960de9423a442`,
parent `13c4900dbf0c4e57411241ada84aa00f4b55ba65`, branch agent/issue-883-pr2,
signature G / tarasm@gmail.com.

The implementation worktree currently has in-flight composer edits in
production modules, fixtures, tests, architecture.md and specs/repl-spec.md.
The tree is not clean. This planning
task edits none of that work. Verify the actual head/work before continuing;
do not reset, restage unrelated changes, discard work or start a second
Implementor in the same paths.

The existing inspectionWidth fixes the right column at 36 in wide and 28 in
medium. Sidebar widths are 32 and 28, with Transcript taking the remainder.
This accepted amendment replaces those right-column widths. The previously
accepted colors, edges, header bands, seven-row footer and narrow outlet remain.

## Exact width rule

For wide and medium, let S be the existing sidebar width for this frame.
The right column gets floor((terminal columns - S) / 2); Transcript grows into
the remainder. These are outer column widths. An odd spare cell goes to
Transcript, avoiding fractional geometry.

| Frame | Sidebar | Transcript | Right pane | Right starts at |
| --- | ---: | ---: | ---: | ---: |
| 160x36 | 32 | 64 | 64 | 96 |
| 120x30 | 28 | 46 | 46 | 74 |
| 161x36, odd-width witness | 32 | 65 | 64 | 97 |

The actual engine still accounts for each pane's divider and content inset.
Do not fit text to an outer width; chat, composer and entry reading use their
measured inner widths.

This rule scales with available terminal width, rather than adding new fixed
64/46 constants. Keep the existing profile thresholds and sidebar widths.
Narrow still uses one full-width selected outlet. No new route member, resizer,
CLI option or stored width is introduced.

Bindings and Sidekick share the wider right column. Switching tabs changes
neither column width nor source of the geometry. The Sidekick question and
Configure drawers use the existing sidekickDrawerRect and stay inside that
same wider pane; ordinary route drawers retain their existing behavior.

The six-visible-value-line composer cap and its measured small-screen reduction
remain as released. Width changes alter wrapping, not message bytes. Current
and manual chat reading, Sessions reveal, focus and both drafts keep their
existing ownership. The accepted fitting stores invalidate naturally on new
measured widths and still reuse unchanged text at a stable width.

## Implement in the existing slice

1. Change inspectionWidth in layout.ts to derive this integer share from the
   existing sidebar width. Reuse the existing layout flow so the column,
   drawer rectangle and measurement read one width rule. Do not use fractional
   percentages or round renderer bounds after the fact.
2. Keep the composer implementation and its MC5–MC7 work. Its field and chat
   fit against their actual new content widths; preserve the final measured
   height and admission contract.
3. Update independent expected pane envelopes and mounted targeting helpers.
   Existing tests use starts 124/92; the new accepted starts are 96/74 at the
   reference sizes. INSPECTION_FROM and literal click searches also need an
   audit. Expectations come from the accepted table, not inspectionWidth or
   another production helper. Ordinary reusable test-fixture mechanics are
   delegated.
4. Preserve every existing test's claim while adapting its coordinates or
   label/value observation. If widening removes a fixture's intended overflow,
   extend that fixture enough to exercise wrapping/scrolling again rather than
   deleting the assertion. Report all such adaptations.
5. Align specs/repl-spec.md and architecture.md with equal sharing, odd-cell
   allocation and the wider drawer envelope. Keep existing palette references
   and archived captures/digests intact. The terminal width amendment is a
   product decision, not a rewrite of the browser's historical pixels.

layout.ts is added to the active production diff for this width rule; it was
already allowed by the composer plan. No Core/provider, journal, admission,
configuration or notification change is assigned.

## Frozen width evidence

Use existing style/layout and mounted destinations. These two observations
extend the composer matrix without duplicating its journeys.

| Row | Required observations |
| --- | --- |
| PW1 — actual column geometry | In repl-presentation-style.test.ts, directly read committed column/header/content bounds at 160x36 and 120x30 under both tabs against the independent table. Verify the sidebar, right start/width and Transcript width, full header edges, unchanged footer and disjoint panes. Add one 161x36 frame to prove the spare cell goes to Transcript and geometry remains integral. Existing narrow/refusal cases preserve their claims. |
| PW2 — fitted content and pane-local drawers | Adapt existing MC5–MC7, MQ4 and CFG6 rows to the accepted new envelope. Composer/chat text fits the new measured inner width, and question/Configure drawers and their targets stay in that pane above the footer. Preserve hidden-form ownership, partial values, close behavior, resize/recovery and per-chat reading. Reuse those real journeys; no second host or extra drawer matrix is needed. |

Keep RS2–RS5: the narrower Transcript and wider chat get their current measured
fits, and unchanged chat still adds no history-sized fitting cost to a key.
Expected counts may reflect the new widths; preserve the comparisons that
establish reuse rather than pinning historical absolute counts.

No new mutation battery or historical-probe rewrite is assigned.

## Exact focused commands

These are the composer plan's three selections, with source-reading added to
the third because Transcript's actual width also changes. Run against the final
combined tree:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-presentation-style.test.ts
deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
```

No full suite, broad lint/check/JSR, dependency/cache/lock repair, flake repair,
push, GitHub write, CI inspection or capture is added. Preserve first failures.
Continue autonomously through the combined finite assignment and commit when
this focused evidence passes. Hand back one signed SHA/parent, clean state,
MC5–MC7/PW1–PW2 mapping, commands/results and all fixture/assertion adaptations.
Stop for review of that exact commit.

## Continuity

Base: accepted 25227d38 with preserved in-flight composer work. Produced: this
released width addendum and updated composer prompt/plan and readiness.
Settled: equal sharing after the sidebar, odd cell to Transcript, one width
under both tabs, existing narrow/footer behavior and the approved six-row
composer. No unresolved product or architecture question remains. Next
Implementor action: incorporate this amendment into the current composer work
and return one combined signed feedback commit. Prior acceptances stay closed;
teaching, the 36-frame packet and delivery remain separate. No production edit,
commit, push, GitHub mutation, CI or capture occurred in this planning task.
