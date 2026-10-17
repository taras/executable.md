# A successful control-only reply is out of the chat

Implementor handback for
[the control-only reply handoff](pr921-control-only-replies-implementor-handoff.md)
and [the Architect decision](pr921-control-only-replies-architect-decision.md),
based on the reviewed padding successor `6ca23952`. Both focused selections
pass. Nothing pushed, nothing rebased.

## The successor

```
SHA     2ac3cb28778c19d25c2b98e540469c2aa9e9b784
parent  6ca239527abe9d012be01fffc79197e882c52ca3
tree    8aaa6b36967461e3e9d686518da5ea33592016ca
sig     G, tarasm@gmail.com
subject 💄 Leave a REPL reply that only ran controls out of the chat (#883)
```

Worktree clean, nothing untracked. `agent/issue-883-pr2-main-integration` now
`2ac3cb28`. Every safety ref unmoved — `agent/issue-883-pr1-main-integration`
`85da74b9`, `agent/issue-883-pr1` `79d404d0`, `agent/issue-883-pr2` `d4b0e326`,
`agent/issue-883-pr2-isolated` `99c27d92`,
`pre-integration/issue-883-pr2-d4b0e326` `d4b0e326` — and both `6ca23952` and
`85da74b9` remain reachable from this head.

## Results

| Command | Result |
| --- | --- |
| 1 — sidekick presentation, journey, lifecycle | **39 passed (139 steps), 0 failed**, exit 0 ([log](pr921-control-only-cmd1.log)) |
| 2 — sidekick recovery, controls, output | **20 passed (100 steps), 0 failed**, exit 0 ([log](pr921-control-only-cmd2.log)) |

`deno task check` exit 0. `deno task lint` exit 0, warnings only, dead-code gate
included ([log](pr921-control-only-lint.log)). `deno task validate:docs`
reports documentation complete. Both selections were run again after the last
edit, so every result above is the committed tree.

First outputs preserved: [the one superseded assertion](pr921-control-only-cmd1-first.log),
and the two first failures of the new rows
([ER1](pr921-control-only-er1-first.log), [ER3](pr921-control-only-er3-first.log)).

The only pre-existing failure the change produced was the superseded PV1 notice
assertion — one failure in command 1, nothing else, with command 2 green from
the first run.

## ER1–ER5 mapping

| Row | Where | Observed |
| --- | --- | --- |
| ER1 | `repl-sidekick-journey.test.ts` Tier PV | Real mounted Send. A reply running `<REPL.Bindings />` and `<REPL.Environment />` with no Output, then the automatic follow-up carrying their results, which also says nothing and runs nothing. `you: look` stands; no notice, no `(preview)`, no source, and nothing of the follow-up's own text. The composition — read from the files the command wrote, through the same projection and composition the screen is built from — is exactly `["  you: look"]`, which is the question a screen search cannot answer: an empty row, a bare name and a metadata sentence are all rows. Both control results reached the next prompt, under their own headings, in admission order, with `a controlled mounted host` in it. Both turns saved and `completed`, `asked` `person` then `automatic`, both replies `hasOutput: false`, both operations `ok`, the delivery established for turn 2, and Sessions still `look · completed` / `Automatic feedback · completed`. |
| ER2 | same file, the existing PV1 row | Unchanged fixture: the same control-only reply followed by explicit Output. The notice assertion is replaced by its negation plus `scribe: Read it.` shown in its own row, and the composition is exactly the two rows `you: look` and `scribe: Read it.`. The row's existing preview and identity claims are untouched. |
| ER3 | same file, Tier PV | A real evaluated failure with no Output: `<REPL.Delete />`, a name the ceiling does not admit, which refuses the whole reply. The screen shows `scribe (failed):` carrying the reason the record holds — the reason is read out of the history and then looked for on the screen, so a fabricated sentence could not pass — and the saved outcome is `reply failed`. The correction it was given answers, and the composition is the request, the failure and `scribe: Fixed it.`, in that order. |
| ER4 | `repl-sidekick-presentation.test.ts` **Tier ER** (new) | A populated chat: a silent control-only turn, its silent automatic follow-up, a turn that spoke, then ten ordinary turns, then a real agent replacement and a second chat, a real entry and both composers left partly typed. Selecting the silent turn from Sessions opens that older chat on `you: run it`; `ANSWER-10` is absent, which is what says the window was placed rather than left following its newest rows. `you: say it` is the very next row — no empty row, no bare name, no notice between the two turns whose replies said nothing. The follow-up reveals the same person request and not the machine input it carried. The turn that spoke still reveals its own `SPOKE-ALOUD`. All three keep their Sessions titles and status, the read chat is distinguished from the current one (`Newer answer.` absent, `[Back to current chat]` present), and Back restores the entry, the draft and the half-typed message. |
| ER5 | same file, Tier ER | One history holding all three shapes — the silent exchange, the failure and its correction, and a turn that spoke — with eight ordinary turns after them, written by a real command that then exits. Reopened cold through `runReplProgram` over the same root: the failure is still a failure with its recorded words, the Output still speaks, both silent replies are still absent, and selecting either of them still reveals `you: run it` with the newest reply off-window. The provider was asked nothing further, opened nothing further, and the chat file's bytes are identical before and after. |

Rows share fixtures as the handoff allows; ER1–ER3 are three rows in the
existing mounted Tier PV and ER4–ER5 are one new tier of two.

## Break-it controls

Both new behaviours were checked against their own absence, because a row
asserting that something is *not* on the screen is the kind that passes for the
wrong reason.

- Restoring the notice, with the suppression left in place but disabled: ER4
  fails on the adjacency of the two requests — the two silent replies insert two
  rows, 5 where 7 is expected.
- Restoring `failure: undefined` in the reply projection: ER3 fails, and the
  recorded failure disappears from the chat entirely while Sessions still reads
  `remove it · reply failed`. That is precisely the hazard the Architect's
  contract 3 names, and it is now caught.

## What changed

- **`application.ts`** — the reply branch of `sidekickComposedRows()` is three
  answers instead of two: a recorded failure says so with its reason, and keeps
  any Output it had rendered *after* the reason; a successful reply with no
  Output contributes nothing; anything else is the reply it always was. Nothing
  filters by `hasOutput` globally: `person`, `preview`, `incomplete` and `saved`
  are untouched, so the preview, the unfinished attempt and
  `Turn saved; no evaluated reply recorded` all read exactly as before.
- **`revealedAt()`** — the candidates for a turn are now the items this reading
  holds, in the order they answer what the turn is: its own result, its own
  request, then the request it answered. The offset is the first of them that
  appears in the rows the frame fitted, so a reveal cannot target a row nothing
  paints, and nothing is composed to be landed on.
- **`program.ts`** — `sidekickChatRows()` carries the reply's retained failure
  through instead of discarding it, and names the request each reply answered.
  Two small helpers beside the two key helpers already there: `messageKey()` and
  `requestOf()`.
- **`sidekick/model.ts`** — one new projection member, `answers`: the person
  request each saved turn answers, derived from the request boundaries
  `requestsFromHistory()` already establishes. A message request answers itself;
  a feedback request answers the person request its conversation was last asked
  by, which is how an automatic follow-up reaches an existing message instead of
  having its machine input printed as somebody's words. A turn with no bounding
  request is absent rather than guessed at. No record, URL member, event or
  durable map holds any of it.

### One file outside the stated boundary

`sidekick/owner.ts` has a **one-line** change: the `EMPTY` constant — the
reading a legacy execution with no history projects as — gains
`answers: Object.freeze([])`. That is type completeness for the new member and
nothing else; the alternative was making `answers` optional, which would have
let a caller read absence as a default. No owner scheduling, lifetime, feedback
routing or evaluation behaviour is touched. Flagging it because the handoff
named `application.ts`, `program.ts` and `sidekick/model.ts` as the boundary.

## Naming

`answers` on `SidekickReading` and `request` on `ReplSidekickChatRow` are both
new names for derived presentation, chosen to sit beside the projection's
existing `delivered` / `unestablished` family and the row's existing `retry`.
Neither is retained, and nothing durable carries either. Say so if you would
rather they were called something else; renaming them touches three files.

## Documentation

`specs/repl-spec.md`: the reply paragraph now distinguishes three endings — a
success that said nothing and shows nothing, a failure that keeps its reason
whether or not it spoke, and the saved turn whose evaluated reply nobody
recorded — and the reading-a-previous-chat section says a reveal lands only on a
row that chat draws, falling back to the request the turn answered.
`architecture.md`: why that fallback is what makes the suppression safe, and
that the association is derived from the request boundaries rather than held
anywhere.

## Limitations

- **A reveal lands its row at the foot of the window**, which is existing
  behaviour this correction did not change. For a wrapped failure reason that
  means the first fitted row is on screen and its continuation is below; ER5
  reads the prefix and says so rather than asserting a row the frame did not
  draw.
- **A turn whose containing request the history cannot bound reveals nothing.**
  That is the Architect's bounded unknown-association rule followed as written:
  no row is composed, no request is chosen by resemblance, and the selected
  turn keeps its Sessions status. No fixture in this repository currently holds
  such a history for a *successful silent* reply — the existing
  "a turn no request bounds has no title" corpus is about a saved turn with no
  reply — so the branch is covered by construction and by the absent
  association, not by a row of its own.

## Next

Stopping for review of `2ac3cb28`. On acceptance this is PR2's delivery source
together with the padding successor, and delivery follows
[the updated handoff](pr890-pr921-final-delivery-implementor-handoff-27da762b.md):
recheck current main, rebase PR1 first, carry PR2's commits through both
reviewed UI successors, complete the delivery gates and the EH1/UI10 obligation,
and publish through #890/#921. No UI scope remains.
