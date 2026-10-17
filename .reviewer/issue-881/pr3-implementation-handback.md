# PR 3 implementation handback: navigate the recorded History rail

Base: accepted PR 2 `acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e`.
Branch: `agent/issue-881-pr3`, worktree `.claude/worktrees/issue-881-pr3`.
Head at the time of writing: `f509197bd1998b376b09986b79fce2740568e76f`.
Nothing is pushed and no PR is open.

## What is there

| Commit | |
| --- | --- |
| `ca246a97` | Layers 1 and 3a: `navigation.ts` (the thin immutable summary and the head's precedence) and `history-rail.ts` (the measured five-row rail). |
| `2b148f07` | The band drawn as that rail, and the drawer given the whole recorded order. |
| `05bc510b` | Layer 2's evidence: the head against a real session. |
| `ac802025` | `specs/repl-spec.md` and `architecture.md`. |
| `d1e04771` | H1/H2. |
| `f509197b` | H5/H6. |

Seventeen files, +2194 / −193. `historyBand`, `groupedMarkers`, `bandRows`,
`ReplSurfaceMarker`, `ReplPlacedMarker` and `HISTORY_LABEL` are gone from
`layout.ts`; the band is `ReplPreparedRail` now.

## Frozen focused evidence

Both commands, run on this head:

```
deno task test packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-model.test.ts \
  packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-composition.test.ts \
  packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-journey.test.ts
→ ok | 97 passed (308 steps) | 0 failed

deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-forms.test.ts \
  packages/cli/tests/repl-agent-journey.test.ts
→ ok | 19 passed (111 steps) | 0 failed

git diff --check  → exit 0
```

Those are the actual counts, not a required number.

| Row | Where | What it holds |
| --- | --- | --- |
| H1/H2 | `repl-history.test.ts` | A prefix's content beside the whole file's navigation, with neither channel carrying the other's payload; and a malformed later segment refusing the whole reading rather than leaving stale navigation. Both have in-place controls: the content channel is shown to carry the prefix's own payload, so "navigation carries none" is not a claim about an empty string; and the same stream rebuilt *without* the bad record is shown to open at the same marker, so the refusal is the record's. |
| H3 | `repl-history.test.ts` | The seven-state precedence over `headOf`, and the head a real session publishes: empty, live, SETTLING read from inside the installation's own `ensure`, settled, and no payload in the summary. |
| H4 | `repl-history.test.ts` | The five rows allocated by one real layout engine at three measured widths: first and last positions, deterministic collisions, the entry/minor hierarchy, caption-range merging, the longest head's reservation, the shared ◆/▼ column, the empty band, and the refusal where the title will not fit. |
| H5 | `repl-journey.test.ts` | Every recorded position reached in the drawer with its own `[↓ later]`, visible/focus/pointer agreement row by row inside the drawer's rectangle, and 160×36 → 120×30 → 72×20 → 60×15 → 160×36 keeping marker, route, draft and focus. The scrolling claim is made at the narrow size, where one window really does hold less than the whole set. |
| H6 | `repl-journey.test.ts` | A cold process at an early prefix: settled head, the prefix's catalog, the retained draft, the same rail mark-for-mark at the same three sizes, category-only drawer rows, no live badges, byte-identical journal, no compile, no `.md` read, nobody asked, and a drawer window that opens at its first row although the process that recorded it left its own at the end. |

Changed premises in existing suites, itemized: `repl-journey.test.ts` UI1/UI5
asserted the band's *labels* and now asserts the band's title and rule, because
the band draws a measured rail rather than a list — the case is about the
footer's order and that is unchanged; `repl-presentation-style.ts` and
`repl-forms.ts` reading helpers now pass a navigation, because the drawer lists
nothing without one; `surface.ts` and `presentation.ts` fixtures gained
`rail: undefined` / `EMPTY_BAND`. Exact action, prefix, focus and teardown
behaviour are unchanged.

## The five controls

`pr3-evidence/.controls.py`, run one at a time on `f509197b`, each restored
from the bytes read before the mutation and verified by SHA-256.
Full records in `pr3-evidence/.controls.json`.

| Control | Outcome | First failing step |
| --- | --- | --- |
| `KC1-token-drift` — one palette role moved by one bit | BROKEN | `P1-T1: a source row's delimiters, names, values and references are each their own`, and `P1-T1: a binding's JSON is read as JSON` — named XMD and JSON cells, against the independently sampled archive literal, not fixture equality |
| `KC2-no-rails` — the nesting rail removed from every row | BROKEN | `draws a rail on every row, in the colour of the region it is in` |
| `KC3-no-lifecycle` — the lifecycle words and glyphs removed | BROKEN | `says WAITING on the element that is waiting, with the waiting rail`, and `keeps EXIT's rail during a cleanup wait` — real held-call frames |
| `KC4-label-list` — every mark placed at its own index | BROKEN | `puts the first position at the start and the last at the end`, `groups collisions deterministically`, `keeps the entry's tall mark and the minor's stem when they share a column` |
| `KC5-unowned-head` — the head's owned-work fact cleared | BROKEN | `is SETTLING while the outcome is retained and the entry is still coming down` |

All five restored; the runner exits non-zero if any control passes or any file
comes back different.

## The gallery

`pr3-evidence/` — seventy-seven pairs, twenty-five states at 160×36, 120×30 and
72×20 plus the two History resize endpoints, matching
`final-gallery-plan.json` exactly: nothing missing, nothing extra. Captured
from the real command in a private tmux PTY against this head, with its own
`$HOME`. `comparison.html` is the gallery, `sheets/` the per-state contact
sheets, `capture-runbook.md` how each was produced, `gallery-manifest.json`
the machine-readable list, `actions.jsonl` every keystroke, pointer press,
paste, resize and gate with its timestamp, `sha256sums.txt` all 545 files.

`image-review-log.md` holds both readings: `audit.py` checking all seventy-seven
captures against their own rows of the frozen matrix —

```
77 captures checked, 0 failed; 76 draw the band, 70 draw a mark on its rail
```

— with a break-it control showing it fails when one capture's head word is
changed, and my own review by eye of five named pairs across all three
profiles.

Cold hashes: `cold-before.json`, `cold-after.json` and
`cold-after-historical.json` are identical in journal bytes, journal lines,
journal SHA-256 and provider-log SHA-256.

## Four things the Planner should know

**The crowd fixture does not use `Json`, and the plan's premise for it is
wrong.** `stack-and-evidence.md` asks for two hundred `<Json>` invocations to
produce enough checkpoints to collide. Measured against the real projector that
is *one* position: a publication record carries every binding it publishes and
the projector records one `binding` checkpoint per record, so thirteen `<Json>`
elements in one entry drew one mark. A component scope is what is one position
each. `history-crowd.md` therefore invokes a Markdown component two hundred
times, each carrying a `secret` of its own so a frozen earlier reading can
still be checked for a later payload. The result is the crowding the criterion
wants: 218 positions over a 134-cell rail at 160 columns, so marks share columns
at every measured width.

**The controlled host is needed for one state, not three.** The matrix sends
"pause/cleanup scenes" to it. Both paused states turned out to be reachable
through `xmd repl` itself — its own `[pause]`, against a provider holding at
the fixture's gate, gives `PAUSING EXPANSION` and then `EXPANSION PAUSED` — so
they were captured with the ordinary command and the controlled host is used
only by `settling-head`, where no public grammar holds the window open. That
host adds exactly one installation to the production assembly and assembles no
Agent stack, because the entry it holds is a `<Json>` publication.

**One observation I am not claiming as a defect.** In one run, Escape left a
History drawer scrolled to the end of 218 positions still standing. Two
targeted reproductions — scrolled to the end with no selection, and scrolled to
the end with the last position selected — both closed on Escape, as did the
unscrolled and three-row-scrolled cases. So it did not reproduce and I am not
reporting it as a finding. The journey now presses Escape, falls back to the
drawer's own `[close]`, and records in `actions.jsonl` which one dismissed it.

**`historical-before-admission` is PR 2's row, not PR 3's.** It is the one
state in the matrix with `yes` under PR 2 and `—` under PR 3, so it is not
among the twenty-five and is not captured here.

## What is not done

The three capture fixtures —
`packages/cli/tests/fixtures/repl/issue-881/{HistoryRecord.md,history-crowd.md,controlled-host.ts}`
— are **staged but uncommitted**: every signing attempt fails with
`fatal: failed to write commit object`, which is 1Password's SSH agent rather
than git. They are formatted, lint-clean and typecheck, and the product source
at `f509197b` is what every capture and every control ran against, so no
evidence depends on them landing. They need one `git commit` once the agent is
unlocked.

Nothing is pushed. No PR is open. No public artifact links are claimed.
