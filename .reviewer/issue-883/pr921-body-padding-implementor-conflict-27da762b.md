# The sidebar cannot hold a turn's state once it is inset

Implementor return against
[the body padding plan](pr921-shared-body-padding-planner-handoff-27da762b.md),
base `27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`, worktree
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2-main-integration`.

**No successor is signed.** HEAD is still `27da762b`, no ref moved, nothing was
pushed, amended, reset or rebased. The whole increment is implemented — both
bodies inset, widths split, BP1–BP3 observed — and preserved as
[a patch](pr921-body-padding-work-in-progress-27da762b.patch) and in the
worktree, uncommitted. The sidebar half of the request cannot be delivered
without breaking an invariant the production code states about itself, and that
is a product decision.

## What is done

Each shared column now publishes two boxes: the **pane**, which its heading band
spans, and the **body**, inset two cells on each side, which every row under
that heading is built to. The Transcript's directions, retained reading and
window controls, and the sidebar's Sessions and Entries lists and theirs, are
inset exactly as the Sidekick's chat already was. Headings, the tab row, header
edges, outer column widths, dividers, P=1, the footer's seven rows, both
composers and the pane-local Sidekick rectangles are untouched. Narrow gains
nothing.

`deno task check` exit 0. `deno task lint` exit 0, warnings only, dead-code gate
included.

| Command | As assigned (both insets) | Transcript inset only |
| --- | --- | --- |
| 1 — presentation-style, layout-admission, source-reading | **29 passed (111 steps), 0 failed** | 28 passed, 1 failed — only BP1's own sidebar clause |
| 2 — sidekick presentation, journey, lifecycle, configuration | 42 passed, **5 rows failed** | **44 passed (171 steps), 0 failed** |
| 3 — agent-interface, agent-journey, journey, forms | 64 passed, **10 rows failed** | **71 passed (185 steps), 0 failed** |

Logs: [cmd1](pr921-body-padding-bp-final-cmd1.log) ·
[cmd2](pr921-body-padding-bp-final-cmd2.log) ·
[cmd3](pr921-body-padding-bp-cmd3-fourth.log) · and the Transcript-only
measurements [cmd1](pr921-body-padding-bp-nosb-cmd1.log) ·
[cmd2](pr921-body-padding-bp-nosb-cmd2.log) ·
[cmd3](pr921-body-padding-bp-nosb-cmd3.log). First failures preserved in
[the first run](pr921-body-padding-bp-cmd1-first.log).

**Every remaining failure is the sidebar inset, and only the sidebar inset.**
Measured, not inferred: with the sidebar left at full width and the Transcript
inset kept, commands 2 and 3 are completely green and command 1 fails only on
the BP1 clause that asserts the sidebar body exists.

## The conflict

`fitLabel()` composes a sidebar row from parts. Some are elidable (the prompt,
the conversation headline) and one is marked `keep: true` — the turn's state —
with this reason in the source:

> The row's own vocabulary does not fit. What it named survives whole — **a state
> cut in half is a row saying something untrue** — and the names keep what is
> left in front of it.

That guarantee has a last-resort branch beneath it: when even the kept part does
not fit, the row degrades to `whole.slice(0, room)`, a hard cut at a code unit.
The inset pushes the sidebar into that branch.

```
                     sidebar   body   room = body − FOCUS_MARKER(2)
wide    160x36          32      28      26
medium  120x30          28      24      22
```

The longest states the product writes are longer than that room:

```
"completed, not recorded yet"     27 cells   (stateOf, a terminal turn)
"  All conversations (filtered)"  30 cells
```

So at wide, `kept.length (27) >= room (26)` and the row is cut mid-word. That is
exactly what the runs show: `"  build · completed, not r"`,
`"    stub-agent · stub:revie…"`, `"All conversations (filte"`,
`"1. entry-"`, `"Automatic feedback · T"`. The last one matters most — an entry
key cut to `entry-` makes two rows a reader cannot tell apart, which is the other
thing that comment exists to prevent.

**This is not a new class of defect.** At 120x30 the sidebar is already 28 cells
and the room already 26, so a terminal turn's state is already cut on the
accepted base. Every test drives the wide profile, so nothing caught it. The
inset brings the wide profile into the same band — the same shape as the drawer
collision in the previous increment.

No fitting change can resolve it: 27 cells of state do not go into 26, and the
assignment rules out shortening the vocabulary ("do not invent new wording"),
moving the column widths ("outer column widths and dividers do not move") and
re-anchoring the assertions ("do not replace them with truncated strings").
Scrolling cannot help either — an elided label has no control that reveals the
rest of it.

### What the decision is

Not mine to take, so nothing was done about it:

1. **Inset the Transcript only**, and leave Sessions at full width. Fully green
   today, as measured above; I would drop BP1's sidebar clause. It does not
   deliver the request as worded.
2. **Shorten the sidebar's own vocabulary** so a state fits 22 cells — e.g.
   `completed, unsaved`. New wording for a thing the product names, which is
   yours and not mine.
3. **Widen the sidebar** by the four cells the gutters take, keeping the body as
   wide as it is now. Changes a column width the plan freezes.
4. **Accept the hard cut** and re-anchor the sidebar assertions. This accepts a
   row that states a turn's outcome untruthfully, and that the medium profile
   already does so.

Option 1 is the only one that is green today; options 2 and 3 are the only ones
that deliver the request. I would take 3 if the four cells can come from
somewhere, because it keeps both the inset and every existing claim.

## BP1–BP3 mapping

| Row | Where | Observed |
| --- | --- | --- |
| BP1 | `repl-presentation-style.test.ts` `Tier BP` | At 160x36 and 120x30, for the Transcript, sidebar **and** Sidekick: body width is pane − 4, body x is pane x + 2, the gutter cells on both sides are blank and carry that column's own surface, and every mounted row and every pointer target inside the body stays within it. Unchanged beside it: the Transcript heading spans the pane, the tab band spans the right pane's interior, the sidebar and inspection column widths are still `sidebarWidth`/`inspectionWidth`, the footer still holds `FOOTER_ROWS`, and the heading is still `COLUMN_TOP_GAP` below the column's top. **Passes.** |
| BP2 | `repl-presentation-style.test.ts` `Tier BP` | With a source line longer than any body: a continuation row really exists, and every word of that line is recovered from the drawn cells — joined inside the Transcript body alone, and gathered across the reading window by dispatching the real `scroll-reading` action, because a reading longer than its window is reached rather than drawn. Both the reading and Sessions windows have positive measured height and end above the footer; both reading controls are mounted with real targets. **Passes.** |
| BP3 | `repl-sidekick-presentation.test.ts` `Tier UH` | Through the mounted program: an entry submitted and selected, both composers typed, a Sessions selection reached by clicking `All conversations`, and the Transcript's **own** `[↓ later]` found by the column it lands in — not the sidebar's — and clicked at both 120x30 and 160x36. Pressing it edits neither composer nor the selection. Narrow routes its own outlet with no inset; back at wide, both texts and the selected reading are as they were. **Passes.** |

## Production changes

`layout.ts`: `SIDEKICK_GUTTER` renamed `BODY_GUTTER` and `sidekickBodyProps()`
renamed `insetBodyProps()`, since they are now every column's; `contents`
entries carry `kind: "pane" | "body"`.

`application.ts`: `TRANSCRIPT_BODY` and `SIDEBAR_BODY` exported beside
`SIDEKICK_BODY`; one `insetBody()` helper builds the gutter/content pair for all
three; `ReplMeasuredWidths` gains `surfaceBody` and `listBody`; a
`bodyWidthOfRegion()` beside `widthOfRegion()` so headings keep the pane width
while `listColumn`, the `located` rows, the refusal chunking, `sessionRows` and
`entryContent` take the body width.

`program.ts`: `widthsOf` split into `paneOf` (by region and `kind: "pane"`) and
`bodyOf` (**by the body's own id**, falling back to the pane). The id lookup is
load-bearing and fixed a bug I introduced on the way: the narrow outlet is one
region for all three readings, so a frame routing the Sidekick there publishes
that chat's inset under `content`, and a by-region lookup handed the Transcript's
guidance the chat's width. Guidance, refusal and reading fitting now take
`surfaceBody`.

## Fixture and assertion adaptations

- **`repl-presentation-style.test.ts`** — `P1: a row is built to the inside of
  its pane` now applies the inset to both shared columns rather than only the
  inspection one. `R3` bounds the reading by `TRANSCRIPT_BODY` and asserts that
  body is the pane less two gutters. `P1-T3`'s badge aligns to the body's right
  inner edge, which is where the row now ends. `G5`, `D1` and `UH5` are the
  previous increment's and unchanged.
- **`repl-journey.test.ts`** — four `Decision: approve` sites reach the output
  through the Transcript window's own `[↓ later]`, via the existing
  `scrollReadingTo`. One readiness wait became `saysAcross`: the source column
  reserves the rail, two separators and the status badge out of the body, so at
  120x30 `About to evaluate:` is **split across rows** and no amount of
  scrolling puts it on one — `saysAcross` rejoins a block inside its own column,
  which is the same technique UH5 uses and the amendment endorsed. The text
  asserted is unchanged.
- **`tests/fixtures/repl/presentation.ts`** — `measuringContext()` states the
  two new widths.

No helper was given a second geometry calculation and nothing locates a box by
prose.

## Worth flagging beyond the conflict

At 120x30 the source column's text room is now about 15 cells: the body is 41,
and `reserveFor()` takes the rail, two separators and the widest status badge out
of it before any source is cut. That is why `text={summarySource}` draws as
`text={summarySourc` / `e}`. It was already about 19 cells before this change,
so the inset makes a cramped reading more cramped rather than breaking a stated
invariant — unlike the sidebar. You may still want it.

## Not done

No push, GitHub write, CI inspection, merge, dependency/cache/lock change,
setup, full battery or saved-history repair. EH1/UI10's recorded baseline is
untouched and unclaimed. Task D, History self-stacking, conversation labels,
Parse #922, teaching, captures and delivery remain separate.
