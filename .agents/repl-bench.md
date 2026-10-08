# The REPL bench

A bench exercise runs `xmd repl` in a real terminal and reads back what it drew.
It is how product verification for this command is actually shown: the suites
prove regressions, and the bench answers "does a person see this work".

This document exists so a role designing an exercise knows what the instrument
can and cannot witness, and therefore what an exercise has to specify to be
executable. An exercise that asks for evidence the bench cannot produce is not a
hard exercise; it is an unrunnable one.

## Why a terminal at all

The REPL's own record cannot answer a question about its interface. A journal
holds ordinary `DurableEvent`s — what a document imported, evaluated, asked and
answered — and `specs/repl-spec.md` makes it a rule that no keystroke, focus
move, drawer, resize or rendered cell ever reaches it. Measured across every
journal on this machine, the only `description.type` values are
`import_component`, `eval`, `elicit`, `agent_prompt`, `exec`, `syntax_symbols`,
`call`, `loop` and `loop_iteration`.

The screen is also about colour. Every row carries a role, a 24-bit foreground, a
weight and a background surface (`presentation-style.ts`, `REPL_PALETTE`), so a
plain-text reading discards what a question about emphasis is about.

## Where it is, and how a run starts

The harness is `scripts/repl-bench.sh` on `agent/repl-workbench`, in a worktree
outside the checkout at `~/Repositories/taras/xmd-worktrees/repl-workbench`
(already prepared; do not re-run `deno task setup`).

```bash
scripts/repl-bench.sh start [--size WxH] [--real-home] [-- <repl args>]
scripts/repl-bench.sh attach      # execs tmux; the person drives from here
scripts/repl-bench.sh look [label] # one frame, with colour, into the tape
scripts/repl-bench.sh journal      # this run's journal, beside the frames
scripts/repl-bench.sh send <key>…  # Tab BTab Enter Escape Backspace C-c
scripts/repl-bench.sh type <text>  # literal text, through the paste path
scripts/repl-bench.sh resize <WxH> # a real SIGWINCH
scripts/repl-bench.sh tape | status | stop
```

Artifacts land in `.bench/<run>/` (gitignored): numbered frames, `latest.ansi`,
`tape.ansi`, `journal.jsonl`, `meta.env`. Default size is `160x36`, default repl
args are `--deny-all`.

Two pieces, split on purpose: the harness has no XMD in it, and
`scripts/repl-workbench.md` is the XMD program that reads the files it wrote and
renders a report. Captures travel as **files**, never as command output, because
`Process.join()` may settle before the stdout pumps do (effectionx #244) and a
frame lost that way would read as a REPL defect.

## What it can witness

- **The frame as rendered**, via `capture-pane -p -e -N`: `-e` keeps the SGR
  sequences, `-N` keeps trailing spaces so a blank footer reads as blank rather
  than as a short capture. Verified byte-identical to a direct capture.
- **Colour and weight**, read back as `REPL_PALETTE` triples — a report naming no
  palette role means the capture lost the escapes, not that the screen was grey.
- **Row position.** `capture-pane` trims trailing blank *lines*, so count from the
  top. A claim about the footer or the History band is a claim about a row index.
- **The journal for that run**, correlated by construction: an isolated per-run
  `HOME` leaves exactly one file. On darwin the data root is a fixed
  `~/Library/Application Support` and ignores `XDG_DATA_HOME`, so `HOME` is the
  only lever. `--real-home` keeps the real one for exercises that need actual
  agent configuration, and correlates by diffing the directory across launch.
- **Exit status and printed output**, through a sentinel the launcher prints.

## What it cannot witness

State these as out of scope, or the exercise cannot be run.

- **Keystrokes.** tmux records output, not input. A dropped key produces no
  redraw, so "nothing happened" and "the key never arrived" are the same
  observation. An exercise that turns on which chord was pressed needs a
  dev-only trace of decoded input events inside the product — a change that is
  escalated, not built.
- **Frames between captures.** `look` samples on demand. A refusal that clears, a
  frame mid-resize and anything time-based are gone unless they are still on
  screen when the capture runs.
- **Which of two refusals.** There are two, in two loops, and an exercise must
  name one. Below `72x20` the main loop draws the too-small refusal, which places
  no control and ends 0 with a reopen command. `refuse()` is a different screen,
  reached only by a location this command cannot show; it does place a control and
  ends **1** with the reason and no reopen command. A measurement at `60x18`
  exercises the main loop only — that is how an untested `refuse()` branch once
  shipped while a 60x18 run appeared to confirm it. To reach `refuse()`:
  `start --size 160x36 -- 'xmd://repl/0123456789abcdef/entries'`.
- **Pointer activation**, as a subcommand. It is possible as a raw SGR sequence
  through the paste buffer; ask for it and it gets added rather than improvised.

## Facts that change how an exercise is written

- **Sizes are a product dimension.** `specs/repl-spec.md` gives distinct screens
  at `160x36`, `120x30` and `72x20`, and a refusal below. Name the size; "it
  works" is not a size.
- **Input arrives in batches.** One write is one scan is one batch, and the
  program decides leaving once per batch. An exercise about queued input must say
  whether bytes arrive in **one** write — `printf '\003\r' | tmux load-buffer -`
  then `paste-buffer -r` — or as separate sends, because the two test different
  things.
- **`type` goes through the paste buffer**, not `send-keys`, because tmux's parser
  eats a trailing `;` even from a literal argument, which silently truncates a
  typed `js eval` block and then fails as a syntax error that looks like a product
  bug.
- **`xmd repl` takes one optional location and five agent options and refuses
  anything else option-shaped.** There is no bench flag to add to the product.
- **Leaving.** Control-C ends the command from any screen; every other Control or
  Alt chord is dropped whole except Control-J, the newline inside a paste.
  `[exit]` is still the visible control, and closing prints `Reopen this view
  with:` above an indented `xmd repl '<location>'`.
- **Surfaces are `entries` and `sessions`**, matching the headings drawn on screen.

## What an exercise must specify

Give these, and it can be executed and its result trusted:

1. **The claim**, in one falsifiable sentence about what a person sees.
2. **The size**, and why that size rather than another.
3. **The starting state**: the repl arguments, whether a location is passed, and
   whether an entry must be submitted first to make the claim reachable.
4. **The input, in order**, as keys and text — and whether anything must arrive
   in one write.
5. **What to read off the frame**: which row, which text, and which palette role
   or colour when the claim is about emphasis.
6. **What to read off the journal**: which record types, and how many. "Nothing
   was appended" is a record count of zero, which the bench can state exactly.
7. **The expected exit status and printed output.**
8. **The discriminating control**: what would make this pass for the wrong
   reason, and the second run that rules it out. A claim that cannot fail has not
   been verified. Prefer a control that is a real alternative — a neighbouring
   key that must *not* act, a size at which the row must *not* appear.

## What comes back

The exact commands run, the frame rows that carried the claim, the journal
records by type and count, the exit status, and the control's result. Where the
bench could not witness something the exercise asked for, that is returned as
evidence rather than worked around.
