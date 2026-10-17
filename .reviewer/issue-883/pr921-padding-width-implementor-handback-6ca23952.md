# The padding slice, finished at a 36-column sidebar

Implementor handback for
[the approved width continuation](pr921-padding-width-approved-continuation-27da762b.md)
and [the width amendment](pr921-body-padding-width-planner-amendment-27da762b.md).
The width decision is applied, BP4 is added, BP1–BP3 and BP5 are retained, and
all three frozen selections pass.

## The successor

```
SHA     6ca239527abe9d012be01fffc79197e882c52ca3
parent  27da762b7078ee8e32b1dbaf90941c4a8a90eaa7
tree    d4723eecaccf17892c341f773330ff19ff3e927b
sig     G, tarasm@gmail.com
subject 💄 Match the REPL's three column bodies, and widen the sidebar to hold them (#883)
```

Worktree clean, nothing untracked. Not pushed. `agent/issue-883-pr2-main-integration`
now `6ca23952`; `agent/issue-883-pr1-main-integration` `85da74b9`,
`agent/issue-883-pr1` `79d404d0`, `agent/issue-883-pr2` `d4b0e326`,
`agent/issue-883-pr2-isolated` `99c27d92` and
`pre-integration/issue-883-pr2-d4b0e326` all unmoved. Both accepted bases
`27da762b` and `85da74b9` remain reachable.

## Results

| Command | Result |
| --- | --- |
| 1 — presentation-style, layout-admission, source-reading | **30 passed (112 steps), 0 failed**, exit 0 ([log](pr921-width-wf-cmd1.log)) |
| 2 — sidekick presentation, journey, lifecycle, configuration | **44 passed (171 steps), 0 failed**, exit 0 ([log](pr921-width-final-cmd2.log)) |
| 3 — agent-interface, agent-journey, journey, forms | **72 passed (186 steps), 0 failed**, exit 0 ([log](pr921-width-final-cmd3.log)) |

`deno task check` exit 0. `deno task lint` exit 0, warnings only, dead-code gate
included ([log](pr921-width-wf-lint2.log)). Commands 2 and 3 were run again
after two comment rewordings, so every result above is the committed tree.

Earlier failure and isolation logs are preserved unchanged:
[the first padding run](pr921-body-padding-bp-cmd1-first.log),
[command 3 at the conflict](pr921-body-padding-bp-cmd3-fourth.log),
[the Transcript-only isolation](pr921-body-padding-bp-nosb-cmd3.log) and
[the P=0 isolation](pr921-ui-headers-gap0-cmd3.log).

## The width, as measured

Asked of the implementation, not of the table:

```
160x36  sidebar=36  transcript=62  right=62  rightStartsAt=98  body=32  room=30
120x30  sidebar=36  transcript=42  right=42  rightStartsAt=78  body=32  room=30
161x36  sidebar=36  transcript=63  right=62  rightStartsAt=99  body=32  room=30
```

Identical to the accepted table, odd cell to the Transcript included. `room` is
the body less the focus marker, which is what `fitLabel` works in: 30 is what the
old full-width wide sidebar had, so `completed, not recorded yet` (27) and
`  All conversations (filtered)` (30) both fit — at the medium profile for the
first time.

`SIDEBAR: ColumnWidths` is replaced by one `SIDEBAR_COLUMNS = 36`, since the two
profiles no longer differ.

## BP1–BP5 mapping

| Row | Where | Observed |
| --- | --- | --- |
| BP1 | `repl-presentation-style.test.ts` `Tier BP` | At both sizes, for Transcript, sidebar **and** Sidekick: body = pane − 4, body x = pane x + 2, the gutter cells on both sides blank and carrying that column's surface, every mounted row and every target inside the body. Beside it: the Transcript band spans the pane while its title is inset by `BODY_GUTTER`, the tab band spans the right pane's interior, the sidebar and right widths are `sidebarWidth`/`inspectionWidth`, the footer holds `FOOTER_ROWS`, the heading is `COLUMN_TOP_GAP` below the column top. |
| BP2 | same tier | A source line longer than any body: a continuation row exists, and every word of that line is recovered from the drawn cells — joined inside the Transcript body alone and gathered across the window by dispatching the real `scroll-reading` action. Reading and Sessions windows have positive height and end above the footer; both reading controls are mounted with targets. |
| BP3 | `repl-sidekick-presentation.test.ts` `Tier UH` | Mounted: an entry submitted and selected, both composers typed, a Sessions selection reached by clicking `All conversations`, and the Transcript's own `[↓ later]` found by the column it lands in and clicked at 120x30 and 160x36 — editing neither composer nor the selection. Narrow keeps its outlet with no inset; back at wide both texts and the selection stand. |
| **BP4** | `repl-agent-interface.test.ts` `Tier BP4` | **New.** At 160x36 **and 120x30**, on the existing three-turn `asking` fixture with one turn left unrecorded: its label contains the whole `completed, not recorded yet`, the recorded one contains `completed, recorded`, and **every** turn row ends in a complete state by regex — the hard-cut branch stops wherever the room ran out, so a row ending mid-state is the exact failure this width prevents. The three rows stay three distinct labels. Then a filter applied through the real `select-session` action, and `sessions:all` contains the whole `All conversations (filtered)`. |
| BP5 | `repl-presentation-style.test.ts` `Tier BP5` | Title text at pane x + 2 on the P=1 row with no target, band at the pane's x and width, chrome rule across it; the blank row of the Transcript and the right pane blank and carrying that column's header surface under both tabs, with the sidebar's own top row still `ACCEPTED_SURFACE.side`; every drawn `earlier`/`later` on its own pane's surface with and without focus, the focused one in `REPL_PALETTE.focus`, each of the three panes contributing one and at least six in all; `footer:exit` still on `draftSurface` as the positive control. |

Per the disposition, drawer scrollers keep their existing surfaces and BP5's six
visible controls stand.

## Adaptations

The widened sidebar and the body gutters moved where text lands, so three
helpers were reading the wrong columns and three rows were reading content
through cells a modal covers. Every exact string is unchanged.

- **`repl-presentation-style.test.ts`** — Tier PW's independent width table
  updated to the accepted shares at all three terminal sizes, body `startsAt`
  and widths included.
- **`repl-sidekick-presentation.test.ts`** — `SIDEBAR_COLUMNS` and
  `INSPECTION_FROM` were literals (32 and 96). They are how the helpers *slice*
  the screen, so they now ask `sidebarWidth`/`inspectionWidth` at the size these
  rows drive; Tier PW asserts the shares. This alone fixed the five SS rows and
  the five CF rows, which had begun reading the wrong pane.
- **`repl-agent-journey.test.ts`** — the same for `SIDEBAR` (was 30), and
  `sessionOf()` now reads past the body gutter, which is layout holding no text.
  Those two fixed J2, TL5, TL10. **J3** read three content facts through the
  sidebar behind an open History drawer; at 200x60 that layer starts at column 25
  and the gutter put the longest row's last character under it, which made the
  two *negative* assertions true of a prefix that holds the turn and one that
  does not. Each of the three is now read with the drawer closed and the drawer
  reopened for its own rows — the position survives closing, and the pair that
  must tell prefixes apart can do so again.
- **`repl-journey.test.ts`** — `J1: run, hold at a gate…` read the selected
  entry from behind a route drawer whose left edge at 160 columns is exactly the
  last character of `entry-1`; both that frame and the cold-process frame now
  close the layer, assert the selection, and reopen it for the drawer's content.
  `J1: a drawer covers…` reads its two Transcript texts with `saysAcross`, which
  rejoins a block inside its own column; its positional coverage checks are
  untouched. `J1: text the Journal has not settled…` needed a new `saysJoined`,
  because `the-last-thing-this-document-prints` has no spaces to wrap at — the
  column cuts it at a code unit, so the rows are rejoined with nothing between
  them and the enclosure rails stripped. It is documented as being only for a
  distinctive unbroken string; `saysAcross` remains the question for prose.

Two comments were reworded for `no-banned-jsdoc-words`.

## Documentation

`specs/repl-spec.md`: the sidebar is thirty-six at both profiles, with the two
rows that decide it and the arithmetic that makes them fit.
`architecture.md`: a column's width can be a legibility requirement rather than
a share, so narrowing this one changes what the product can say.

## Worth knowing before delivery

At 120x30 the Transcript's *source* room is now about 12 columns: the column is
42, the body 38, and `reserveFor()` takes the rail, two separators and the widest
status badge out of it before any source is cut. That is why
`text={summarySource}` draws over two rows there. It is the arithmetic working as
specified rather than a broken invariant — nothing is lost, and the window
reaches it — but it is the tightest the source reading has been, and the next
column-width decision should know it.

## Next

Stopping for review of `6ca23952`. On acceptance, delivery follows
[the updated handoff](pr890-pr921-final-delivery-implementor-handoff-27da762b.md)
with this successor as the PR2 source: recheck current main, rebase PR1 first,
then carry PR2's commits through this one, complete the delivery gates and the
EH1/UI10 obligation, and publish through #890/#921. No UI scope remains.
