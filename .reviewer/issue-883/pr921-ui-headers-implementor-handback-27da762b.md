# The header cleanup, with the guidance kept above route drawers

Implementor handback for
[the continuation prompt](pr921-ui-headers-continuation-prompt-7613cddf.md) and
[the guidance amendment](pr921-ui-headers-guidance-planner-amendment-7613cddf.md).
P = 1 as recorded. The preserved work was continued in place; nothing was reset,
replayed or recreated.

## The successor

```
SHA     27da762b7078ee8e32b1dbaf90941c4a8a90eaa7
parent  7613cddf4f8478b905d6a56d67fb0aa9a2588d25
tree    8eabb472fd49a753c34af034b1d173d49ea9a054
sig     G, tarasm@gmail.com
subject 💄 Put the REPL's pane tabs side by side and space the column headings (#883)
```

Worktree clean, nothing untracked. Base `7613cddf` preserved;
`agent/issue-883-pr1-main-integration` `85da74b9`, `agent/issue-883-pr2`
`d4b0e326`, `agent/issue-883-pr2-isolated` `99c27d92` and
`pre-integration/issue-883-pr2-d4b0e326` all unmoved. Not pushed.

## Results

| Command | Result |
| --- | --- |
| 1 — presentation-style, layout-admission, source-reading | **28 passed (109 steps), 0 failed**, exit 0 ([log](pr921-ui-headers-f2-cmd1.log)) |
| 2 — sidekick presentation, journey, lifecycle, configuration | **44 passed (170 steps), 0 failed**, exit 0 ([log](pr921-ui-headers-f2-cmd2.log)) |
| 3 — agent-interface, agent-journey, journey, forms | **71 passed (185 steps), 0 failed**, exit 0 ([log](pr921-ui-headers-f2-cmd3.log)) |

`deno task check` exit 0. `deno task lint` exit 0, warnings only, dead-code gate
included ([log](pr921-ui-headers-f2-lint.log)). Not feedback prerequisites; run
because the increment touches production.

The earlier evidence is kept, unrelabelled: the five original failures
([command 3 at the conflict](pr921-ui-headers-final-cmd3.log)) and
[the P=0 isolation run](pr921-ui-headers-gap0-cmd3.log).

## The implemented envelope

`routeDrawerRect(size, guidanceBottom)` in `layout.ts`: horizontal bounds and
bottom edge from the existing `drawerRect(size)`, top at
`max(base.y + COLUMN_TOP_GAP, guidanceBottom)` clamped to the retained bottom,
height the remainder. Narrow returns the base rectangle unchanged, as does a
frame with no guidance measured.

`guidanceBottomOf()` in `program.ts` reads the extent from the boxes the frame
published — every box whose key is `guidance` or `guidance:row:N` — and takes
`max(y + height)` from the engine's own bounds. No row count is assumed, no
character arithmetic, no hardcoded `y`, and the wide frame is not used to infer
the medium one.

`prepareFrame` settles it once, after the pass that already measures the frame
with the fitted guidance count in place, and measures again **only if the
rectangle actually moved**. One extra bounded measurement, no loop: a floating
layer takes no row out of any column's flow, so the block it was moved clear of
cannot move because it moved. The rectangle then rides the presentation context
as `ReplPresentationContext.drawer`, and `presentedRect()` reads it rather than
recomputing — so the layer's box, its window's admission, its painted cells and
its published targets are the one rectangle. The passes that run before the
block is fitted carry `undefined` and measure the base rectangle; nothing is
admitted into a drawer from them.

`sidekickDrawerRect` is untouched, and `presentedRect` still returns it for the
pane-local question and Configure forms. Footer rows, widths, the body inset,
the composer cap, focus containment, modal precedence and the close actions are
unchanged. No renderer, engine, tree or input change; no public hook; no second
geometry store; no route mutation.

**One scope note.** The amendment names the guidance block, so I protected
exactly that: boxes keyed `guidance*`. A frame showing a refusal explanation in
the same `located` position keeps today's rectangle. Generalising would have
been strictly more code and would have spent drawer-window height on a case the
amendment did not ask about.

## UH1–UH5 mapping

| Row | Where | Observed |
| --- | --- | --- |
| UH1 | `repl-presentation-style.test.ts` `Tier UH` | At 160x36 and 120x30 under both active panes: both tabs on the band's row, Bindings then Sidekick, disjoint boxes inside the column, each narrower than it; the band is the column's full inner width with the chrome edge directly beneath; each name once across the band; no `[selected]`; no `inspection:heading`; the active tab `SEMANTIC.intro` while the **other** tab holds focus as `REPL_PALETTE.focus`; one pointer target each. |
| UH2 | `repl-sidekick-presentation.test.ts` `Tier UH` | Keyboard (Tab to focus, Enter) and pointer (click the name) each select both tabs; focus on the unselected tab does not select it; both composers keep their text. The hidden Sidekick's pending-question notice stays with the existing Tier MQ row. |
| UH3 | `repl-presentation-style.test.ts` `Tier UH` | `sessions:heading`, `transcript:heading` and the tab band each exactly `COLUMN_TOP_GAP` below their column's top; no mounted row and no target covers any gap cell in any of the three columns; `entries:heading` takes no second gap; footer still `FOOTER_ROWS`; reading window non-empty and above it. |
| UH4 | `repl-sidekick-presentation.test.ts` `Tier UH` | Resize wide → medium → narrow → wide with both composer values preserved; narrow shows its own surface controls and grows no tab row and no gap; no `[selected]` at any size. |
| UH5 geometry | `repl-presentation-style.test.ts` `Tier UH5` | At 160x36, 120x30 **and 200x60**, a real History drawer in a committed frame: every fitted guidance row ends at or above the layer's top; each row's drawn cells still hold its text; the joined block contains every word of `guidanceSentence(view)` and `Esc closes`; the layer's `x`/`width` and bottom equal `drawerRect(size)`'s; its top is at or below the base top; the layer stays above the seven-row footer; the drawer window has positive height and `drawer:scroll:up`/`drawer:scroll:down`/`drawer:close` are all mounted with targets. At least one of the three sizes wraps the block over more than one row, asserted — so protecting only the first row fails this. Compared by content, not by a sentence written here, because the three widths compose different ones. |
| UH5 behaviour | `repl-sidekick-presentation.test.ts` `Tier UH` | Through the mounted program: `[history]` opened for real, `Esc closes` visible in front of it, one Escape closes it once, and afterwards the same reading is selected and neither composer was edited. |

## Fixture and helper adaptations

Beyond those already reported for the tabs:

- **`repl-journey.test.ts` `drawerBox()`** — was derived from the size alone,
  which is no longer authoritative for the shared-column frame. It now keeps the
  horizontal bounds and the bottom from `drawerRect(size)` and finds the **top
  from the rule the drawer draws across its own rectangle**, searching downward
  from the base top. Downward, never upward: the new top is at or below the old
  one, and a pane's header edge is a run of the same character one row higher at
  the medium profile. It does not locate the drawer by the word `History` and
  does not reproduce the guidance-fitting calculation. This one change fixed
  `UI15`, `J1: a drawer covers what it is in front of`, `ER1`, `H5` and `H6`,
  which had begun reading the guidance row and the drawer title as content.
- **`repl-journey.test.ts` new `transcriptControl()` / `scrollReadingTo()`** — the
  three `Decision: approve` sites now reach that output through the transcript
  reading window's own `[↓ later]`, clicked at its real cell. The control is
  identified by the column it lands in, because the sidebar's two readings and
  the right pane each draw one and the first on the screen is the sidebar's. The
  expected string is unchanged and nothing is read out of the journal; scrolling
  moves the viewport and writes nothing. Their claims about retained output,
  location-based reconstruction, selection, provider inactivity and both
  composers are untouched. There were **three** such sites, not the two the
  review counted — the third is in the same `J1: run, hold at a gate…` row.
- **`repl-presentation-style.test.ts` `G5`** — the literal
  `{x:20, y:3, width:120, height:23}` became `[x, width, bottom] = [20, 120, 26]`
  plus `rect.y >= guidance bottom`. The retained parts stay stated; the top is
  the frame's own answer. The opacity walk is unchanged and still reads whatever
  rectangle the engine gave.
- **`repl-presentation-style.test.ts` `D1: a recorded answer says so`** — the
  drawer window is three rows shorter, so `drawer:answered` is a press further
  on. Its bold-label assertion moved to the scrolled frame the row already
  builds, beside `drawer:answer:1`. Both readings are still asserted.
- **`tests/fixtures/repl/presentation.ts`** — `measuringContext()` carries
  `drawer: undefined`, which is what a pass that has fitted no guidance means.

`UI1` needed no change and passes: it is the row the envelope exists for.
`J3` keeps its prefix and turn assertions unchanged.

## Documentation

`specs/repl-spec.md` gains the route-drawer paragraph (begins below the whole
block, unchanged columns and bottom edge, shorter window still whole by
scrolling, narrow and Sidekick rectangles unaffected), alongside the tab-header
and one-row-gap paragraphs from the previous round and the corrected
colour-independence sentence. `architecture.md` records the one shared-column
fact that is measured rather than declared, including that the extent comes from
published rows and engine bounds, that the rectangle is carried through the
presentation context and read back by box, admission, cells and targets alike,
and why one bounded measurement settles it.

## Not done

No push, GitHub write, CI inspection, merge, dependency/cache/lock change,
setup, full battery or saved-history repair. EH1/UI10's recorded baseline is
untouched and unclaimed. Task D's 72x20 pending-question conflict is not
repaired and the gap spends no narrow row. History self-stacking, conversation
labels, Parse #922, teaching, captures and delivery remain separate.

Stopping here for review of `27da762b`.
