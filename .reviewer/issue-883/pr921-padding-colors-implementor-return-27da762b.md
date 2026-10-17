# The three styling corrections are implemented; the sidebar width is still open

Implementor return against
[the styling addendum](pr921-padding-header-colors-planner-addendum-27da762b.md),
on top of the preserved padding work at base
`27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`, worktree
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2-main-integration`.

**Not committed, as the addendum directs.** HEAD is still `27da762b`, no ref
moved, nothing pushed, amended, reset or rebased. The whole increment — the two
body insets, the three styling corrections, BP1–BP3 and BP5 — is preserved as
[one patch](pr921-padding-colors-work-in-progress-27da762b.patch) and in the
worktree. BP4 is not implemented: it belongs to the pending width ruling.

`deno task check` exit 0. `deno task lint` exit 0, warnings only, dead-code gate
included.

| Command | Result |
| --- | --- |
| 1 — presentation-style, layout-admission, source-reading | **30 passed (112 steps), 0 failed**, exit 0 ([log](pr921-padding-colors-ad-final-cmd1.log)) |
| 2 — sidekick presentation, journey, lifecycle, configuration | 42 passed, **5 rows failed** ([log](pr921-padding-colors-ad-final-cmd2.log)) |
| 3 — agent-interface, agent-journey, journey, forms | 64 passed, **10 rows failed** ([log](pr921-padding-colors-ad-final-cmd3.log)) |

**The failing set is unchanged — the same 5 and the same 10 rows, the same test
cases, as before these corrections.** Every one is the sidebar label elision in
[the open conflict](pr921-body-padding-implementor-conflict-27da762b.md), whose
arithmetic and four options stand as returned. Command 1 rose from 29 to 30 with
BP5. First failures from the first run after the corrections are in
[this log](pr921-padding-colors-ad-cmd1-first.log); there were exactly two, both
expectations the addendum supersedes.

## Correction 1 — the Transcript title is inset

`paneTitle()` now wraps its row in a gutter box, `headerTitleProps(surface)`,
which pads two cells on each side through the engine. The row inside is built to
the body width because that is the box it is in; the band around it keeps the
whole inner column, draws the header surface and the rule that closes it. No
spaces were put in front of the name, no second coordinate is computed at paint
time, no extra row or target exists, and the title stays on the accepted P=1 row.

The sidebar's headings and the right pane's tab row are untouched, as assigned.

## Correction 2 — the gap belongs to the header band

`headerBandProps(rows, surface, topGap)` takes the gap, growing the band by that
row and padding its top; `edgedColumn` no longer passes it to the column's
content box. Ownership moved and nothing else did: the band is one row taller and
the content box one row shorter, so the heading row, the border row, the first
body row and the measured capacity are all exactly where they were. The blank row
is now painted with `transcriptHeaderSurface` and `inspectionHeaderSurface`
respectively, under either tab. The sidebar has no band and keeps its gap on the
pane, which is its own surface.

## Correction 3 — window navigation takes its pane

A new `"navigate"` role in `presentation-style.ts`: `surfaceOf()` returns
`undefined` for it, so the pane shows through, and `colourOf()` gives it the
same `REPL_PALETTE.heading` foreground `"action"` has. The eight rows that
describe a window's own two controls — `sessions:`, `entries:`, `reading:` and
`sidekick:` `earlier`/`later` — now ask for that role. Each was already a
`scroll-*` select, and their label, key, target, activation and focus cue are
untouched.

Nothing is inferred from a label or a key prefix in the renderer, and the action
background is not globally removed: `surfaceOf` still answers `draftSurface` for
`"action"`.

**One scope note.** The addendum names the Sessions, Entries, Transcript and
Sidekick windows. A drawer's own `drawer:scroll:up`/`drawer:scroll:down` keep
their existing surface, because the addendum says a drawer's choices keep theirs
and does not list the drawer among the panes. Say if you meant those too.

## BP5

In `repl-presentation-style.test.ts`, one row at 160x36 and 120x30, against a
frame with an entry selected and a populated Sidekick chat so all four windows
are measured:

- **Title.** Its text begins at the pane's inner x + 2, reads `Transcript`, sits
  on the `COLUMN_TOP_GAP` row, and has no pointer target; the band is the pane's
  own x and width; the chrome rule under it is read at three points across that
  full width.
- **Gap.** Under both right-pane tabs, the blank row of the Transcript and the
  right pane is blank and carries that column's header surface, read at the last
  two cells of the column — beyond anything a label reaches. The sidebar's own
  top row is asserted to keep `ACCEPTED_SURFACE.side`, so the two columns that
  changed are distinguished from the one that did not.
- **Navigation.** Every drawn `earlier`/`later` is read against its own pane's
  surface — side, centre, right — then re-committed with focus on it and read
  again: the background is identical and the foreground is `REPL_PALETTE.focus`.
  Each of the three panes must contribute at least one measured control, and at
  least six in all. Six rather than eight is deliberate and documented in the
  row: the Entries catalog states its own height while it fits, so it offers its
  two controls only once windowed.
- **Positive control.** `footer:exit` still carries `REPL_PALETTE.draftSurface`,
  so restyling every action could not have satisfied any of the above.

## Adaptations

Two, both directly superseded by the addendum:

- **`P1-T3: an empty screen's panes, edges and uncovered area are each their
  own`** expected the body colour in the two gaps. It now expects the header
  surface where a column has a header and the pane's where it does not — the
  same `header ?? surface` the row already uses for the heading row below.
- **`BP1`** asserted the Transcript heading row spans the pane. It now asserts
  the *band* spans the pane and the title row inside it is inset by
  `BODY_GUTTER`, with its x at pane x + 2.

Everything else in BP1–BP3, UH1–UH5 and the mounted scrolling, tab activation,
resize, drawer-guidance and composer rows is unchanged.

## Documentation

`specs/repl-spec.md`: the gap paragraph now says the band owns that row and
paints it, with the sidebar's exception; a new sentence for the inset title; and
a new paragraph for window navigation carrying its pane, independent of focus,
with the list of controls that keep the draft's surface.
`architecture.md`: a row's surface comes from its semantic role, never from its
key or its label, and no background is corrected after preparation.

## Still open

The sidebar width ruling. Until it is settled this increment cannot be
committed, and I have not committed it. The four options and the measurement
that isolates the sidebar as the sole cause are in
[the conflict return](pr921-body-padding-implementor-conflict-27da762b.md);
with the sidebar left at full width, all three selections are green.

## Not done

No push, GitHub write, CI inspection, merge, dependency/cache/lock change,
setup, full battery, History-rail restyle or saved-history repair. Generic
action surfaces, drawer choices, EH1/UI10's baseline and Task D are untouched.
