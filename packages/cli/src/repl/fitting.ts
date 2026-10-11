/**
 * How wide text actually is, asked of the engine that will draw it.
 *
 * The installed engine answers natural width through a fit-sized element: give
 * it the same text operations a row will be drawn with, read the bounds it
 * reports, and that is the number of cells those operations occupy. There is no
 * public line-break API and no renderer change, so wrapping is built on top of
 * that one question asked repeatedly.
 *
 * ## Why not `text.length`
 *
 * A UTF-16 code unit is not a cell. `界` is one unit and two cells; a combining
 * accent is one unit and no cells at all; an emoji is a surrogate pair and two
 * cells. Every width decision here is therefore an engine answer, and every cut
 * is at a grapheme boundary — because a cut between a base character and its
 * combining mark produces two rows neither of which is a character.
 *
 * UTF-16 offsets index source. They never stand in for terminal width.
 *
 * ## Why batched
 *
 * Each measurement is a render, and the engine's reported geometry is only
 * valid until the next one — so every answer is copied out before another
 * measurement is asked for. Candidates are therefore grouped: one measurement
 * answers for every row still looking for its cut, and the search narrows all
 * of them together rather than one row at a time.
 *
 * ## Why it refuses rather than clips
 *
 * A region with no room for even one grapheme cannot hold the reading, and
 * shortening somebody's source to fit would be this screen editing the content
 * it exists to show. So an unfittable row is a frame refusal, which already
 * recovers on resize.
 */

import { close, fit, open, text } from "@bomb.sh/tty";
import type { Op } from "@bomb.sh/tty";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { ReplRenderer } from "./renderer.ts";
import type { ReplTerminalSize } from "./terminal.ts";
import type { ReplReadingLine } from "./source-reading.ts";
import { READING_STATUSES } from "./source-reading.ts";
import { runText, tokenRuns } from "./description.ts";
import type { ReplTokenRun } from "./description.ts";

/** What a reading could not be fitted into. */
export class ReplFitRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplFitRefusal";
  }
}

/**
 * One visual row of a reading, fitted to a measured width.
 *
 * Immutable frame preparation data. The same list answers how many rows there
 * are, which of them a window admits, what each description says and which
 * boxes a frame places — so a row count and a drawn row cannot disagree about
 * what was prepared.
 */
export interface ReplPreparedRow {
  readonly key: string;
  /** Exactly the characters this row draws. Never trimmed, never shortened. */
  readonly text: string;
  /** What each part of that text is. Concatenates to exactly `text`. */
  readonly runs: readonly ReplTokenRun[];
  /** The logical line this row came from. */
  readonly line: string;
  /** Whether a previous row already carried the start of that line. */
  readonly continuation: boolean;
  readonly rail: ReplReadingLine["rail"];
  readonly depth: number;
  /**
   * How far this row is set in from the start of the content region.
   *
   * The nesting depth's own indent, and on a continuation the leading
   * whitespace of the logical line it continues as well — so a line that
   * wrapped is still read at the column it was written at. Without it a
   * continuation sits further left than the row above it and reads as a new,
   * shallower line, which is a claim about structure that the source does not
   * make.
   *
   * Display only. No source byte and no offset moves, and concatenating a
   * line's rows still recovers exactly its text.
   */
  readonly indent: number;
  /** Present on a logical line's first row only. */
  readonly badge: readonly ReplTokenRun[] | undefined;
  readonly style: ReplReadingLine["style"];
  /** How many cells the engine says `text` occupies. */
  readonly width: number;
}

/** What a prepared reading reserved before any of its text was fitted. */
export interface ReplFitReservation {
  /** The rail column, measured rather than counted. */
  readonly rail: number;
  /** The gap between the rail and the text. */
  readonly separator: number;
  /** The status column, wide enough for every reading a badge can hold. */
  readonly status: number;
  /** What is left for text after all three. */
  readonly content: number;
  /** How wide the engine says each badge reading is, by its exact text. */
  readonly statusWidths: ReadonlyMap<string, number>;
}

/** A reading prepared for one measured width. */
export interface ReplPreparedReading {
  readonly reservation: ReplFitReservation;
  readonly rows: readonly ReplPreparedRow[];
}

/**
 * Where one logical line was cut, and how wide the piece measured.
 *
 * The measured half of a row, and the only half an engine answer decides.
 * Which text it holds comes from the line it belongs to, so this stays true
 * for as long as that line's text and depth do.
 */
export interface ReplRowCut {
  /** The offset into the logical line this piece starts at. */
  readonly from: number;
  /** How many code units of it this piece holds. */
  readonly length: number;
  /** Whether a previous piece already carried the start of this line. */
  readonly continuation: boolean;
  /** The column this line was written at, carried onto its continuations. */
  readonly indent: number;
  /** What the engine measured this exact piece as. */
  readonly width: number;
}

/**
 * Everything about a reading that measurement decides.
 *
 * The reservation and one cut list per logical line, in order. It is a
 * function of the lines' text and depth, the room they were fitted to, and
 * the terminal size — and of nothing else. A badge arriving, a phase
 * settling, a selection moving and a position being inspected all leave it
 * exactly as it was, which is why it can be kept and reused.
 */
export interface ReplFitGeometry {
  readonly reservation: ReplFitReservation;
  readonly cuts: readonly (readonly ReplRowCut[])[];
}

/**
 * The geometry one running REPL is holding on to.
 *
 * Typing moves the draft, not the reading beside it, and a reading is the
 * expensive thing to fit: a two-hundred-line entry costs an engine render per
 * line plus a binary search per overflowing row, and a keystroke used to pay
 * that twice. This keeps the last answer and the exact inputs it was computed
 * from, so a frame whose reading has not moved reuses it.
 *
 * Inputs are compared, not digested. A few hundred short string comparisons
 * are far below one render, and a digest would trade a guarantee for a
 * cheaper comparison that is already cheap.
 */
export interface ReplFitStore {
  /** The geometry retained for these exact inputs, or none. */
  held(
    lines: readonly ReplReadingLine[],
    room: number,
    size: ReplTerminalSize,
  ): ReplFitGeometry | undefined;
  /** Retain this geometry as the answer for these inputs. */
  keep(
    lines: readonly ReplReadingLine[],
    room: number,
    size: ReplTerminalSize,
    geometry: ReplFitGeometry,
  ): void;
}

/** A store holding one reading's geometry, owned by whoever creates it. */
export function createFitStore(): ReplFitStore {
  let held:
    | {
        readonly shape: readonly { readonly text: string; readonly depth: number }[];
        readonly room: number;
        readonly columns: number;
        readonly rows: number;
        readonly geometry: ReplFitGeometry;
      }
    | undefined;
  const same = (lines: readonly ReplReadingLine[], room: number, size: ReplTerminalSize) =>
    held !== undefined &&
    held.room === room &&
    held.columns === size.columns &&
    held.rows === size.rows &&
    held.shape.length === lines.length &&
    held.shape.every((one, at) => one.text === lines[at].text && one.depth === lines[at].depth);
  return {
    held(lines, room, size) {
      return same(lines, room, size) ? held?.geometry : undefined;
    },
    keep(lines, room, size, geometry) {
      held = {
        shape: lines.map((one) => ({ text: one.text, depth: one.depth })),
        room,
        columns: size.columns,
        rows: size.rows,
        geometry,
      };
    },
  };
}

/** The rail glyph, and the gap between it and the text beside it. */
const RAIL = "│";
const SEPARATOR = "  ";

/**
 * Ask the engine how wide each of these texts is.
 *
 * One fit-sized element per text, each under its own structural id, all in one
 * render — and every answer copied into a plain map before returning, because
 * the engine's geometry is only valid until the next measurement.
 */
function* widths(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  texts: readonly string[],
): Operation<Result<readonly number[]>> {
  if (texts.length === 0) {
    return Ok([]);
  }
  const ops: Op[] = [
    open("fit:root", { layout: { width: fit(), height: fit(), direction: "ttb" } }),
  ];
  for (const [index, one] of texts.entries()) {
    ops.push(open(`fit:${index}`, { layout: { width: fit(), height: fit() } }));
    if (one.length > 0) {
      ops.push(text(one));
    }
    ops.push(close());
  }
  ops.push(close());
  const measured = yield* renderer.measure(ops, size);
  if (!measured.ok) {
    return measured;
  }
  const answers: number[] = [];
  for (const [index, one] of texts.entries()) {
    // An empty text occupies nothing; the engine gives its element no bounds to
    // report, which is the same answer said differently.
    if (one.length === 0) {
      answers.push(0);
      continue;
    }
    const bounds = measured.value.boundsOf(`fit:${index}`);
    if (bounds === undefined) {
      return Err(new ReplFitRefusal(`the engine measured no width for ${JSON.stringify(one)}`));
    }
    answers.push(Math.ceil(bounds.width));
  }
  return Ok(answers);
}

/**
 * What a reading reserves before any of its text is fitted.
 *
 * The rail, the gap after it and the status column, every one of them an engine
 * answer rather than a character count — `◀ EXIT · ● WAITING` is nineteen code
 * units and nineteen cells only by coincidence, and the glyphs in it are
 * exactly the characters a count gets wrong.
 *
 * The status column is the widest reading a badge can hold, including the
 * cleanup wait that says two things at once. Reserving per row instead would
 * make every phase change re-cut the source beside it, so a reader watching an
 * element settle would see their own document reflow.
 */
export function* reserveFor(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  room: number,
): Operation<Result<ReplFitReservation>> {
  const measured = yield* widths(renderer, size, [RAIL, SEPARATOR, ...READING_STATUSES]);
  if (!measured.ok) {
    return measured;
  }
  const [rail, separator, ...statuses] = measured.value;
  const status = statuses.reduce((widest, one) => Math.max(widest, one), 0);
  const content = room - rail - separator - separator - status;
  if (content < 1) {
    return Err(
      new ReplFitRefusal(
        `a reading needs ${rail + separator + separator + status + 1} columns and has ${room}`,
      ),
    );
  }
  const statusWidths = new Map<string, number>();
  for (const [index, one] of READING_STATUSES.entries()) {
    statusWidths.set(one, statuses[index]);
  }
  return Ok(Object.freeze({ rail, separator, status, content, statusWidths }));
}

/**
 * One reading's logical lines as the rows they are drawn in.
 *
 * Every nonempty iteration consumes source, so this terminates and nothing is
 * dropped: concatenating one logical line's rows recovers exactly its text,
 * whitespace and all. A blank logical line stays one row, because it is a line
 * of somebody's document.
 */
export function* prepareReading(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  lines: readonly ReplReadingLine[],
  room: number,
  store?: ReplFitStore,
): Operation<Result<ReplPreparedReading>> {
  const retained = store?.held(lines, room, size);
  if (retained !== undefined) {
    return Ok(decorate(lines, retained));
  }
  const measured = yield* fitGeometry(renderer, size, lines, room);
  if (!measured.ok) {
    return measured;
  }
  store?.keep(lines, room, size, measured.value);
  return Ok(decorate(lines, measured.value));
}

/**
 * Everything measurement decides about a reading, and nothing else.
 *
 * Every engine render this file performs for a reading happens here. What
 * comes back says where each line was cut and how wide each piece is; which
 * rail, badge and roles those pieces are drawn with is decided afterwards,
 * from the lines as they stand at the time.
 */
function* fitGeometry(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  lines: readonly ReplReadingLine[],
  room: number,
): Operation<Result<ReplFitGeometry>> {
  const reserved = yield* reserveFor(renderer, size, room);
  if (!reserved.ok) {
    return reserved;
  }
  const reservation = reserved.value;
  const cuts: (readonly ReplRowCut[])[] = [];
  // Nesting is drawn inside the content region rather than beside it, so a
  // deeply nested element loses text room rather than pushing the status column
  // off the pane it was measured against.
  for (const line of lines) {
    const indent = Math.min(line.depth * 2, Math.max(0, reservation.content - 1));
    const fitted = yield* fitLine(renderer, size, line, reservation.content - indent);
    if (!fitted.ok) {
      return fitted;
    }
    cuts.push(fitted.value);
  }
  // The finished candidates, measured again as the text they ended up being.
  // The search above narrowed over prefixes; this is the row, and a row that
  // does not fit the region it was cut for is a frame refusal rather than
  // something to clip.
  const flat = cuts.flatMap((one, at) =>
    one.map((cut) => lines[at].text.slice(cut.from, cut.from + cut.length)),
  );
  const widest = yield* widths(renderer, size, flat);
  if (!widest.ok) {
    return widest;
  }
  const sized: (readonly ReplRowCut[])[] = [];
  let index = 0;
  for (const [at, one] of cuts.entries()) {
    const line: ReplRowCut[] = [];
    for (const cut of one) {
      const width = widest.value[index];
      index += 1;
      const indent = Math.min(
        lines[at].depth * 2 + cut.indent,
        Math.max(0, reservation.content - 1),
      );
      if (width > reservation.content - indent) {
        return Err(
          new ReplFitRefusal(
            `row ${keyOf(lines[at], cut)} measured ${width} columns in ${
              reservation.content - indent
            }`,
          ),
        );
      }
      line.push(Object.freeze({ ...cut, width }));
    }
    sized.push(Object.freeze(line));
  }
  return Ok(Object.freeze({ reservation, cuts: Object.freeze(sized) }));
}

/**
 * The rows these lines are drawn as, over geometry already measured.
 *
 * The live half: rails, badges, roles and token runs come from the lines as
 * they stand now, so an element settling or a position being inspected shows
 * immediately over cuts that were measured once.
 */
function decorate(
  lines: readonly ReplReadingLine[],
  geometry: ReplFitGeometry,
): ReplPreparedReading {
  const rows: ReplPreparedRow[] = [];
  for (const [at, one] of geometry.cuts.entries()) {
    const line = lines[at];
    for (const cut of one) {
      rows.push(
        Object.freeze({
          ...row(
            line,
            line.text.slice(cut.from, cut.from + cut.length),
            cut.from,
            cut.continuation,
            cut.indent,
          ),
          width: cut.width,
        }),
      );
    }
  }
  return Object.freeze({ reservation: geometry.reservation, rows: Object.freeze(rows) });
}

/** The key a cut of this line is drawn under. */
function keyOf(line: ReplReadingLine, cut: ReplRowCut): string {
  return cut.continuation ? `${line.key}+${cut.from}` : line.key;
}

/** One line of read-only text, fitted to a width. */
export interface ReplFittedLine {
  readonly key: string;
  readonly text: string;
  readonly runs: readonly ReplTokenRun[];
  /** Whether a previous row already carried the start of this line. */
  readonly continuation: boolean;
  /** The column this line was written at, carried onto its continuations. */
  readonly indent: number;
}

/**
 * Fit read-only text to a width, with nothing reserved beside it.
 *
 * The reading's own `prepareReading` reserves a rail and a status column
 * because every row of it carries both. A drawer's message carries neither: it
 * is somebody's text in a box, and all of the box is for the text.
 *
 * The same measurement and the same cuts otherwise — engine widths, grapheme
 * boundaries, word boundaries preferred, whitespace kept, blank lines kept —
 * so concatenating one line's rows recovers exactly the line. A drawer that
 * showed one row per logical line could only ever show the first screenful of
 * a long one, and scrolling cannot reveal a row that was never prepared.
 */
export function* fitPlain(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  lines: readonly {
    readonly key: string;
    readonly text: string;
    readonly runs?: readonly ReplTokenRun[];
  }[],
  room: number,
): Operation<Result<readonly ReplFittedLine[]>> {
  if (room < 1) {
    return Ok([]);
  }
  const fitted: ReplFittedLine[] = [];
  for (const one of lines) {
    const runs = one.runs ?? tokenRuns([{ text: one.text, token: "source" }]);
    const line = Object.freeze({
      key: one.key,
      text: one.text,
      runs,
      rail: "rail-pending" as const,
      depth: 0,
      badge: undefined,
      style: Object.freeze({ role: "source" as const, selected: false, inspected: false }),
    });
    const cuts = yield* fitLine(renderer, size, line, room);
    if (!cuts.ok) {
      return cuts;
    }
    for (const cut of cuts.value) {
      const drawn = row(
        line,
        line.text.slice(cut.from, cut.from + cut.length),
        cut.from,
        cut.continuation,
        cut.indent,
      );
      fitted.push(
        Object.freeze({
          key: drawn.key,
          text: drawn.text,
          runs: drawn.runs,
          continuation: drawn.continuation,
          indent: drawn.indent,
        }),
      );
    }
  }
  return Ok(Object.freeze(fitted));
}

/**
 * One logical line as the pieces it is cut into.
 *
 * Widths are filled in by the pass that measures every finished piece at once;
 * nothing reads them in between.
 */
function* fitLine(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  line: ReplReadingLine,
  room: number,
): Operation<Result<readonly ReplRowCut[]>> {
  // A blank line is a row. Measuring it would ask the engine the width of
  // nothing, and dropping it would edit the shape of somebody's document.
  if (line.text.length === 0) {
    return Ok([piece(0, 0, false, 0)]);
  }
  const whole = yield* widths(renderer, size, [line.text]);
  if (!whole.ok) {
    return whole;
  }
  if (whole.value[0] <= room) {
    return Ok([piece(0, line.text.length, false, 0)]);
  }
  // Where this line begins, so its continuations begin there too. Bounded well
  // inside the region: an indent that left no room for text would make a row
  // that consumes nothing, and this loop would not terminate.
  const hanging = Math.min(
    line.text.length - line.text.trimStart().length,
    Math.max(0, Math.floor(room / 2)),
  );
  const cuts: ReplRowCut[] = [];
  let at = 0;
  while (at < line.text.length) {
    const rest = line.text.slice(at);
    const cut = yield* cutAt(renderer, size, rest, at > 0 ? room - hanging : room);
    if (!cut.ok) {
      return cut;
    }
    cuts.push(piece(at, cut.value, at > 0, at > 0 ? hanging : 0));
    at += cut.value;
  }
  return Ok(Object.freeze(cuts));
}

/** One cut, before the pass that measures it. */
function piece(from: number, length: number, continuation: boolean, indent: number): ReplRowCut {
  return Object.freeze({ from, length, continuation, indent, width: 0 });
}

/**
 * How many code units of `rest` fit in `room`, cut where a reader would cut.
 *
 * The longest prefix the engine measures as fitting, then back to its last
 * whitespace boundary if it has one — whitespace kept in the prefix, because it
 * is part of the line and the next row does not begin with somebody else's
 * space. A word longer than the region has no such boundary and is broken at
 * the longest fitting grapheme instead, which is the only way text wider than
 * its pane can be read at all.
 */
function* cutAt(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  rest: string,
  room: number,
): Operation<Result<number>> {
  const stops = graphemeStops(rest);
  // Narrow by halves over grapheme boundaries, asking the engine for one batch
  // of candidates per round rather than one render per candidate.
  let low = 0;
  let high = stops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const measured = yield* widths(renderer, size, [rest.slice(0, stops[middle])]);
    if (!measured.ok) {
      return measured;
    }
    if (measured.value[0] <= room) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low === 0) {
    // Not one grapheme fits. Clipping it would show the reader a row that is
    // not what their file says, so the frame refuses instead.
    return Err(
      new ReplFitRefusal(
        `${room} columns hold no grapheme of ${JSON.stringify(rest.slice(0, stops[1] ?? 1))}`,
      ),
    );
  }
  const longest = stops[low];
  const preferred = wordBoundary(rest, longest);
  return Ok(preferred === undefined ? longest : preferred);
}

/**
 * The last whitespace boundary at or before `longest`, or none.
 *
 * Counted as the offset *after* the run of whitespace, so the spaces a reader
 * typed stay on the row that ends with them. A boundary at zero is not one: it
 * would consume nothing and loop.
 */
function wordBoundary(text: string, longest: number): number | undefined {
  let at: number | undefined;
  for (let index = 0; index < longest; index += 1) {
    if (/\s/.test(text[index]) && !/\s/.test(text[index + 1] ?? "x")) {
      at = index + 1;
    }
  }
  return at === undefined || at === 0 ? undefined : at;
}

/**
 * Every grapheme boundary of a string, as offsets into it.
 *
 * `Intl.Segmenter` is what decides, so a base character and its combining
 * marks are one stop and an emoji sequence is one stop. The list starts at zero
 * and ends at the string's length, so `stops[n]` is always a slice offset.
 */
function graphemeStops(text: string): readonly number[] {
  const stops: number[] = [0];
  for (const { index } of segmenter.segment(text)) {
    if (index > 0) {
      stops.push(index);
    }
  }
  stops.push(text.length);
  return stops;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * One prepared row.
 *
 * The runs are cut by the same offsets the text was, so a token that spans a
 * break becomes two runs of one role rather than one row of ordinary prose.
 * Only the first row of a logical line carries its badge.
 */
function row(
  line: ReplReadingLine,
  shown: string,
  from: number,
  continuation: boolean,
  hanging: number,
): ReplPreparedRow {
  return Object.freeze({
    // Replaced by the engine's answer for this exact row before the reading is
    // returned; nothing reads it in between.
    width: 0,
    indent: continuation ? hanging : 0,
    key: continuation ? `${line.key}+${from}` : line.key,
    text: shown,
    runs: slicedRuns(line.runs, from, from + shown.length),
    line: line.key,
    continuation,
    rail: line.rail,
    depth: line.depth,
    badge: continuation ? undefined : line.badge,
    style: line.style,
  });
}

/**
 * The part of a run list covering one half-open slice of its text.
 *
 * Roles survive the cut: a quoted value broken across two rows is a quoted
 * value on both of them. A run the slice does not touch is absent rather than
 * empty, which is what keeps the list concatenating to exactly the row's text.
 */
function slicedRuns(
  runs: readonly ReplTokenRun[],
  from: number,
  to: number,
): readonly ReplTokenRun[] {
  const parts: { readonly text: string; readonly token: ReplTokenRun["token"] }[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(at, from);
    const end = Math.min(at + run.text.length, to);
    if (end > start) {
      parts.push({ text: run.text.slice(start - at, end - at), token: run.token });
    }
    at += run.text.length;
  }
  return tokenRuns(parts);
}

/**
 * One prepared row as the runs a description carries.
 *
 * Rail, the gap after it, the nesting indent, the row's own text, then the
 * badge against the region's right inner edge. One row of runs, which is what
 * the existing presentation already draws as several text operations inside one
 * measured element — so this introduces no second rendering path and inherits
 * the bound that keeps a row inside its own region.
 *
 * The padding is arithmetic over engine answers, not over character counts:
 * every width in it was measured, and the badge column is the reservation every
 * row of the reading shares.
 */
export function readingRuns(
  prepared: ReplPreparedReading,
  one: ReplPreparedRow,
): readonly ReplTokenRun[] {
  const { reservation } = prepared;
  const indent = Math.min(one.depth * 2 + one.indent, Math.max(0, reservation.content - 1));
  const parts: { readonly text: string; readonly token: ReplTokenRun["token"] }[] = [
    { text: RAIL, token: one.rail },
    { text: SEPARATOR, token: "punctuation" },
  ];
  if (indent > 0) {
    parts.push({ text: " ".repeat(indent), token: "punctuation" });
  }
  for (const run of one.runs) {
    parts.push({ text: run.text, token: run.token });
  }
  const badge = one.badge;
  const shown = badge === undefined ? "" : runText(badge);
  const width = badge === undefined ? 0 : (reservation.statusWidths.get(shown) ?? shown.length);
  // Everything between the end of the text and the start of the status column,
  // so a row with no badge still ends where the reading ends and the column is
  // the same column on every row of it.
  const gap =
    reservation.content - indent - one.width + reservation.separator + (reservation.status - width);
  if (gap > 0) {
    parts.push({ text: " ".repeat(gap), token: "punctuation" });
  }
  for (const run of badge ?? []) {
    parts.push({ text: run.text, token: run.token });
  }
  return tokenRuns(parts);
}
