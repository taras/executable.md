# Implementor handback: d634b28b correction (#883 PR 2)

Executed the [correction](pr2-terminal-completion-implementor-correction-d634b28b.md)
and the [chat-flow addendum](pr2-chat-flow-planner-addendum-d634b28b.md) from
signed clean `d634b28b`, parent `ab681d4a`. All four assigned items are done:
the two header edges, the chat fitting and following, the `--sidekick-agent`
spelling, and TE5's attribution.

**Correction commit: `39c24f37fdb967c3aa90870f9b4e22e536dc0fec`.**

- Parent: `d634b28b24afa9a16a0a10ec7906c09d924c9db9`, preserved, as are all its
  ancestors. No amend, reset or rebase.
- Branch `agent/issue-883-pr2`; signature **G**, `tarasm@gmail.com`.
- Tree clean at `39c24f37`; nothing unstaged, nothing untracked.
- 18 files changed. All nine commands below were re-run against this exact
  committed tree, so no claim here rests on a run that predates it.

## 1. T-P1 — the two header edges are drawn

The finding was correct and I had under-delivered it: I read "header/footer
edges" as the one rule that already existed (the body/footer divider) and gave
the headers a fill only. The accepted reference has a bottom edge on both
headers, and the probe proved neither was drawn.

`headerBandProps()` in layout.ts is the band a pane's header rows sit in: its
height is the rows plus one, and its `border.bottom` is `chromeEdge`. The engine
takes that row out of the box, exactly as `bodyProps` already does for the
footer rule, so the measuring pass and the committed frame account for the same
decoration and the rows below are built to what is left. `headerBand()` in
application.ts wraps the transcript's title, and the right column's title and
both tabs, in one band each — the right pane's title and tabs are one header, so
they take one edge between them, as the browser reference's tab header does.

Nothing else moved: no row is subtracted in one pass only, the footer still
holds seven rows, the narrow frame draws no band at all because it names no
pane, and no unrelated body cell was painted.

**The reviewer's probe passes, unchanged:**

```text
{"headerChrome":{"transcript":91,"inspection":35},"footerChrome":160}
ok | 1 passed (2 steps) | 0 failed
```

91 and 35 are each column's own content width, so the edge spans the header
rather than marking a corner.

**TE4 completed.** `TE4: each pane, header, divider and edge is the accepted
value in its own cells` now reads, at 160x36 and 120x30 under both tabs: each
header's edge at three columns across the band, both header fills, the
transcript body, both one-cell dividers down every row of their panes, the
footer edge, the footer's seven rows, and the selected tab's text. It also
samples the sidebar and right-pane body fills directly, at each one's own
measured window floor, rather than leaving them to the older assertion. The
narrow row is unchanged.

**One row is the price, and it is the accepted one.** A horizontal rule in a
terminal is a cell row, so each of the two columns holds one row fewer than
before. That is what the plan's "any border space belongs to the boxes that
measure and draw it" settles, and it is why two existing assertions moved; both
are described under §4.

## 2. The spelling correction is applied everywhere active

`sidekit` → `sidekick` across every tracked file that held it: **43 occurrences
in 10 files.** No capitalized `Sidekit` existed.

| File | Occurrences |
| --- | --- |
| `packages/cli/src/cli.ts` | 7 — `replConfig` field, `REPL_VALUES`, the unrecognized-option roster, the doc comment and the dispatch wiring |
| `packages/cli/src/repl-profile.ts` | 4 — `ReplProfileFacts.sidekickAgent`, its lookup and two doc comments |
| `packages/cli/tests/cli-help.test.ts` | 10 — accepted, missing, empty and equals forms |
| `packages/cli/tests/fixtures/repl/issue-883/mounted-program.ts` | 7 |
| `packages/cli/tests/repl-sidekick-configuration.test.ts` | 7 — including the independent-selection fixture input |
| `packages/cli/tests/repl-boundaries.test.ts` | 2 — the value roster and the spec examples |
| `specs/repl-spec.md` | 3 |
| `packages/cli/tests/fixtures/repl/issue-883/recovery-phase.ts` | 1 |
| `packages/cli/tests/fixtures/repl/issue-883/sidekick-harness.ts` | 1 |
| `architecture.md` | 1 |

**Final audit of the tracked tree: `git grep -i sidekit` returns nothing.**

Verified against the real CLI rather than only the tests:

```text
$ deno task xmd repl --help
   --sidekick-agent [SIDEKICKAGENT] agent name for the Sidekick's own conversations

$ deno task xmd repl --sidekit-agent claude
unrecognized option for xmd repl: --sidekit-agent — xmd repl takes one optional
location, the agent options …, and --sidekick-agent for the Sidekick's own
conversations

$ deno task xmd repl --sidekick-agent
xmd repl: --sidekick-agent requires a value
```

The retired spelling is refused by the existing unknown-option path and is not
an alias. Separated and equals values both work, a missing or empty value is
refused before host effects, and independent entry/Sidekick precedence and
saved-agent reopening are unchanged. No journal record or persisted identity was
renamed; no generated or current asset carried the old spelling.

## 3. Chat messages keep their rows, and the chat follows the newest

Both reported problems reproduced at the base from the preserved probe, and both
are fixed. The probe passes unchanged:

```text
ok | 1 passed (3 steps) | 0 failed
```

**Fitting.** The chat had no prepared fitted-row list. One composition now
serves everything: `sidekickComposedRows()` builds each item as text-to-read or
a control before any width is known; `chatLinesOf()` splits a message on its own
line breaks, because a break is content and a width is not; `sidekickChatLines()`
hands that list to `fitPlain` during frame preparation, at the pane's own
measured width — `widths.inspection` wide and medium, `widths.list` narrow; and
`sidekickReadingRows(reading, focused, fitted)` cuts the composition with it.
The descriptions, the window's row count (`totalOf`) and a Sessions turn reveal
(`revealedAt`) all read that one fitted list, so a drawn row and the row a
scroll clamps against cannot be different rows. A continuation carries its
message's style, the fitting's derived key and the hanging indent the cut
reserved, and is not a new message, turn, response or record. The measuring pass
has no fitted chat, exactly as it has no fitted reading or preview.

`ReplFittedLine` gained one field, `line`, naming the logical line a row is a
piece of. `ReplPreparedRow` already carried it; surfacing it is what lets a
caller find its own item again without parsing a key apart.

**Following.** `ReplViewports.sidekickFollowing` starts true. `offsetFor` returns
`max(0, total - capacity)` while it is set, recomputed from the rows this frame
fitted — a flag rather than a stored number, because what "the bottom" is
changes with every arrival. `scroll-sidekick` sets it from where the press
lands: leaving the end stops following, reaching the end resumes it. An explicit
Sessions reveal still takes precedence. Nothing is added to the location.

Preserved: line breaks, blank lines, whitespace, graphemes; response identity
across streaming and settlement; exact parent keys and cross-chat ownership; the
disclosure gate (fitting reads already-cleared literal text). No pane was
widened, no renderer check weakened or disabled, no line break escaped away, and
no scrolling framework, second host or public API was added.

### CF1–CF3

| Row | Permanent test |
| --- | --- |
| CF1 | `CF1: a message with its own lines keeps every one of them when the next arrives` — two real exchanges; explicit breaks, a blank line kept as its own row, and a line wider than the 36-column pane cut across rows; order and disjoint rows; headers, composer and footer intact; both saved texts complete. The existing short-message control is the probe's own second step. |
| CF2 | `CF2: a chat whose window filled shows its newest reply, at every size` — twelve acknowledged exchanges; the newest reply at 160x36 with `terminal.fed` unchanged, then 120x30, then the narrow outlet asked for explicitly; the first exchange off the window but in the history that was just read; the earlier messages reached again with the pane's own control. |
| CF3 | `CF3: a reading somebody scrolled to stays put while the next reply saves` — scrolled back deliberately, the next response held at the transport and released, the reply saved while the pane's rows are byte-identical to before it; then the end reached again and the arrival after it shown with nothing pressed for it. |

Both live in `repl-sidekick-presentation.test.ts`, on the existing mounted
fixture. No new mutation battery.

## 4. Assertion and fixture adaptations

Three, each reported rather than erased. All were caused by the correction and
all keep their original claim.

**`SS6: a real automatic turn nobody answered opens as its own inert anchor`.**
It asserted the status over two rows, the second carrying the whole tail — which
is what an unfitted row produced by overflowing into the row beneath it. The
pane now cuts at its own word boundaries, so the sentence is three rows. The
assertion rejoins the anchor's consecutive rows and compares them to
`SAVED_WITHOUT_REPLY` exactly, which is stronger than the two substring checks
it replaces.

**`J1: a second process reconstructs the view from the URL and the journal
alone`.** Two changes, and the second is a finding worth stating plainly.

- The Esc that closes the drawer was followed by `settled(30)`, a counted wait.
  Growing the frame by one box put the close past that count. It now waits for
  `[close]` to be gone.
- It then asserted `plan = ` — the Bindings **column's** spelling. This
  location carries `right: undefined`, so the reconstruction selects the
  Sidekick and that column is never drawn in this frame; scrolling the
  transcript 60 rows does not find the row either. **The assertion was matching
  text an earlier frame had left on the reconstructed screen**, which the new
  header edges happen to overwrite. The same claim — the retained binding value,
  read from the file — is now asserted in the drawer this location named and
  which the row already proves is open: `Binding · plan` and
  `"title": "Ship the REPL"`. Nothing about reconstruction is weakened; one
  assertion stopped depending on a stale cell.

**`P1-T3`** keeps the #883 adaptation from the previous revision, unchanged.

## 5. TE5 — the two corrected descriptions

**The R6 authoritative-classification row.** My earlier mapping cited an
unsupported form-schema refusal and a cancelled waiting save. Neither tests
fatal failure classification, and the correction is accepted. The actual
retained boundary, stated as **previously reviewed evidence and not a command
run in this slice**:

- `packages/core/tests/agent-conversation.test.ts` — **CV32**: a journal that
  stops describing the run is not a reply worth correcting.
- `packages/core/tests/agent-conversation.test.ts` — **PV5**: an observer that
  throws fails the run and leaves no record of the turn.
- The accepted owner/Preview review, which preserves the raised authoritative
  failure path and held-cleanup return ordering.

No new Core test, suite or failure permutation was added or run.

**Command attribution.** CFG5 and the CLI/configuration rows run under
**command 4**, not under R6's command-3 heading or R7's command-2 heading. The
rest of TE5's accepted layered mapping stands as handed back, with
`--sidekick-agent` as the current flag wording throughout. R7's argv row is
`C2: repl states its own Sidekick agent option, and names a value or refuses`
plus `CH13`, both command 4, and the boundaries selection added by this
correction covers the value roster and the executable spec examples.

## Every command, and its exact result

Run against the committed tree from the implementation worktree.

| # | Command | Result |
| --- | --- | --- |
| 1 | storage + recovery | `12 passed (63 steps), 0 failed` |
| 2 | controls, output, entries, route, history | `46 passed (194 steps), 0 failed` |
| 3 | journey, lifecycle, agent-journey, forms, lifecycle, source-reading | `36 passed (187 steps), 0 failed` |
| 4 | configuration, presentation, cli-help, layout-admission, exit-pty, presentation-style | `47 passed (172 steps), 0 failed` |
| 5 | repl-journey, agent-interface, execution | `58 passed (142 steps), 0 failed` |
| 6 | the five unchanged Preview/Sessions probes | `5 passed (10 steps), 0 failed` |
| 7 | `repl-boundaries.test.ts` | `4 passed (26 steps), 0 failed` |
| 8 | the header-edge probe | `1 passed (2 steps), 0 failed` |
| 9 | the chat-flow probe | `1 passed (3 steps), 0 failed` |

`deno task check` passes. No L2 or U2 recurrence appeared in any run. No
dependency, cache, lock, runtime-discovery, unrelated flake or lint change was
made to obtain a pass. Broad lint/JSR/runtime suites, CI and captures were not
run and are not claimed. The seed diagnostic was not run as a regression.

**On the real-PTY rows:** command 4's two `repl-exit-pty` rows pass here. The
review environment's missing-socket failures did not reproduce in this worktree;
I report that difference rather than explaining it, and no production repair was
attempted for it.

## First failures, preserved

**The header-edge probe at d634b28b** (the reviewer's, re-run before any edit):
`headerChrome: { transcript: 0, inspection: 0 }`, `footerChrome: 160` — the
header regression failing and the footer control passing.

**The chat-flow probe at d634b28b:** the multiline row lost `first-B`/`first-C`
when the second exchange arrived, and the overflow row showed `ANSWER-1` through
`ANSWER-10` with twelve saved and `ANSWER-12` never reaching the screen. The
short-message control passed. Both are in the Planner's preserved log and I
reproduced both before changing anything.

**My own first failures while implementing**, all fixture mechanics rather than
product facts: `fitPlain` cuts by width and not by line breaks, so the first
fitting attempt left the breaks inside one row (fixed by splitting on them
first); the fitted hanging indent was dropped on continuations (applied); CF
clicks on `[↑ earlier]` reached the sidebar's control of the same spelling
(scoped to the pane's columns); and CF2's narrow step tried to activate a tab a
narrow frame does not draw (the route is taken while the tab exists, then the
frame shrinks).

## Out of scope, unchanged

`REPL_DESCRIPTION`'s singular entry and the unused `SIDEKICK_QUIET` remain as
the review left them: non-blocking, and not repaired here.

## Continuity

Latest revision for review: **`39c24f37fdb967c3aa90870f9b4e22e536dc0fec`**.
Base `d634b28b`, parent of this commit. Every ancestor preserved; no amend,
reset or rebase. No push, PR, GitHub write, CI inspection or capture. Teaching,
the 36-frame packet and delivery remain separate.
