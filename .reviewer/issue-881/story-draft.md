# Make `xmd repl` match the original Terminal Interface reference

Local planning copy of [#881](https://github.com/taras/executable.md/issues/881). This preserves the current Story; no GitHub edit is proposed. Status: product verification and adaptations await review.

## Story

As a person using `xmd repl`, I want the execution transcript, Agent sessions, bindings, drawers and History to match the original Terminal Interface reference, so I can recognize the program's structure and progress from what the terminal shows.

The common path is the original Evaluate/Plan journey: ask for a project README, follow nested work and generated XMD inline, enter project details, review the preview, and see the completed entry. The interface's colours, hierarchy and state indicators are part of that experience.

**Finish the original parity first. Features introduced by newer reference versions are outside this Story.**

## Pinned reference

Use [XMD REPL Terminal Interface corrected.zip](https://github.com/user-attachments/files/32939115/XMD.REPL.Terminal.Interface.corrected.zip), the older canonical archive [attached to Quest #827](https://github.com/taras/executable.md/issues/827#issuecomment-5943620150).

SHA-256: `86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`.

The attachment was downloaded and its checksum verified for this handoff. Do not substitute a newer Downloads archive or another mockup revision. The relevant files include `XMD REPL TUI.html`, `xmd-repl-timetravel.jsx`, `xmd-repl-agent-sessions.jsx`, `xmd-focus-map-study.jsx` and `xmd-journal-scrubber.jsx`.

The archive owns visual intent. Current accepted execution and interaction contracts in [the REPL specification](https://github.com/taras/executable.md/blob/main/specs/repl-spec.md) and [architecture](https://github.com/taras/executable.md/blob/main/architecture.md) own runtime behavior. A conflict needs an explicit Product Owner decision before implementation; it is not permission to add a capability from a mockup.

## Current gap

PR #878 delivered useful presentation changes, including semantic row colours, surfaces and emphasis. It did not establish complete parity with the reference.

At the inspected production revision, `2d719f78025059158a35023701fdff52b855a65b`:

- [The layout renders a row string through one text style](https://github.com/taras/executable.md/blob/2d719f78025059158a35023701fdff52b855a65b/packages/cli/src/repl/layout.ts#L728). The reference gives different tokens within XMD and JSON different colours.
- [Transcript rows flatten scopes and generated source into descriptions](https://github.com/taras/executable.md/blob/2d719f78025059158a35023701fdff52b855a65b/packages/cli/src/repl/application.ts#L3666). The reference shows nested rails, lifecycle glyphs and labels, source and replacement output as a structured execution.
- History is a textual list rather than the reference's horizontal rail with distinct entry boundaries, scope checkpoints, live head and inspected selection.

The focused `deno task test packages/cli/tests/repl-presentation-style.test.ts` passed: 7 tests and 25 steps. Its colour checks establish production styling consistency, not an independent match to the reference. A passing palette test cannot close this Story.

## Visual contract

Preserve the original reference's observable relationships across the supported terminal profiles:

1. **Colour within content.** Authored and generated XMD distinguish delimiters, tags, attributes, strings, references and prose. JSON bindings distinguish keys, strings, numbers, booleans, null and punctuation. Ordinary prose and output remain readable in their own roles. Known source is not reduced to muted metadata.
2. **Execution structure.** Nested scopes have visible indentation and rails. Entry, active, waiting, exit, settled and failed states have recognizable glyphs or words as well as colour. Generated XMD appears at the expression it replaces and remains distinct from rendered output.
3. **Coordinated surfaces.** Pane headings, edges, backgrounds, spacing, source/output emphasis, session states and selected bindings follow the original composition. Drawers preserve the hierarchy of titles, field labels, hints, values, validation, choices and read-only previews already supported by the product.
4. **History.** The footer presents the reference's rail, major entry boundaries and minor semantic checkpoints, with distinct live-head and inspected-selection indicators. The timeline uses actual known execution facts; mock elapsed durations are not fabricated as retained truth.
5. **Selection and focus.** A selected row or checkpoint stays identifiable when keyboard focus moves elsewhere. Focus remains visible without losing the meaning of syntax colours or lifecycle indicators. Colour alone never carries state.
6. **Terminal adaptation.** Compare at `160x36`, `120x30` and `72x20`. Retain the current fixed seven-row footer, including five History rows and the draft, and the drawer above it. Narrow composition shows its routed surface; absent surfaces have no focus, input or pointer targets. Resizing preserves route, selection, focus and draft, and an undersized terminal recovers when enlarged.

Browser pixel dimensions, variable font sizes and animation timings require terminal adaptations. Record each consequential adaptation explicitly; do not quietly redefine parity around whatever the implementation can already draw. Mockup source examples may be expressed in currently supported XMD without changing the language to make an animation executable.

## Product verification proposal

These representative comparisons carry the original journey into review. The Architect and Product Owner settle the scene mapping and any unresolved terminal adaptations before the Planner freezes implementation acceptance.

| Scene | What a person must recognize | Plausible incomplete result |
| --- | --- | --- |
| Empty REPL | Pane hierarchy, input and reachable History | A generic monochrome shell |
| Nested running Plan | Syntax colours, nesting rails and active lifecycle; Agent progress in Sessions | A single coloured summary row |
| Generated XMD admitted inline | Source replaces the producing expression and keeps token colours | Muted metadata or unrelated appended output |
| Project details and README review | Labels, hints, values, validation, decisions and preview hierarchy | A plain field list that happens to submit |
| Agent permission request | Waiting turn, then activated drawer with provider choices and duration | An automatically opened or misleadingly actionable historical request |
| Settled and failed entries | Distinct lifecycle, retained result and readable failure | Colour without an identifying state |
| Paused head and inspected checkpoint | Separate head and selection; coordinated historical panes | A list labelled History with no visual relationship to the reference |

Capture each scene at the three supported profiles, including the narrow route appropriate to that scene. Add a resize journey and one cold reconstruction of a retained scene: the latter contacts no provider and leaves the Journal byte-identical.

Publish reference frames and actual production-terminal captures together, with the reference checksum, exact production SHA, dimensions and scene identifiers. Link the artifacts from the implementation PR so another reviewer can inspect them without a private local gallery. Explain every remaining difference as an approved terminal adaptation or an unmet criterion.

Derive independent expected colours and visual relationships from the pinned reference. Demonstrate that removing token colours, nesting rails, lifecycle indicators or History structure makes the corresponding evidence fail. Preserve existing checks that the visible, focusable and pointer-reachable controls agree.

## Architecture boundaries

Apply the existing REPL ownership model: the Journal owns durable truth; immutable view data flows to components; typed semantic actions return to the root; Freedom owns focus; one measured and admitted keyed tree determines visible output and targets; the renderer remains model-blind.

Presentation adds no durable records, execution ownership, second terminal reader or provider activity during inspection. Historical projections contain only facts available at their selected prefix, and live-only Agent deltas never become retained truth.

## Planner handoff

Read this Story, Quest #827, `.agents/planner.md`, the mandatory repository instructions, `architecture.md`, `specs/repl-spec.md`, the affected executable-MDX specification sections and the pinned archive. Resolve current `main` and overlapping work; the inspected SHA above is evidence, not a permanently fixed implementation base.

Prepare a reference-to-production gap inventory and a proposed finite comparison matrix first. Bring unresolved visual adaptations or product-contract conflicts to the Architect and Product Owner. After approval, produce a decision-complete implementation plan and Implementor handoff, with reviewable delivery order, required documentation updates, discriminating tests and exact focused commands. Keep the Story's complete outcome separate from each PR's delivered slice.

Freeze acceptance before coding. Each implementation feedback handoff includes the exact stable commit SHA and every focused command run; delivery verification remains the separate repository gate.

## Relationships and exclusions

Child Story of Quest #827, building on delivered #870 and PR #878. Those deliveries remain historical records; this Story owns the original visual-parity gap.

Exclude features from newer mockup revisions, fork semantics, broader session management, additional form/schema capability, new persistence or timing protocols, and a general UI framework or renderer replacement. None is a prerequisite for finishing this parity.
