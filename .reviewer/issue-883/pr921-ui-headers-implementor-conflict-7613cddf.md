# The top gap collides with the History drawer: one product decision needed

Implementor return against
[the UI headers plan](pr921-ui-headers-planner-handoff-7613cddf.md), base
`7613cddf4f8478b905d6a56d67fb0aa9a2588d25`, worktree
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2-main-integration`.

**P was taken as 1**, the recommended value, recorded by the Product Owner in
the message releasing this assignment.

**No successor is signed.** HEAD is still `7613cddf`, no ref moved, nothing was
pushed, amended, reset or rebased. The whole increment is implemented and the
work is preserved as
[a patch](pr921-ui-headers-work-in-progress-7613cddf.patch) and in the
worktree, uncommitted. The plan conditions the successor on the focused
evidence passing, and one of the three selections does not pass — for a reason
that needs a product answer, not another correction.

## What is done, and green

The horizontal header, the single labels, the removed title, the removed
`[selected]` word and the one row of column padding are all implemented, with
UH1–UH4 observed. `deno task check` passes. `deno task lint` passes, exit 0,
warnings only, including the dead-code gate.

| Command | Result |
| --- | --- |
| 1 — presentation-style, layout-admission, source-reading | **27 passed (108 steps), 0 failed**, exit 0 |
| 2 — sidekick presentation, journey, lifecycle, configuration | **44 passed (169 steps), 0 failed**, exit 0 |
| 3 — agent-interface, agent-journey, journey, forms | **66 passed, 5 failed**, exit 1 — see below |

## The conflict

**One row of top padding moves every shared column's content down one row, and
the History drawer's rectangle does not move with it.** The plan requires both:

> Add P inside each of the three shared columns, above its first heading/header row.

> Route drawers and pane-local question/Configure drawers keep their existing
> rectangle calculations; column padding does not move the modal layer or its
> targets.

> existing header-edge, composer, chat-following and drawer geometry assertions
> continue to hold

At P ≥ 1 those cannot all hold. `drawerRect()` puts the drawer's top at
`floor(bodyRows / 8)`, measured from the top of the body, while a column's first
content row is now at `P + 2` (the gap, the heading, the band's edge):

```
160x36  body=29  drawerTop=3   P=0 → first content row 2 (clear)   P=1 → row 3 (covered)
200x60  body=53  drawerTop=6   P=0 → first content row 5 (clear)   P=1 → row 6 (covered)
120x30  body=23  drawerTop=2   P=0 → first content row 2 (covered) P=1 → row 3 (covered)
```

Note the third line: **at the medium profile the transcript's first content row
is already under the History drawer on the accepted base**, before this
increment. `UI1` and `UI15` only ever drove 160x36, so nothing caught it. P=1
extends a pre-existing collision to the wide and large profiles rather than
creating a new class of defect.

### The five rows, and why each one is red

Three are that collision:

- **`UI1`** (160x36) — with the History drawer open the guidance row must say
  `Esc closes`. The guidance is the transcript's first content row, so at P=1 it
  is behind the drawer's top rule and the product no longer says it. This is the
  one failure that is a **product regression and not a fixture artifact**: the
  same claim is already false at 120x30 today.
- **`UI15`** (160x36) — same row, same cause; its `History ·` search now finds
  the footer's History band at row 30 instead of the covered guidance at row 3.
- **`J3`** (200x60) — the sidebar row `ok? · completed, recorded` lands on the
  drawer's own top row and is truncated at the drawer's left edge (`x = 25`),
  so the screen reads `completed, reco`.

Two are the reading window holding one row less, with no drawer open:

- **`J1: a second process reconstructs the view from the URL and the journal
  alone`** — `Decision: approve` is below the window. The drawer is explicitly
  closed before the assertion, so this is capacity, not occlusion.
- **`J1: run, hold at a gate, inspect a prefix, return live, continue, answer,
  settle`** — the same, after the question form closes.

### The gap is the sole cause

With every other part of this increment in place and `COLUMN_TOP_GAP` set to
`0`, command 3 is **71 passed (185 steps), 0 failed, exit 0**
([log](pr921-ui-headers-gap0-cmd3.log)). So the horizontal tabs, the deleted
title, the deleted selection word and all fixture adaptations are clean, and all
five failures are the one padding row. The gap is back at `1` in the worktree.

### What the decision is

Not mine to take, so nothing was done about it:

1. **Move the drawer's top down by P.** `drawerTop + P` clears all three
   occlusion rows at every profile above, and would also fix the pre-existing
   120x30 case. The plan forbids me to touch the rectangle.
2. **Move the guidance block out of the covered band**, e.g. above the three
   columns rather than inside the transcript. A layout change the plan does not
   release.
3. **Accept a covered guidance row**, and re-anchor `UI1`/`UI15`/`J3`. This
   accepts that the screen stops saying `Esc closes` while a drawer is open at
   every profile.

Options 1 and 2 leave the two `J1` capacity failures, which are the ordinary
cost of the gap: a full reading now needs one scroll to show its last row. Those
two rows assert that content is on screen without scrolling, and the plan says
ordinary entry journeys stay intact — so whether they scroll or the claim
changes is also yours.

P=2 is strictly worse: it covers the same rows and costs another.

## UH1–UH4 mapping

| Row | Where | Observed |
| --- | --- | --- |
| UH1 | `repl-presentation-style.test.ts`, `Tier UH` | At 160x36 and 120x30 under both active panes: both tabs on the band's row, Bindings then Sidekick, disjoint boxes inside the column, each narrower than the column; the band is the column's full inner width with the chrome edge directly beneath; each name once across the band; no `[selected]`; no `inspection:heading` key; the active tab is `SEMANTIC.intro` while the *other* tab holds focus as `REPL_PALETTE.focus`, so selection and focus are two marks on two tabs; one pointer target each. |
| UH2 | `repl-sidekick-presentation.test.ts`, `Tier UH` | Through the mounted program: keyboard (Tab to focus, Enter) and pointer (click the name) each select both tabs; focus on the unselected tab does not select it; `Draft` and `Message Sidekick` text both survive. The hidden Sidekick's real pending-question notice is held by the existing Tier MQ row, which was adapted rather than duplicated. |
| UH3 | `repl-presentation-style.test.ts`, `Tier UH` | At both sizes: `sessions:heading`, `transcript:heading` and the tab band each sit exactly `COLUMN_TOP_GAP` below their column's top; no mounted row and no pointer target covers any gap cell in any of the three columns; `entries:heading` takes no second gap; the footer still holds `FOOTER_ROWS`, and the reading window is non-empty and ends above it. |
| UH4 | `repl-sidekick-presentation.test.ts`, `Tier UH` | Resize wide → medium → narrow → wide with both composer values preserved; the narrow outlet shows its own surface controls and grows no tab row and no gap; no `[selected]` at any size. |

## Fixture adaptations

Production: `application.ts` (the `inspection:heading` description removed, the
`[selected]` suffix removed, `slotOf` left with one pane heading, a `tabRow()`
builder, `TAB_ROW` exported, the gap passed to the sidebar and to `edgedColumn`)
and `layout.ts` (`TAB_GAP`, `COLUMN_TOP_GAP`, `tabRowProps`, `tabProps`, a
`topGap` parameter on `paneProps`/`paneContentProps`, `columnAxis` extracted).
No Core, agent, storage or identity change.

- **`repl-presentation-style.test.ts`** — `P1: each shared column is named` now
  reads the right column's name from its two tabs, asserts order, disjointness
  and one occurrence of each name, and asserts the transcript heading is not a
  control *while the tabs are*. `P1: a narrow frame has no pane to name` now
  asserts no `tab:*` keys, because the absence of a name nothing describes any
  more proves nothing. `P1: a row is built to the inside of its pane` admits a
  self-sized tab, keeping containment as the claim. `P3` expects the first body
  row at `body.y + COLUMN_TOP_GAP`, and `0` for narrow. `P1-T3` reads each
  column's own surface in the gap rows and the header on the first row below
  them, and reads the right column's name from the selected tab. `TE4` reads the
  header fill and the closing edge from the tab band, and **replaced the
  `[selected]` text check with the committed active styling measured on both
  tabs** — one colour alone proves nothing — plus an explicit check that neither
  label contains the word. `TE4`'s narrow key list dropped the deleted name.
  `PW1` takes the right header's edge and width from the band.
- **`mounted-program.ts`** — new shared `paneShown(rows)` / `panePresented(terminal)`,
  which read the selected pane from **the body it draws** (the Sidekick's
  composer) rather than from a label. This is the helper change the plan asked to
  be reported: `shows("Bindings")` would be true of every screen either reading
  ever drew.
- **`repl-sidekick-presentation.test.ts`** (7 waits, 6 assertions),
  **`repl-sidekick-lifecycle.test.ts`** (1), **`repl-sidekick-configuration.test.ts`** (1)
  — every `shows(…, "X [selected]")` replaced by that helper, so each wait is
  satisfied by the current frame's own pane rather than by text a previous pane
  left on the reconstructed screen.
- **`repl-agent-journey.test.ts`** — `answeredUnder()`'s pane test is now
  `panePresented(terminal) === "sidekick"`, a local helper of the same shape. It
  still asks for Bindings; it does not stop asking merely because the tab label
  exists.
- **`specs/repl-spec.md`** — the right pane's header paragraph restated as two
  horizontal tabs that are the heading, with styling as the selection and focus
  separate; the Sidekick-inset paragraph now names the tab row instead of a
  title; a new paragraph for the one-row gap, its inertness, the Entries
  exception and the narrow exception. The colour-independence paragraph was
  corrected: it claimed which tab is selected is said in text, which this
  amendment supersedes.

`architecture.md` needed no change; it says nothing about these tabs.

## First failures, preserved

`UI1`: `expect(shows(terminal, "Esc closes")).toBe(true)` → received `false`.
`UI15`: `expect(saying).toBeLessThan(box.top)` → received `30`, expected `< 3`.
`J3`: `the screen never showed completed, recorded`, with the rendered screen
showing `ok? · completed, reco` cut at the drawer's edge. `J1` (reconstruct):
`expect(shows(second.terminal, "Decision: approve")).toBe(true)` → `false`.
`J1` (gate): `the screen never said the answer's output`. Full logs:
[command 3](pr921-ui-headers-final-cmd3.log), and
[the same selection at P=0](pr921-ui-headers-gap0-cmd3.log).

One diagnostic edit was made and reverted: `UI1` was briefly given a 120x30 pass
to test whether the collision pre-existed. It is width-specific and failed on its
first assertion there, so the question was answered by computing `drawerRect()`
against the column arithmetic instead. `repl-journey.test.ts` is unmodified.

## Not done

No push, GitHub write, CI inspection, merge, history repair, dependency or lock
change, and no cleanup of another session. EH1/UI10's recorded baseline is
untouched and unclaimed. The 72x20 pending-question conflict remains Task D and
was not repaired; the top gap spends no narrow row. History closing, conversation
labels and the small-screen question layout remain separate slices.
