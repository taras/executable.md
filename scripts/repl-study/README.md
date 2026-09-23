# REPL interaction study, in a real terminal

A bounded experiment for [#838](https://github.com/taras/executable.md/issues/838)
and [#839](https://github.com/taras/executable.md/issues/839), under the REPL
quest [#827](https://github.com/taras/executable.md/issues/827).
It renders the Product Owner's approved `XMD REPL Terminal Interface` study from
fixture data through `@bomb.sh/tty` 0.9.0, to answer whether that renderer can
carry the design in terminal cells.

#839 added the half #838 did not answer: one location said as a URL, and a focus
model derived from it. `RESULT-focus.md` records what that found.

It executes no XMD, opens no Agent session, reads no real journal and writes
nothing but its captures. The implementation may be discarded; `RESULT.md` and
`RESULT-focus.md` record what it found.

## Run it

```bash
deno task repl:study --play                     # the whole story, start to finish
deno task repl:study                            # sitting on one moment, keys below
deno task repl:study --fixture drawer           # opening on a different one
deno task repl:study --play generated drawer    # one transition, as a diagnostic
deno task repl:study --capture captures/        # every fixture at every profile
deno task repl:study --print nested wide        # one frame, as text

deno task repl:study --frame 07                 # one frame of the focus study
deno task repl:study --route 'xmd://repl/e1/transcript/entry-1/plan/+project'
deno task repl:study --frame 12 --focus-map     # with the numbered overlay on
deno task repl:study --capture-focus captures/  # the focus study's frames, as text
```

**`--frame` and `--route` are the same door.** A frame is a location the
Product Owner's focus study names, and `--frame 07` is shorthand for its URL
plus how far the execution had recorded when it was taken. `--route` takes any
location at all:

```text
xmd://repl/<execution>/<surface>[/<scope>]*[/+<drawer>]*[?at=<marker>][&inspect][&draft=<text>]
```

The surface is one of `sessions`, `transcript`, `bindings`, `input`, `history`,
and it says which region owns focus — so moving focus across a region boundary
moves the URL with it. A `+` marks a drawer, so a drawer is never mistaken for a
scope of the same name, and the last drawer in the path is the top, the only one
that is visible and interactive. `at` names the recorded marker the scrubber has
selected; `inspect` says the reconstruction at it is open, takes no value, and
is refused without a marker. Everything else — where the transcript is scrolled
to, whether the overlay is drawn, which target inside a region is focused right
now — is disposable and deliberately not in the URL.

**`--play` is the demonstration.** It begins at the empty REPL and goes all the
way to the settled entry — empty → nested → generated → drawer → paused →
settled — holding each moment long enough to read and animating every transition
between them. Nothing needs pressing. When it reaches the settled entry it stays
there until you leave with `q`. Sixteen seconds, wide terminal, no keyboard.

Keys, while it is running:

| Key | What it does |
| --- | --- |
| `Tab` / `Shift+Tab` | move focus around the ring, forward and in reverse |
| `1`–`5` | jump straight to a region |
| `F1` | show or hide the numbered focus map |
| `Enter` | activate the focused target |
| `Esc` | Back, and never destructive — see below |
| `↑` `↓` `PgUp` `PgDn` | move the transcript window |
| `←` `→` | move the selected marker, one at a time |
| `Ctrl+↑` / `Ctrl+↓` | move the locus out to the parent scope, or in to the first child |
| `Ctrl+←` / `Ctrl+→` | move to the previous or next sibling scope, wrapping |
| `d` | open or close the suspension that is waiting |
| `p` | play the transition out of this moment into the next |
| `q` | leave, restoring the terminal |
| `Ctrl+C` | interrupt the entry if one is running, paused or reconstructed; else clear the draft; else leave |

**The ring is five regions with each region's own controls inlined after it** —
Sessions, Transcript, Bindings, REPL input, Execution History — and it wraps.
The numbers the overlay draws are assigned separately: regions take 1–5 and
controls take 6 upward, which is why `Run` is numbered after the footer and
traversed before it. While a drawer is open the ring is the drawer's own
controls and the Execution History region, and nothing else: the footer is
inside the trap deliberately, because it is the one way out of it.

**`Esc` is Back.** It closes the top drawer, restoring whatever opened it; then
leaves a reconstruction for the paused head; then returns from a control to the
region that owns it; then pops one navigation entry. It never discards the draft
and never answers a suspension — which is one deliberate divergence from the
study, recorded in `RESULT-focus.md`.

## Moving between moments

The six fixtures are stable states — reconstructable, capturable, and what a
journal would restore. A journey is the sequence through all of them: holds on
each moment, transitions between. Both exist only while they run — segment,
phase and elapsed time live in the frame loop, never in a fixture — so what a
journal restores is a moment, never a point halfway through a transition.

A hold is not dead time. The study's screens are dense, and a demonstration that
cut between them as fast as it could render would show everything and let a
person read nothing. Holds run from 1.2 to 2.6 seconds, in proportion to how
much there is to take in.

Two kinds of motion run during a transition:

- **the renderer's own.** The contextual band declares a transition, so when a
  suspension opens the drawer `@bomb.sh/tty` interpolates its height and top edge
  and reports `animating` until it arrives. The harness supplies the time and
  nothing else — in seconds, which is the unit the renderer measures transitions
  in, converted once at that boundary from the milliseconds everything else here
  counts in.
- **the application's own.** The recorded head travels along the track and the
  target's transcript arrives a few rows at a time, both interpolated here from
  elapsed milliseconds.

A frame clock — `sleep(16)` in a child of the terminal session — is spawned only
while one of those two is still moving, and halted the moment both have settled,
so an idle REPL schedules nothing. Cancelling the session halts the clock with
it, which is why an interruption cannot leave a frame being drawn into a terminal
that has already been restored.

Three flags exist for running a journey or a playback without a person watching:
`--frames <n>` leaves once the playback settles or that many frames have been
drawn, `--interrupt-after-frames <n>` raises a real `SIGINT` at the harness mid
transition, and `--trace <file>` records what every frame did — elapsed
milliseconds, the seconds it advanced the renderer by, whether the renderer was
animating, and how many bytes it emitted.

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

`--capture-focus <dir>` does the same for the focus study's frames, with the
numbered overlay on, under `scripts/tests/fixtures/repl-focus/`. The study
states its frames as numbered target lists, so numbering them on screen is what
makes a capture legible as evidence against the frame it reproduces.

## How it is put together

| File | What it owns |
| --- | --- |
| `model.ts` | the semantic vocabulary — scopes, phases, sections, sessions, bindings, checkpoints, drawers. No cells. |
| `playback.ts` | the journey, the path between two fixtures, and the motion at one instant of it |
| `fixtures.ts` | the six moments and the three drawers, from the study's own content |
| `route.ts` | the URL schema, parsing, formatting, and push versus replace |
| `focus.ts` | targets, the map, the registry, traversal, resolution and counterparts |
| `journal.ts` | the hand-authored journal fixture, and the fold that reconstructs a moment from it |
| `store.ts` | `ReplState`, its reducer, `hydrate()` and `projection()` |
| `frames.ts` | the focus study's fourteen frames, as addressable states |
| `layout.ts` | the profile, and every region's rectangle in cells |
| `render.ts` | those rectangles and that fixture, as `@bomb.sh/tty` operations |
| `screen.ts` | a terminal's cells, reconstructed from the bytes, so a frame can be read back |
| `host.ts` | the only module that touches the terminal: modes, raw input, signals, restoration |
| `capture.ts` | one frame, away from a terminal, in bytes and in cells |
| `mutations.ts` | the twenty-three ways the evidence breaks this on purpose |
| `main.ts` | the documented command |

`--replay` runs the same lifecycle with no terminal attached, writing its byte
stream to an ordinary pipe. That is how the evidence checks that the modes the
harness turned on are turned back off — on an ordinary exit, on a signal, and
when a frame throws.
