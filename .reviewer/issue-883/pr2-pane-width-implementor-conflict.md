# Returned conflict: the accepted Transcript share cannot hold its own sentences

**No feedback commit.** Head is still accepted `25227d38cb8087743cd404533c7960de9423a442`,
parent `13c4900d`, branch `agent/issue-883-pr2`, signature G. The composer work
and the width rule are **in flight in the worktree, preserved** — nothing was
amended, reset or discarded. The assigned evidence does not pass, so there is
nothing to review yet.

The composer slice is complete and green. The width amendment is implemented
exactly as its table states, and it breaks six existing accepted rows whose
repair is a product choice I must not make.

## The conflict

The amendment halves the Transcript. Inner widths, after each pane's divider:

| Frame | Transcript inner, before | after |
| --- | ---: | ---: |
| 160x36 | 91 | 63 |
| 120x30 | 63 | 45 |

The guidance row's own accepted contract is that its three **required** parts
are said whole, with no ellipsis — that is what `R6` exists to assert, and the
production comment beside `guidanceParts` states the same rule. At 120x30 those
parts are:

```text
Ready for Entry 3 · Enter activates · Tab to draft      50 columns
measured room                                           45 columns
```

The product already chooses the shorter of its two vocabularies by measured room
rather than by terminal size, and it is already choosing the compact one here.
There is no third, so `fitted()` cuts the row and emits the ellipsis `R6`
forbids:

```text
"Ready for Entry 3 · Enter activates · Tab to…"
```

Five more rows fail for the same reason — Transcript text that no longer fits:

| Row | What is no longer said whole |
| --- | --- |
| `R6: what the row must say fits the room it was measured for, whole` | the required parts, ellipsised at 120x30 |
| `UI1: the guidance teaches the ring that is mounted, at both sizes` | `Tab/Shift+Tab move` |
| `UI2: a normal-sized refusal is left by its own visible control` | the refusal's own sentence |
| `UI2: Enter on the refusal's control leaves it too` | the same |
| `J1: Control-C leaves a refusal, and it is still a refusal` | `cannot read` |
| `J1: a corrupt history refuses atomically, with no append and no session` | `cannot read` |

Also `UI8: the whole first-use path, using only what the screen says`, which
reads the guidance row to find its way.

## It is the width rule, not the composer

Isolated rather than inferred. With the composer work fully in place and
`inspectionWidth` alone reverted to the former fixed 36/28, the only failure is
`PW1` — the row that asserts the new shares:

```text
packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-journey.test.ts
  with the accepted shares:  R6, J1, J1, UI1, UI2, UI2, UI8 fail
  with the former widths:    only PW1 fails (55 passed)
```

`R6`, `UI1`, `UI2`, `J1` and `UI8` all pass at `25227d38` and all pass with the
composer work alone.

## Why I am not choosing the repair

Every available repair is a product decision:

1. **A third, shorter vocabulary** for the state phrase and the way back — new
   wording somebody has to approve, and `statePhrase` has no shorter form for
   the ready states at all (`Ready for Entry 1` is fixed for both vocabularies).
2. **Make a required part optional** — the way back to the draft is required on
   purpose; dropping it is the thing `R6` was written to prevent.
3. **A different share at medium**, or a floor on the Transcript — an amendment
   to the width table that was just accepted.
4. Weakening the six rows — which the amendment explicitly forbids: "Preserve
   every existing test's claim."

I have not guessed at any of them, and I have not touched those rows.

## What is done, and verified

Everything except the six rows above.

**Composer (MC5–MC7), all green.** Message Sidekick is one field block: its name
and focus marker on their own row, its value fitted into rows beneath them, at
most six of them, then showing the newest. `components/rows.ts` renders a block
field's label only; `application.ts` describes the value rows under the same
field node, so there is one focus owner, one editing value and no extra Tab
stop. The height is chosen from a measurement, not assumed: the frame is
measured carrying the label and one value row, that frame's chat capacity is
what growing may spend, and the value takes the smaller of its fitted rows and
`min(6, C)`. A taller composer is measured once more so the capacity the chat is
admitted against belongs to the frame that is drawn — one extra pass, no loop.
Composer cuts are retained in storage of the command's own, separate from the
chat's, so a keystroke evicts no chat line.

- `MC5: the value wraps into rows of its own, and the chat gives them room`
- `MC6: six rows at most, and Send carries the original text once`
- `MC6: control — an acknowledged Send leaves one blank value row`
- `MC7: the value, its focus and its height survive every size and a held turn`

**Width rule, implemented and proved.** `inspectionWidth` derives
`floor((columns - sidebar) / 2)`; the Transcript takes the remainder, so the odd
cell is its. Measured against the accepted table, not against the helper:

| Frame | Sidebar | Transcript | Right | Right starts at |
| --- | ---: | ---: | ---: | ---: |
| 160x36 | 32 | 64 | 64 | 96 |
| 120x30 | 28 | 46 | 46 | 74 |
| 161x36 | 32 | 65 | 64 | 97 |

`PW1: each column is the accepted share, and the three of them are disjoint`
reads the committed bounds at all three frames under both tabs, with both header
edges and the seven-row footer, and checks the three columns are integral,
adjacent and exactly the terminal.

**PW2's adaptations, done.** `paneEnvelope` in both test files and
`INSPECTION_FROM` now state 96/74 from the table; 29 pane-scoped click searches
moved from column 124 to 96. The pane-local question and Configure drawers
follow `sidekickDrawerRect`, which derives from `inspectionWidth`, so they
occupy the wider pane with no production change — `MQ4`, `CFG6`, `Q-P2` and
`SS4` all pass there.

**Command 2 is green:** `24 passed (132 steps), 0 failed` — acknowledgement and
the other FIELD consumers, which keep their one-row path.

**Field readers adapted, claims preserved.** `messageText` and the new
`messageRows`/`messageTextIn` read the composer's own value rows beneath its
name; 22 assertions that expected label and value on one row now read the value
block. `sendMessage`'s own barrier reads it too. A helper reads **visible** rows
only, so rows asserting a whole sent message read the retained text instead.

**Two existing rows re-anchored, both keeping their claim.** `historyOver`'s
drawer discriminator and `SS6`'s rejoined status (the wider pane fits that
sentence in fewer rows, so the rejoin is trimmed).

**Prose:** `specs/repl-spec.md` and `architecture.md` describe the composer
block, the six-row cap, the measured reduction and display-only wrapping. The
width prose is **not** written yet, because what the Transcript can say at these
widths is the open question.

## What I need

A decision on one of the four options above. If the answer is a Transcript floor
or a different medium share, the width rule is one line and `PW1`'s table is the
only expectation to restate. If it is new wording, it is a product string and
`R6`/`UI1`/`UI2`/`J1`/`UI8` keep their claims against it.

I will commit the combined slice as soon as that is settled. Nothing is pushed,
no GitHub write, no CI, no capture.
