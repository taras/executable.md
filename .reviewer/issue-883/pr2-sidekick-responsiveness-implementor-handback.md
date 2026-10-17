# Implementor handback: Sidekick responsiveness and the open chat correction

**Feedback commit: `13c4900dbf0c4e57411241ada84aa00f4b55ba65`.**

- Parent: `39c24f37fdb967c3aa90870f9b4e22e536dc0fec`, preserved, as are all its
  ancestors. No amend, reset or rebase.
- Branch `agent/issue-883-pr2`; signature **G**, `tarasm@gmail.com`.
- Tree clean at `13c4900d`; nothing unstaged, nothing untracked.
- Seven files, +715 / −50. Production: `fitting.ts`, `program.ts`,
  `application.ts`. Tests: `repl-presentation-style.test.ts`,
  `repl-sidekick-presentation.test.ts`. Prose: `architecture.md`,
  `specs/repl-spec.md`.
- All eleven commands and the mounted diagnostic were re-run against this exact
  committed tree.

The diagnosis was right about the cause and right about the remedy; nothing in
it needed rediscovering. One correction to its path note: passing the store to
`prepareFrame` is not enough on its own — `prepared()` hands `commitReplFrame`
the stores, and until that call carried the chat one too, a visible chat still
refitted every line. That is recorded under "first failures".

## The measured work

### What was done

**Cache ownership.** `createPlainFitStore()` in `fitting.ts` holds plain-text
line cuts. The running command creates one in `runReplProgram` beside the
existing `createFitStore()` and threads it through the real paint path —
`paint` → `prepared` → `commitReplFrame` → `prepareFrame` → `fitPlain` — and
through the two geometry-pass `prepareFrame` calls as well. Two stores rather
than one slot: the entry reading's geometry reserves a rail and a status column
that plain text has neither of, and sharing one slot would make the entry
reading and the chat evict each other every time somebody looked at the other
pane. It lives exactly as long as the command.

**Exact-input reuse, per line.** A cut is keyed by the line's exact text, the
measured room and the terminal's columns and rows — every input `fitLine`
actually uses. Nothing is digested; a string comparison is far below one render.
Per line rather than per list, which is the point: the newest Preview line grows
on its own and a message is appended on its own, so a whole-list answer would
remeasure every older message for every delta. Keys, text and token runs are
this frame's; only geometry is retained, so a reused cut decorates the current
line rather than restoring a row somebody drew earlier.

**Retention bound.** One set of measured dimensions at a time: a room or size
that moves empties the store, because cuts taken at another width answer a
different question. After a preparation succeeds, `settle()` replaces the
retained set with exactly the set that preparation prepared — a replaced Preview
version and a message that is gone leave rather than accumulating for the
command's life. A failed or cancelled preparation calls `settle()` not at all:
the individually completed cuts are exact answers and stay, and the set it never
finished is never published as one. No process-global or durable cache, no timer,
no hash-only equality, no cache of every historical size or chat.

**Hidden chat.** `prepareFrame` asks the frame it just measured whether its
manifest published a `SIDEKICK_WINDOW` viewport, and fits nothing when it did
not. That is the existing presentation's own answer rather than a second
pane-selection rule. A wide frame showing Bindings has a positive inspection
width and describes no chat row at all, which is why fitting there measured text
nobody was going to draw. Showing or revealing the chat publishes that window
again, and that pass fits current text against current geometry before anything
is admitted or drawn.

**Unchanged.** Every width still comes from the engine; graphemes, literal
whitespace and newlines, and the refusal behaviour are untouched. The one
prepared fitted list still feeds descriptions, row counts, scrolling and the
Sessions turn reveal. No renderer replacement, no weakened validation, no string
-length approximation, no journal or agent-work change, no performance framework.

### What it measures

Mounted, through the unchanged diagnostic, median of five typed keys:

| Actual mounted state | At 39c24f37 | At 13c4900d |
| --- | ---: | ---: |
| Empty chat | 15.56 ms | 4.89 ms |
| One reply, 20 wrapping lines | 39.25 ms | 6.31 ms |
| Two replies, 100 wrapping lines | 151.97 ms | 9.69 ms |
| Same two replies, Bindings selected | 150.98 ms | 5.97 ms |

One presentation per key and none while idle, as before. Local diagnostic times,
not portable thresholds — the discriminating evidence is the counts below.

## RS3–RS5

Added beside RS2 in `repl-presentation-style.test.ts`, through
`useCountingRenderer`, the real tree, `commitReplFrame` and the same two stores
the command owns. Counts, not milliseconds.

| Row | Measured |
| --- | --- |
| `RS3: typing reuses an unchanged chat, however long it is` | A twelve-message wrapping chat costs **728** renders to warm and **4** to type into; a three-message chat costs 11 and **4**. Draft-only and Message-only frames both cost 4 for both chats, so the count does not grow with history the keystroke did not change. The typed drafts, the typed message and the first reply's own opening are on the screen. |
| `RS4: growing one line measures only the line that grew` | Baseline **4**. Growing one final line costs **133**, and fitting that line alone at the same measured room (35) costs **129** — exactly the difference. Appending one message costs **64** against **60** alone. The same fixture carries a blank line and a combining/wide grapheme, and the warm frame's mounted chat keys equal a cold store's exactly. |
| `RS5: a hidden chat is not measured, and showing it measures what is there` | Behind Bindings a twelve-message wrapping chat costs **4** to type into, which is what an empty chat costs — from the first frame, not only once warm. Shown, it is fitted and its rows are drawn. Resize, a different chat's text and a replaced final line each produce the rows a cold store produces, and the replaced chat's own last reply is on no row of the screen. |

Before this commit RS3's long chat would have cost ~728 renders per keystroke
rather than 4, and RS5's hidden counts would have matched the visible ones.

## The three correctness items

**CF-P1 — each chat keeps its own reading.** `ReplViewports.sidekick` is now
`Readonly<Record<string, number>>` and `sidekickFollowing` likewise, both keyed
by the chat being read — `view.live.sidekick.reading`, the reading itself rather
than the route's selector, because the current chat is the *absence* of a
selector and an absence is not a key. `scroll-sidekick` writes only the chat
this frame is reading. A chat with no entry follows and sits at row zero, which
is where a fresh reading starts. Explicit turn reveal still takes precedence and
read-only ownership is unchanged. No URL member, durable record, second focus
store or scroll service.

The unchanged paired probe now passes both arms:

```text
{"scrollOlder":true, "before":{"from":5,"more":false}, "after":{"from":5,"more":false},
 "currentAtTailAfterBack":true, "newestCurrentMounted":true}
{"scrollOlder":false, … identical …}
```

At 39c24f37 the first arm returned `from 2, more true` with the newest current
reply absent.

Permanent rows, in the CF tier, on two real conversations built through the
product (ten exchanges, an agent replacement, ten more — two lines per reply so
both overflow their window):

- `CF-P1: scrolling an older chat leaves the current chat's own reading alone`
- `CF-P1: control — a deliberate current reading also survives the visit`

**CF-E1 — the held live-growth witness is permanent.**
`CF-E1: a held reply grows into another row, and settles in the same item`
holds generation after thirty literal Output rows, grows another visual row with
`terminal.fed` unchanged, observes that no response is saved yet and that the
preview's earlier rows moved up rather than being drawn over, then releases and
shows `response:1` with `TAIL-LAST` still visible and both composers exactly as
they were left. The external probe stays unchanged and green.

**Prose.** `architecture.md` and `specs/repl-spec.md` said header chrome costs
the rows beneath it nothing. They now state that the header's edge is a row the
engine takes out of the band, that a titled column therefore holds one row fewer
of its reading, and that the footer still keeps seven rows because the edge is
the header's. `rowBox`'s own comment in `application.ts` carried the same claim
and was corrected with them.

## Every command, and its exact result

| # | Selection | Result |
| --- | --- | --- |
| 1 | Sidekick storage + recovery | `12 passed (63 steps), 0 failed` |
| 2 | controls, output, entries, route, history | `46 passed (194 steps), 0 failed` |
| 3 | Sidekick journey/lifecycle, agent journey, forms, lifecycle, source-reading | `36 passed (187 steps), 0 failed` |
| 4 | configuration, presentation, help, layout-admission, exit-pty, presentation-style | `48 passed (178 steps), 0 failed` |
| 5 | repl-journey, agent-interface, execution | `58 passed (142 steps), 0 failed` |
| 6 | the five unchanged Preview/Sessions probes | `5 passed (10 steps), 0 failed` |
| 7 | `repl-boundaries.test.ts` | `4 passed (26 steps), 0 failed` |
| 8 | unchanged header-edge probe | `1 passed (2 steps), 0 failed` |
| 9 | unchanged chat-flow probe | `1 passed (3 steps), 0 failed` |
| 10 | unchanged chat-reading probe | `1 passed (2 steps), 0 failed` |
| 11 | unchanged chat-live-growth probe | `1 passed (1 step), 0 failed` |
| — | unchanged mounted latency diagnostic | `1 passed (1 step), 0 failed`; times above |

`deno task check` passes. RS3–RS5 run inside command 4's
`repl-presentation-style.test.ts` selection. **Both real-PTY rows in command 4
passed here**, and the M1 focus assertion did not recur — I report that rather
than explain it, and attempted no repair for either. L2/U2 did not recur. No
broad lint/JSR/runtime suite, CI, capture, push or GitHub write. No dependency,
cache, lock or discovery change, and no assertion weakened.

## First failures, preserved

**The store reached `prepareFrame` but not the commit.** The first measured run
after the plumbing showed hidden typing at ~4.2 ms and *visible* typing still at
~157 ms. `prepared()` calls `commitReplFrame` with `store` and I had not added
`chat` to that one call, so every visible frame still refitted everything. One
argument; the whole remedy depended on it. Worth stating because the symptom
looked like a cache that did not work rather than a cache that was not reached.

**`fitPlain`'s own first result.** `held()` keyed on text alone matched, but the
first implementation called `settle()` before checking the result of the loop;
corrected so a failed preparation publishes no set.

**New-test mechanics, none of them product facts.** RS3's draw assertion read
one frame's bytes rather than the accumulated screen — this renderer writes
diffs, so the commanding fixture now owns one grid across its frames. RS4/RS5's
mounted-key filter used `sidekick:chat:` where the fixture's own keys are
`sidekick:chat-one:`. CF-P1's first form gave each chat ten single-line replies,
which fit the window, so there was no position to lose; the replies are two
lines each now. CF-P1's control compared the whole pane and so compared the
composer's focus marker; it compares the reading between the two window
controls. CF-E1's first scripting held at the first delta and streamed nothing;
it now follows the external witness's own two-piece `holdAfter: 2` recipe.

## One adaptation to report

`ReplViewports.sidekick` changed shape from `number` to a per-chat record but
**kept its name**. The unchanged `pr2-sessions-reveal-probe-4ee4f448.test.ts`
logs `state.viewports.sidekick`, and renaming the field to `sidekicks` broke
that probe's typecheck — command 6 failed to compile. The probe must stay
unchanged, so the field keeps the pane's name and its keys are that pane's
chats. The probe compiles untouched and now logs the record instead of a number;
it asserts nothing about either, and no production behaviour turns on the name.

## Not done, and why

The composer addendum added to the prompt while this was in flight
(`pr2-sidekick-message-composer-planner-addendum.md`) states that its height cap
awaits the Product Owner and that it is not released for implementation. Nothing
here chooses that cap or touches the Message composer's wrapping.
`REPL_DESCRIPTION` and `SIDEKICK_QUIET` remain outside this assignment as
directed. The old frame diagnostic was not rerun or rewritten; its store
plumbing predates chat retention, as the prompt notes.

## Continuity

Latest revision for review: **`13c4900dbf0c4e57411241ada84aa00f4b55ba65`**,
parent `39c24f37`. Teaching, the 36-frame packet and delivery remain separate.
