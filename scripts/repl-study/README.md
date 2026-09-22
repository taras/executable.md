# REPL interaction study, in a real terminal

A bounded experiment for [#838](https://github.com/taras/executable.md/issues/838),
under the REPL quest [#827](https://github.com/taras/executable.md/issues/827).
It renders the Product Owner's approved `XMD REPL Terminal Interface` study from
fixture data through `@bomb.sh/tty` 0.9.0, to answer whether that renderer can
carry the design in terminal cells.

It executes no XMD, opens no Agent session, reads no journal and writes nothing
but its captures. The implementation may be discarded; `RESULT.md` records what
it found.

## Run it

```bash
deno task repl:study                      # in this terminal
deno task repl:study --fixture drawer     # opening on one moment
deno task repl:study --capture captures/  # every fixture at every profile
deno task repl:study --print nested wide  # one frame, as text
```

Keys, while it is running:

| Key | What it does |
| --- | --- |
| `1`–`6` | show a fixture: empty, nested, generated, drawer, paused, settled |
| `↑` `↓` `PgUp` `PgDn` | move the transcript window |
| `←` `→` | move the selected checkpoint, one at a time |
| `Esc` | return to the head |
| `Tab` / `Shift+Tab` | move between surfaces, which matters in the narrow profile |
| `d` | open or close the drawer |
| `q` or `Ctrl+C` | leave, restoring the terminal |

These are the harness's own controls. The accepted focus model — the five-region
ring, the drawer's focus trap, and where focus returns after a suspension — is
[#839](https://github.com/taras/executable.md/issues/839), not this experiment.

## What it shows

Six fixtures, each a moment from the study: an empty REPL; a `Plan` running
inside the document scope with three sections settled; the Plan's returned
program replacing the expression that produced it; a project `Elicit` drawer
with three Agent sessions in flight; a paused head with an earlier checkpoint
under inspection; and a settled Entry 1.

Four layout profiles, chosen from the measured terminal size alone:

| Profile | From | Composition |
| --- | --- | --- |
| `wide` | 160 × 36 | Sessions, transcript and bindings side by side, above one full-width Execution History footer |
| `medium` | 120 × 30 | the same composition at its floor, with secondary detail dropped |
| `narrow` | 72 × 20 | one surface at a time, full screen, under a bar naming it |
| `too-small` | below 72 × 20 | an explicit refusal that recovers on the next resize |

## The captures

`--capture <dir>` writes every fixture at every profile as two files: a `.txt`
frame, which is the interface as a person reads it, and a `.ansi` file, which is
the exact byte stream. The `.txt` frames under
`scripts/tests/fixtures/repl-study/` are committed and are also the goldens
`scripts/tests/repl-study.test.ts` checks, so a rendering change shows up in a
diff as the picture it changed. The `.ansi` files are not committed.

## How it is put together

| File | What it owns |
| --- | --- |
| `model.ts` | the semantic vocabulary — scopes, phases, sections, sessions, bindings, checkpoints, drawers. No cells. |
| `fixtures.ts` | the six moments, from the study's own content |
| `view.ts` | what the person chose: the transcript window, the selected checkpoint, the current surface |
| `layout.ts` | the profile, and every region's rectangle in cells |
| `render.ts` | those rectangles and that fixture, as `@bomb.sh/tty` operations |
| `screen.ts` | a terminal's cells, reconstructed from the bytes, so a frame can be read back |
| `host.ts` | the only module that touches the terminal: modes, raw input, signals, restoration |
| `capture.ts` | one frame, away from a terminal, in bytes and in cells |
| `mutations.ts` | the eight ways the evidence breaks this on purpose |
| `main.ts` | the documented command |

`--replay` runs the same lifecycle with no terminal attached, writing its byte
stream to an ordinary pipe. That is how the evidence checks that the modes the
harness turned on are turned back off — on an ordinary exit, on a signal, and
when a frame throws.
