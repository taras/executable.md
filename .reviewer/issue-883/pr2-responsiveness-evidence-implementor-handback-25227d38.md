# Implementor handback: finish the responsiveness evidence (#883)

**Feedback commit: `25227d38cb8087743cd404533c7960de9423a442`.**

- Parent: `13c4900dbf0c4e57411241ada84aa00f4b55ba65`, preserved, as are all its
  ancestors. No amend, reset or rebase.
- Branch `agent/issue-883-pr2`; signature **G**, `tarasm@gmail.com`.
- Tree clean at `25227d38`; nothing unstaged, nothing untracked.
- **Two files, +225 / −98: `repl-presentation-style.test.ts` and
  `architecture.md`.** No production change, as the correction expected. All
  three findings were accurate and none exposed a defect.

## RS-P1 — the cast is gone

`chatOf` no longer asserts into `ReplSidekickReading`. It builds a
`const reading: ReplSidekickReading = { … }` — an annotation, so the compiler
checks the literal rather than being told to accept it — and freezes that. The
chat rows come from two small typed builders, `replyRow` and `previewRow`, each
declaring `ReplSidekickChatRow`, with `repliesOf` for the common case. Same
values, no replacement cast anywhere, and `grep` for `as ReplSidekick` in that
file returns nothing.

## RS-E1 — the omitted observations

**RS4 now grows an existing candidate.** The fixture's final item is a
`previewRow` under the key its reply will carry; the growth changes that item's
own text and leaves the key alone, and the append adds the next item behind it.
The blank-line and combining/wide-grapheme lines stay.

The cost comparison is unchanged in form and still exact:

```
{"baseline":4,"growing":141,"appending":64,"grownAlone":137,"appendedAlone":60,"room":35}
```

`141 − 4 = 137`, which is what fitting that grown line alone costs at the same
measured room; `64 − 4 = 60` likewise for the appended one. Prior lines are
reused.

The warm/cold comparison now reads the **prepared rows**, not mounted keys:
`prepareFrame` with the command's two stores against `prepareFrame` with none,
compared on key, logical line and text, plus row count. It also recovers the
grown line's whole text by concatenating its own rows — `GROWING` through
`TAIL-GROWN` — and asserts the text it replaced is in none of them.

One thing the correction's wording made me re-aim: the visible-text observation.
A following chat shows a growing line's *newest* rows, so the start of the grown
text is legitimately off the window. The row marks the grown line's new end and
observes that, which is where the text that just arrived actually is.

**RS5 asserts the first hidden frame.** Both the long-chat and empty-chat
commands are built the same way and warmed the same way, so the comparison is
chat work and not entry warmup:

```
{"hiddenLong":{"first":8,"typed":4},"hiddenEmpty":{"first":8,"typed":4}}
```

First frame **8 = 8**, warmed typing **4 = 4**.

**RS5's sequence now switches chat and withdraws a candidate.** The second step
is `chat-two` — its own `conversation`, its own `reading`, and rows built under
that conversation — and the third withdraws the candidate the second step
really had. At each transition the prepared rows, their text and their count are
compared with uncached preparation. Then: every prepared row of the second chat
belongs to `sidekick:chat-two:`, the first chat's reading is in none of them,
and the withdrawn text is in neither the prepared rows nor any cell of the
screen. The resize and hidden/showing observations are unchanged, and no
scenario was added.

## RS-D1 — the retained geometry is documented

One paragraph in `architecture.md`, beside the existing chat-fitting
description: two independent command-owned stores and why they cannot be one
slot; reuse only for an exact text, room and terminal size; retention per line
rather than per list and the reason; pruning to the set a completed preparation
prepared; a failed or cancelled preparation publishing no set while its
completed cuts stay exact; discarding on a dimension change; fitting nothing for
a frame whose manifest publishes no chat window, and fitting current text
against current geometry when it is shown again. Implemented behaviour, present
tense, no benchmark numbers, no new terminology, no public specification change.

## The focused command, and its result

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-sidekick-presentation.test.ts
```

`ok | 34 passed (104 steps) | 0 failed (1m45s)` — run against the committed tree
`25227d38`, so no claim here predates it. That covers RS2–RS5, CF-P1, CF-E1,
CF1–CF3, TE4 and the mounted geometry rows. `deno task check` passes.

Nothing else was run, as directed: the eleven selections, the external probes
and the latency diagnostic were not repeated for a tests-and-prose correction.
No assertion weakened; no dependency, cache, lock or discovery change; no broad
lint/JSR/runtime suite, CI, capture, push or GitHub write. The PTY limitation
and the open M1 flake stayed outside scope.

## First failures

**RS4's first visible-text assertion** looked for the start of the grown text on
the screen and did not find it. Not a defect: the chat was following, so the
window held that line's newest rows. Re-aimed at the grown line's new end, which
is the text that had just arrived. Noted here because the first reading of it
looks like missing text.

**Two compile failures of my own**, both in the new fixture: `ReplSidekickChatRow`
and `ReplFittedLine` needed importing once the cast was removed and the
prepared-row comparison was added.

## Continuity

Latest revision for review: **`25227d38cb8087743cd404533c7960de9423a442`**,
parent `13c4900d`. The composer height cap still awaits the Product Owner, so
that addendum stays unreleased and nothing here touches the Message composer.
Teaching, the 36-frame packet and delivery remain separate.
