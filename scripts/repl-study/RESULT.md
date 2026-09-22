# What this experiment found

Issue [#838](https://github.com/taras/executable.md/issues/838) asked whether
`@bomb.sh/tty` can render the approved `XMD REPL Terminal Interface` study in a
real terminal, and what the design owes a terminal that is not 2560 × 1440.

**Decision: retain the harness, and revise three design states.** The renderer
carried every fixture at every profile without a single renderer error, the
terminal survived exit, interruption and failure, and the seam between semantic
fixtures, layout, rendering and the terminal host held. Three states needed an
adaptation the study does not describe, each named below, and those belong to
whoever takes the design further.

## Dimensions tested

| Where | Size | Profile |
| --- | --- | --- |
| rendered and captured | 200 × 50 | wide |
| rendered and captured | 140 × 38 | medium |
| rendered and captured | 90 × 28 | narrow |
| rendered and captured | 64 × 18 | too-small |
| a real pseudo-terminal, interactively, macOS `script` | 80 × 24 | narrow |

The interactive run opened, showed the `nested` fixture, accepted `4`, `Tab` and
`q` as keystrokes, and left the terminal in the modes it found. Every other
dimension was exercised through the captures and the suite.

## What the renderer gave us

- **Layout arrives back in cells.** `render().info.get(id).bounds` reports
  `{x, y, width, height}` in terminal cells, so "the Execution History footer is
  never covered" is a question that can be asked of the renderer directly
  instead of inferred from bytes. This is the single most useful thing the
  library does for evidence.
- **The byte vocabulary is tiny.** Frames are made of `ESC[0m`,
  `ESC[48;2;r;g;bm`, `ESC[row;colH` and text. Sixty lines reconstruct a terminal
  from them, which is how the stale-cell check is possible at all.
- **Diffs really are minimal.** One changed character emits `ESC[0m ESC[1;23H2`.
- **Clay's layout is enough.** Floating regions at exact cell rectangles, fitted
  and grown axes, padding, clipping and borders composed the whole study —
  three panes, a bottom-anchored contextual band, a full-width footer, and a
  drawer above it — with no arithmetic beyond `layout.ts`.
- **Glyphs render.** `▶ ● ◆ ✓ ◀ × ≈ · ↳ ▸ │ ├ ╭ ─` all appear, so the study's
  "glyph + word, never colour alone" rule survives into the terminal.

## Limitations, as observed

1. **The renderer clips; it does not scroll.** `clip` truncates a region's
   overflow and there is no scroll offset, so a window over a long transcript is
   the application's to own. That is not a defect — it is a boundary, and it
   means every consumer of this renderer will write the same windowing code.
2. **Resize is not in the input stream.** `Input.scan()` decodes keys and mouse
   reports; feeding it `ESC[8;24;80t` produced nine ordinary keydowns. Size
   changes must come from `SIGWINCH` plus `Deno.consoleSize()` and be handed to
   `term.update()`. A renderer never told is not merely stale: it goes on
   addressing cells the terminal no longer has.
3. **A pseudo-terminal may report `0 × 0`.** macOS `script` does, and a renderer
   handed those dimensions draws nothing at all — which looks exactly like a
   crash. The harness now assumes 80 × 24 when the terminal will not say.
4. **Ambiguous-width glyphs are assumed to be one cell.** `●` and `◆` are East
   Asian Ambiguous; a terminal configured to render them double-width would
   misalign every rail and notch that uses them. Nothing here detects that, and
   no such terminal was tested.
5. **The output view expires.** `render().output` must be copied immediately —
   `Uint8Array.from(...)` — or the next frame invalidates it.

## The three design states that required adaptation

1. **Nesting depth has no height left to use.** The band is four rows, and the
   study's four extents already spend them: a minor checkpoint takes the track
   row, an entry boundary rises one row above it, the head takes three rows and
   carries its label, and a historical selection takes the whole band. Depth is
   therefore a glyph tier — `●` for the entry's own scope, `◇` one level in, `·`
   deeper — and past three tiers the band stops distinguishing. The scope path
   is exact in the journal list beside it, so nothing is lost, but the band
   alone cannot answer "how deep is this".
2. **A narrow track is mostly transport.** The study's rule that the track
   yields room to the visible controls is faithful and expensive: at 90 columns
   while inspecting history, `INSPECTING  [ Continue ] [ Return ] [ Fork ]`
   leaves the track about nine columns for fourteen checkpoints. Markers that
   would collide are gathered into one notch carrying their count, `←`/`→` still
   steps through every checkpoint behind it, and the full-screen history surface
   lists them all. A design that wants the track legible at narrow widths has to
   decide what the transport gives up first.
3. **The band's own labels do not fit narrow.** `EXECUTION HISTORY` and
   `recorded · 00:53` cost eighteen columns that the track needs more, so the
   narrow band says `HISTORY` and `00:53` and lets the surface bar above it
   carry the name. The same pressure drops the transcript's eight-column phase
   word below 56 columns, and drops session notes, binding notes and the
   drawer's schema column at medium.

## What was not answered

- Focus, the ring, the drawer's trap and where focus returns after a suspension
  are #839's, and nothing here establishes them.
- No reusable component boundary is proposed; #840 owns that, and the region
  functions in `render.ts` are deliberately private.
- Restoration is proved at the byte boundary and by construction — cleanup
  registered before the modes are applied — rather than by inspecting a
  pseudo-terminal's mode flags. Allocating a PTY and emulating a child terminal
  is the territory #801 withdrew.
- Nothing here executes XMD, journals anything, or opens an Agent session, so
  every fixture is a statement about rendering and none is a statement about
  execution.
