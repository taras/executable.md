# Match Transcript and Sessions to Sidekick's body padding

**Completed: [PASS at 6ca23952](pr921-padding-planner-review-6ca23952.md).**
Matching body padding, the approved 36-column sidebar and BP1–BP5 are accepted.
Earlier holds and continuation instructions below are historical. The separate
silent-reply correction is next, before restacking.

**Current release: include this UI work in delivery.** The Product Owner has
approved sidebar width 36 at both profiles. Execute the
[approved continuation](pr921-padding-width-approved-continuation-27da762b.md)
in the preserved worktree, finish BP1–BP5 and the three selections, and return
one signed successor before restacking. Earlier park/hold instructions below
are historical and superseded by that release; there is no pending width choice.

**Parked by the Product Owner's feature freeze.** The
[final delivery assignment](pr890-pr921-final-delivery-implementor-handoff-27da762b.md)
supersedes this continuation. Preserve its uncommitted work in a recoverable
snapshot; deliver the accepted 27da762b source. The pending product question is
not a delivery blocker and this document authorizes no further UI work during
the restack/delivery assignment.

**Visual correction addendum:** the
[heading/color instructions](pr921-padding-header-colors-planner-addendum-27da762b.md)
release a two-cell Transcript title inset, header-colored top space above
Transcript/right-pane tabs, and pane-colored Earlier/Later controls. These
supersede the earlier flush-title and body-colored-gap expectations. The
sidebar width decision below remains pending; preserve the current work.

**Continuation held on the returned width conflict.** Preserve the current
uncommitted work and its patch at 27da762b. The
[prepared width amendment](pr921-body-padding-width-planner-amendment-27da762b.md)
recommends a 36-column sidebar at both wide and medium, but its product choice
is pending. Do not deliver a truncated state, discard the sidebar inset, or
cross that width decision under the original fixed-width assignment.

Follow `.agents/implementor.md`. Continue in the existing PR2 worktree from
accepted `27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`. Add two cells of horizontal
padding on each side of the Transcript and sidebar bodies, matching the
Sidekick body. This bounded UI continuation is released by the Product Owner's
request that Transcript and Sessions have the same padding.

## Applies to

The wide and medium shared-column REPL screen. This is presentation geometry;
it changes neither entry source nor Sidekick replies, records or providers.

The request is interpreted as matching the existing Sidekick **body** inset.
The accepted one-row top gap and full-width heading bands remain. This is a
successor to the [accepted header cleanup](pr921-ui-headers-planner-review-27da762b.md),
not a reopening of that verdict.

## Base and ownership

- Branch: `agent/issue-883-pr2-main-integration`.
- Worktree: `.claude/worktrees/issue-883-pr2`.
- Verified base: `27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`, signed G,
  clean when this assignment was prepared.
- The existing designated Implementor remains the sole writer. Continue in the
  same session if available. Preserve the base and all ancestors and safety refs.
- Replacement PR1 remains accepted at 85da74b9. The integration acceptance at
  7613cddf and header acceptance at 27da762b remain closed.

## Observable behavior

1. At wide and medium, each Transcript body row starts two cells inside the
   Transcript's border-free inner column and ends two cells before its other
   side. Include the contextual guidance/refusal, retained reading and its
   earlier/later controls. The Transcript heading band and its edge span the
   same full inner width as before.
2. Apply that same inset to the sidebar's Sessions list and its controls. The
   Entries list and controls share this sidebar body treatment, so its two
   groups align. Sessions and Entries headings keep their existing full-column
   placement; no second top gap is added above Entries.
3. The empty gutters carry the column's own background, contain no text and
   are not included in any row's pointer target. Use real layout padding rather
   than leading spaces or shifted painted text.
4. Outer column widths and dividers do not move. Header bands, horizontal tabs,
   P=1, the seven-row footer, both composers, Sidekick's existing two-cell inset,
   Bindings and pane-local Sidekick drawers retain their accepted treatment.
5. Narrow keeps its existing routed-outlet layout. It gains no new Transcript
   or Sessions padding. The Sidekick's existing narrow body inset is unchanged.
6. Text fits the actual measured body width. Wrapping is display only: no
   retained source, message, route identity or record changes. More wrapped
   rows remain reachable through the existing window controls. The whole
   contextual guidance remains visible above route drawers under the accepted
   measured-envelope rule, including when the new inset makes it wrap further.

```text
full-width heading band
-----------------------
  body text and controls
  body text and controls
^^                    ^^
two cells on each side
```

## Current boundary and implementation order

`layout.ts` owns `sidekickBodyProps()` and `SIDEKICK_GUTTER = 2`.
`application.ts` wraps the Sidekick body in a padded outer box and publishes its
inner box for measurement. Transcript and sidebar currently have no matching
horizontal body inset. Their headings and body rows share the surface/list
widths, so adding padding alone would leave rows built wider than their space.

1. Add the body wrappers in `application.ts` and the needed layout props in
   `layout.ts`. Keep heading bands outside the inset. Reuse the existing padding
   pattern; ordinary private names and argument threading are implementation
   choices. Do not export a testing or layout API solely for this change.
2. In `program.ts`, obtain each padded body's width from its inner engine box.
   Keep the pane/header width and body width distinct. Guidance/refusal fitting,
   retained reading fitting, sidebar label fitting, row boxes, window counts
   and targets must all use the width of the body that actually contains them.
   Do not subtract four in a second independent calculation or let a generic
   region lookup pick an arbitrary body box as the header's width.
3. Carry the measured body widths through the existing preparation/context.
   Keep the measurement/drawing engine separation and exact-input fit reuse.
   Width changes invalidate the corresponding cuts through their existing
   keys. The guidance envelope continues to read the actual fitted block's
   measured bottom; do not replace it with a fixed row count or add a loop.
4. Add the finite evidence below, adapt affected geometry expectations and
   update the directly affected spec/architecture paragraphs.

Production scope is `packages/cli/src/repl/{layout,application,program}.ts`.
No renderer, engine/vendor, input, route codec, lifecycle, provider, storage or
Core change. A layout refusal or consumer error stays an error; no validator is
weakened to accommodate the inset.

## Frozen evidence

| Row | Evidence | Destination |
| --- | --- | --- |
| BP1: matching bodies | At 160x36 and 120x30, committed geometry/cells show two-cell left and right gutters for Transcript, Sessions and Entries bodies, matching Sidekick. Headings, tab band, full header edges and outer column bounds keep their accepted geometry. Populated rows and pointer targets stay inside the measured body; gutter cells are blank and carry their pane surface. | `repl-presentation-style.test.ts`, existing presenter |
| BP2: fitting and capacity | A populated retained reading with a line that now wraps keeps its exact text, blank lines and order across its prepared rows. The reading and Sessions windows have positive measured room above the seven-row footer; actual controls reach content outside the window. Existing UH5 checks continue to prove that every fitted guidance row clears History, including a wrapped block. | style tier plus existing source-reading/layout-admission and mounted journey evidence |
| BP3: mounted consumers and recovery | Through the existing mounted program, reach a Sessions selection and scroll the Transcript using their actual controls at wide/medium. Both composer values survive and the selected reading is still the requested one. Resize through narrow and back: no new narrow inset, and the shared-column gutters return. Existing ordinary and Sidekick journeys, forms and question ownership remain green. | `repl-sidekick-presentation.test.ts` and the existing ordinary journey/form selection |

Use representative rows, not a new provider/runtime matrix or capture packet.
Pure presenter geometry and mounted behavior may split a row's claims. Reuse
the existing host and terminal fixtures. No mutation battery is required.

## Permitted test adaptations and failure handling

Existing full-body-width assertions may distinguish full-width headings from
inset body rows. Keep their boundary and target claims. Update literal body
width/X expectations to the new accepted two-cell inset, while preserving the
outer column expectations and header-edge colors.

If a narrower body requires more scrolling, reach the same exact retained text
through the correct window's real control. Preserve content and reconstruction
claims; do not replace them with truncated strings, journal-only assertions or
matches left over from earlier terminal frames. Prefer the measured/drawn frame
to a copied coordinate. Do not weaken no-input wakeup assertions or form focus
ownership to get a pass.

Capture each first failure before retrying. If the inset reveals a genuinely
incompatible accepted product contract that scrolling or proper fitting cannot
satisfy, return the specific conflict with the preserved work rather than invent
new wording, remove a required control or reduce the footer. The known EH1/UI10
delivery repairs remain separate; they are not newly waived by this assignment.

## Focused feedback commands

Run these three selections on the final tree:

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

They passed at the base with 28/109, 44/170 and 71/185 respectively. Add the
finite BP evidence without changing unrelated claims. Check/lint, the full
runtime suites, JSR and CI are not added as feedback prerequisites.

Once this evidence passes, promptly create one signed feedback successor.
Return SHA/parent/tree/signature, every focused command and result, BP1–BP3
mapping, fixture/assertion adaptations and preserved first failures. Stop for
review of that exact commit. No push, PR mutation, CI inspection or capture.

## Continuity

Base: accepted clean 27da762b. Produced: this released plan and Implementor
handoff. Settled interpretation: two horizontal body cells per side to match
Sidekick, with existing headings/top gap retained. No blocker is identified in
the inspected layout boundary. Next action: the designated Implementor executes
this finite padding continuation in the existing worktree.

History self-stacking, readable conversation labels, the narrow pending-question
layout, EH1/UI10 delivery repair, Parse #922, teaching, captures and publication
remain separate. No production file or branch was changed by the Planner.
