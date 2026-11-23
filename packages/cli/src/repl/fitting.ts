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

import { boundaries, caretRow } from "./caret.ts";
import type { ReplCaret, ReplCaretRow } from "./caret.ts";

import { close, fit, open, text } from "../../generated/tty/mod.js";
import type { Op } from "../../generated/tty/mod.js";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { ReplRenderer } from "./renderer.ts";
import type { ReplTerminalSize } from "./terminal.ts";
import type { ReplReadingLine, ReplSourceInspectionStore } from "./source-reading.ts";
import { createSourceInspectionStore, READING_STATUSES } from "./source-reading.ts";
import { runText, tokenRuns } from "./description.ts";
import { createMarkdownStore } from "./markdown.ts";
import type { ReplMarkdownStore } from "./markdown.ts";
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
   * shallower line, which is a structural distinction that the source does not
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
 * expensive thing to fit: a two-hundred-line entry costs a binary search per
 * overflowing row, its lines searched together, and a keystroke used to pay
 * that twice. This keeps the last answer and the exact inputs it was computed
 * from, so a frame whose reading has not moved reuses it.
 *
 * Inputs are compared, not digested. A few hundred short string comparisons
 * are far below one render, and a digest would trade a guarantee for a
 * cheaper comparison that is already cheap.
 */
export interface ReplFitStore {
  /**
   * The reading's written Output as formatted lines, held for the same
   * lifetime as its geometry: every frame builds the reading again, and a
   * body that has not changed is not read again.
   */
  readonly formatted: ReplMarkdownStore;
  readonly sourceInspections: ReplSourceInspectionStore;
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

/**
 * The plain-text line cuts one running REPL is holding on to.
 *
 * Per line, which is the whole point of it being separate from
 * {@link ReplFitStore}. The chat's newest line grows on its own and a new
 * message is appended on its own, so a store that could only answer for a whole
 * list would remeasure every older message for every delta — and a wrapping
 * message costs a binary search per row it overflows into. Twenty of them
 * turned one typed key into 1,284 measurement renders.
 *
 * A cut is an answer for one exact text at one exact room and size, so that is
 * what it is keyed by. Two lines spelled the same are the same question and
 * share the answer. Nothing is digested: a string comparison is far below one
 * render, and a digest would trade a guarantee for a cheapness already had.
 */
export interface ReplPlainFitStore {
  /** The cuts retained for this exact line and these exact inputs, or none. */
  held(text: string, room: number, size: ReplTerminalSize): readonly ReplRowCut[] | undefined;
  /** Retain these cuts as the answer for that line at those inputs. */
  keep(text: string, room: number, size: ReplTerminalSize, cuts: readonly ReplRowCut[]): void;
  /**
   * Keep the lines this preparation actually prepared, and nothing else.
   *
   * Successful fitting retains its completed texts and geometry. Chat preparation
   * also prunes to its candidate before fitting, then clears that candidate on
   * refusal or cancellation. Other failed preparations retain completed per-line
   * cuts without publishing a completed sequence.
   */
  settle(texts: readonly string[], room: number, size: ReplTerminalSize): void;
  /** Measured stops relative to one fitted row, independent of its source offset. */
  heldCaret(
    text: string,
    indent: number,
    room: number,
    size: ReplTerminalSize,
  ): ReplCaretRow | undefined;
  /** Retain only the rows of the editor this preparation completed. */
  keepCarets(
    rows: readonly { readonly text: string; readonly indent: number; readonly row: ReplCaretRow }[],
    room: number,
    size: ReplTerminalSize,
  ): void;
}

/**
 * A store holding one list of plain-text cuts, owned by whoever creates it.
 *
 * One set of measured dimensions at a time. Cuts taken at another width answer
 * a different question, so a room or terminal size that moves empties it rather
 * than keeping a cache of every size this command has ever drawn at.
 */
export function createPlainFitStore(): ReplPlainFitStore {
  let at: { readonly room: number; readonly columns: number; readonly rows: number } | undefined;
  let cuts = new Map<string, readonly ReplRowCut[]>();
  let carets = new Map<string, ReplCaretRow>();
  const caretKey = (text: string, indent: number): string => JSON.stringify([text, indent]);
  const here = (room: number, size: ReplTerminalSize): boolean =>
    at !== undefined && at.room === room && at.columns === size.columns && at.rows === size.rows;
  const moveTo = (room: number, size: ReplTerminalSize): void => {
    if (here(room, size)) {
      return;
    }
    cuts = new Map();
    carets = new Map();
    at = { room, columns: size.columns, rows: size.rows };
  };
  return {
    held(text, room, size) {
      return here(room, size) ? cuts.get(text) : undefined;
    },
    keep(text, room, size, held) {
      moveTo(room, size);
      cuts.set(text, held);
    },
    settle(texts, room, size) {
      moveTo(room, size);
      const kept = new Map<string, readonly ReplRowCut[]>();
      for (const one of texts) {
        const found = cuts.get(one);
        if (found !== undefined) {
          kept.set(one, found);
        }
      }
      cuts = kept;
    },
    heldCaret(text, indent, room, size) {
      return here(room, size) ? carets.get(caretKey(text, indent)) : undefined;
    },
    keepCarets(rows, room, size) {
      moveTo(room, size);
      carets = new Map(rows.map((one) => [caretKey(one.text, one.indent), one.row]));
    },
  };
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
    formatted: createMarkdownStore(),
    sourceInspections: createSourceInspectionStore(),
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
 * How many texts one measuring render may carry.
 *
 * Each nonempty candidate costs the engine an element for its own box and
 * another for the text inside it, and an engine refuses a list that outgrows
 * its element budget. It says so as unbalanced structure rather than as a
 * capacity refusal, which is not something to reinterpret here: the operations
 * really are balanced, and a larger engine would not bound the request anyway.
 *
 * So the request is bounded instead. A finished reading is as long as the entry
 * that produced it, which is a length no viewport limits — measured through
 * this path, 4,000 short rows went through and 4,096 did not. A batch of a
 * thousand leaves the budget most of its room whatever else a frame is
 * measuring, and costs another pass rather than another answer.
 */
const WIDTHS_PER_RENDER = 1024;

/**
 * How many space-separated parts one measuring render may carry.
 *
 * The element budget is not the engine's only one. Every part of every text a
 * render measures is kept in a cache the engine refuses from, and that cache
 * holds the same number of them however few elements carry them: measured on a
 * freshly built engine, one text of 16,384 parts and 1,366 texts of twelve each
 * refuse, while 16,383 parts go through either way. A tab and a newline are not
 * separators there, a run of spaces produces an empty part that costs what a
 * word costs, and two texts spelled the same share one entry.
 *
 * This is the budget whose refusal the renderer's recovery cannot absorb: a
 * replacement instance is given the same cache, so a render that overran it
 * overruns the replacement too and the refusal reaches the screen as the error
 * that ends it. Half the engine's own figure, which leaves the parts an
 * instance is still holding from the render before this one somewhere to sit.
 */
const WORDS_PER_RENDER = 8192;

/**
 * How many space-separated parts one render of a many-line search may carry.
 *
 * The engine's own figure scales with the terminal it was opened at: measured
 * on a fresh engine, about 16,383 parts at 120x40 and above, 7,677 at 80x24,
 * 4,797 at 60x20 and 4,095 at 40x12. A search step asks a question of every
 * line still being cut, so on a long reading it fills whatever budget it is
 * given, and at 80x24 a full one was refused and the reading cut line by line.
 * This sits below the smallest of those figures.
 */
const SEARCH_WORDS_PER_RENDER = 2048;

/** What one text costs that budget, counted the way the engine counts it. */
function wordsIn(text: string): number {
  let parts = 1;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === " ") {
      parts += 1;
    }
  }
  return parts;
}

/**
 * How much of one line could still fit a region, as a length in code units.
 *
 * A single text is bounded by no batch size, and one line of somebody's output
 * can hold more parts than a render measures — a journal of this product holds
 * lines of 19,999 — so a line is measured as far as it could still fit and
 * never further. That prefix settles the question it is asked: every part after
 * the first is preceded by a space, so `room + 2` of them are already wider
 * than `room` columns, and text does not narrow when more of it is appended.
 * The prefix ends at a space, which is a grapheme boundary of its own.
 */
function windowOf(text: string, room: number): number {
  const parts = Math.min(room + 2, WORDS_PER_RENDER);
  let seen = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === " ") {
      seen += 1;
      if (seen === parts) {
        return at;
      }
    }
  }
  return text.length;
}

/**
 * Ask the engine how wide each of these texts is.
 *
 * One fit-sized element per text, each under its own structural id, in as many
 * renders as the count needs — and every answer copied out of each batch
 * before the next render, because the engine's geometry is only valid until
 * the next measurement. The answers come back in the order they were asked
 * for, one per text, empty ones included. `words` is the part budget each
 * render is held to.
 */
function* widths(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  texts: readonly string[],
  words = WORDS_PER_RENDER,
): Operation<Result<readonly number[]>> {
  if (texts.length === 0) {
    return Ok([]);
  }
  const answers: number[] = [];
  let from = 0;
  while (from < texts.length) {
    let to = from;
    let carried = 0;
    while (to < texts.length && to - from < WIDTHS_PER_RENDER) {
      const cost = wordsIn(texts[to]);
      // A text that outgrows the budget on its own still goes, alone, so the
      // engine's refusal names that text rather than this loop never advancing.
      if (to > from && carried + cost > words) {
        break;
      }
      carried += cost;
      to += 1;
    }
    const batch = yield* batchWidths(renderer, size, texts.slice(from, to));
    if (!batch.ok) {
      return batch;
    }
    answers.push(...batch.value);
    from = to;
  }
  return Ok(answers);
}

/**
 * One measuring render, read before anything can invalidate it.
 *
 * The ids are the batch's own, and every batch reuses them. The measuring
 * instance accumulates state for each distinct id it is given, across renders:
 * measured, a run of four thousand freshly named elements left the last of
 * them with no bounds and reported no error for it. Numbering from zero again
 * each time keeps that set no larger than one batch. A refusal names the text
 * rather than the position, so nothing outside here needs the numbering.
 */
function* batchWidths(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  texts: readonly string[],
): Operation<Result<readonly number[]>> {
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

/** The mark a name wears where it gave up columns. */
const ELISION = "\u2026";

/** One label fitted to a cell budget, with the cells the engine measured for it. */
export interface ReplFittedLabel {
  readonly text: string;
  /** What the engine says it occupies, which is what a caller states. */
  readonly cells: number;
}

/**
 * One name fitted into a cell budget at grapheme boundaries, and its own width.
 *
 * The engine answers how wide text is and `Intl.Segmenter` decides where it may
 * be cut. Those are the two facts a count of code units gets wrong, and it gets
 * them wrong in opposite directions: a wide character occupies two cells and
 * counts as one unit, and a base character with its combining marks occupies
 * one cell and counts as several. Measured, a selector holding twenty-five
 * `\u754c` declared twenty-nine cells and needed fifty-four — so nothing of it
 * was drawn — and one holding combining accents declared more cells than it
 * used and published a target reaching into the column beside it. A third cut
 * an emoji sequence in half and drew two glyphs where its author wrote one.
 *
 * `keep` is the tail that never gives up its cells: the mark that says a
 * control opens is not a detail of the name in front of it. `room` is the
 * budget the two of them share.
 *
 * The answer carries the cells the engine measured for the whole of it, so the
 * caller states a width rather than counting one — and the text and that width
 * are one answer, which is what keeps a label and the box it is drawn in from
 * disagreeing about how much room it needs.
 */
export function* fitCells(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  name: string,
  keep: string,
  room: number,
): Operation<Result<ReplFittedLabel>> {
  if (room < 1) {
    return Ok(Object.freeze({ text: "", cells: 0 }));
  }
  const whole = `${name}${keep}`;
  const measured = yield* widths(renderer, size, [whole, keep, ELISION]);
  if (!measured.ok) {
    return measured;
  }
  const [wholeCells, keepCells, markCells] = measured.value;
  if (wholeCells <= room) {
    return Ok(Object.freeze({ text: whole, cells: wholeCells }));
  }
  // What the name may take once the tail and the mark saying it was cut have
  // had theirs. Where that leaves nothing, the name gives up every column it
  // had and what the row says is the tail alone — the same rule the row's own
  // vocabulary already follows, which is that what was named survives whole.
  const budget = room - keepCells - markCells;
  if (budget < 1) {
    return Ok(
      Object.freeze({ text: keepCells <= room ? keep : "", cells: Math.min(keepCells, room) }),
    );
  }
  // Narrow by halves over grapheme boundaries, asking the engine for one batch
  // of candidates per round rather than one render per candidate.
  const stops = graphemeStops(name);
  let low = 0;
  let high = stops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const answer = yield* widths(renderer, size, [name.slice(0, stops[middle])]);
    if (!answer.ok) {
      return answer;
    }
    if (answer.value[0] <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const text = `${name.slice(0, stops[low])}${ELISION}${keep}`;
  const final = yield* widths(renderer, size, [text]);
  if (!final.ok) {
    return final;
  }
  return Ok(Object.freeze({ text, cells: final.value[0] }));
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
  // Nesting is drawn inside the content region rather than beside it, so a
  // deeply nested element loses text room rather than pushing the status column
  // off the pane it was measured against.
  const rooms = lines.map((line) => ({
    text: line.text,
    room: reservation.content - Math.min(line.depth * 2, Math.max(0, reservation.content - 1)),
  }));
  let cuts = yield* cutTogether(renderer, size, rooms);
  if (cuts === undefined) {
    const inOrder: (readonly ReplRowCut[])[] = [];
    for (const one of rooms) {
      const fitted = yield* cutLines(renderer, size, [one]);
      if (!fitted.ok) {
        return fitted;
      }
      inOrder.push(fitted.value[0]);
    }
    cuts = inOrder;
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
  /**
   * The logical line this row is a piece of.
   *
   * The same key for every piece, so a caller that composed those lines can
   * find its own item again without parsing one back out of a row's key. The
   * first piece carries the line's own key and a continuation carries a derived
   * one, which is a fact about rows rather than about what was written.
   */
  readonly line: string;
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
  /**
   * Where this caller is holding the cuts it has already measured.
   *
   * Geometry only. The keys, the text and the runs below are this frame's, so a
   * reused cut decorates the line in front of it rather than restoring a row
   * somebody drew earlier. A caller with no store measures everything, which is
   * what one holding a single frame wants.
   */
  store?: ReplPlainFitStore,
): Operation<Result<readonly ReplFittedLine[]>> {
  if (room < 1) {
    return Ok([]);
  }
  const fitted: ReplFittedLine[] = [];
  // Every distinct line the store does not hold, cut together where that asks
  // the same questions. The loop below still owns the store and the order, so a
  // line this could not answer is cut there exactly as it would be alone.
  const missing = [
    ...new Set(
      lines.filter((one) => store?.held(one.text, room, size) === undefined).map((one) => one.text),
    ),
  ];
  const together = yield* cutTogether(
    renderer,
    size,
    missing.map((text) => ({ text, room })),
  );
  const batched = new Map(
    together === undefined ? [] : missing.map((text, at) => [text, together[at]] as const),
  );
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
    const retained = store?.held(one.text, room, size);
    let pieces: readonly ReplRowCut[];
    if (retained === undefined) {
      const answered = batched.get(one.text);
      if (answered === undefined) {
        const cuts = yield* cutLines(renderer, size, [{ text: line.text, room }]);
        if (!cuts.ok) {
          return cuts;
        }
        pieces = cuts.value[0];
      } else {
        pieces = answered;
      }
      store?.keep(one.text, room, size, pieces);
    } else {
      pieces = retained;
    }
    for (const cut of pieces) {
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
          line: drawn.line,
          continuation: drawn.continuation,
          indent: drawn.indent,
        }),
      );
    }
  }
  // Only now, with every line of this list fitted: what is retained is the set
  // this preparation prepared, so whatever it no longer holds goes.
  store?.settle(
    lines.map((one) => one.text),
    room,
    size,
  );
  return Ok(Object.freeze(fitted));
}

/** One logical line to cut, and the cells each of its rows may take. */
interface ReplLineRoom {
  readonly text: string;
  readonly room: number;
}

/**
 * Many lines cut in one search, or nothing where that is not the same search.
 *
 * Each measuring render costs about the same whether it carries one text or a
 * thousand, and a reading of a thousand wrapping lines asked one text per
 * render: about fifteen renders per line. Cut together, every line's question
 * for the same step shares a render, so the count follows the depth of the
 * deepest search rather than the number of lines.
 *
 * Only below the measuring terminal's own width. A text wider than the columns
 * the engine was given is answered from the layout around it — alone a
 * breakable one reports the terminal's width, beside a wider unbreakable one it
 * reports its own — so a room that reaches the columns is cut one line at a
 * time, as a lone question.
 *
 * And only where nothing failed. A failure found here is the one some line
 * reached first in the search, which need not be the first line that fails,
 * so it is discarded and the caller cuts its lines one at a time again: in
 * written order, reaching the first failure and saying what it says.
 */
function* cutTogether(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  lines: readonly ReplLineRoom[],
): Operation<readonly (readonly ReplRowCut[])[] | undefined> {
  if (lines.length < 2 || lines.some((one) => one.room >= size.columns)) {
    return undefined;
  }
  const cut = yield* cutLines(renderer, size, lines);
  return cut.ok ? cut.value : undefined;
}

/** Where one line's search stands: the row it is cutting, and how far that row has narrowed. */
interface ReplOpenLine {
  readonly index: number;
  readonly text: string;
  readonly room: number;
  readonly hanging: number;
  readonly cuts: ReplRowCut[];
  at: number;
  rest: string;
  rowRoom: number;
  stops: readonly number[];
  low: number;
  high: number;
}

/**
 * Logical lines as the pieces they are cut into, every line searched at once.
 *
 * Each line asks what it would ask alone, in the same order: one window probe,
 * then for each row a search over that row's grapheme boundaries. What lines
 * share is the render a step's questions travel in, so one line given alone is
 * the sequential cut, one render per question.
 *
 * Widths are filled in by the pass that measures every finished piece at once;
 * nothing reads them in between.
 */
function* cutLines(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  lines: readonly ReplLineRoom[],
): Operation<Result<readonly (readonly ReplRowCut[])[]>> {
  const cut: (readonly ReplRowCut[] | undefined)[] = lines.map(() => undefined);
  // A blank line is a row. Measuring it would ask the engine the width of
  // nothing, and dropping it would edit the shape of somebody's document.
  const asked: number[] = [];
  for (const [index, one] of lines.entries()) {
    if (one.text.length === 0) {
      cut[index] = [piece(0, 0, false, 0)];
    } else {
      asked.push(index);
    }
  }
  // Asked of as much of each line as the region could still hold. One row is a
  // line the engine measured as fitting, and a line held back from the question
  // is longer than the answer it would have given, so it is cut.
  const reaches = asked.map((index) => windowOf(lines[index].text, lines[index].room));
  const reaching = yield* widths(
    renderer,
    size,
    asked.map((index, at) => lines[index].text.slice(0, reaches[at])),
    SEARCH_WORDS_PER_RENDER,
  );
  if (!reaching.ok) {
    return reaching;
  }
  let open: ReplOpenLine[] = [];
  for (const [at, index] of asked.entries()) {
    const { text, room } = lines[index];
    if (reaches[at] === text.length && reaching.value[at] <= room) {
      cut[index] = [piece(0, text.length, false, 0)];
      continue;
    }
    open.push({
      index,
      text,
      room,
      // Where this line begins, so its continuations begin there too. Bounded
      // well inside the region: an indent that left no room for text would make
      // a row that consumes nothing, and this search would not terminate.
      hanging: Math.min(text.length - text.trimStart().length, Math.max(0, Math.floor(room / 2))),
      cuts: [],
      at: 0,
      rest: text,
      rowRoom: room,
      stops: [],
      low: 0,
      high: 0,
    });
  }
  while (open.length > 0) {
    for (const one of open) {
      one.rest = one.text.slice(one.at);
      one.rowRoom = one.at > 0 ? one.room - one.hanging : one.room;
      // Over the boundaries of the prefix that could still fit, which is what
      // keeps every candidate inside one render's budget and keeps this from
      // segmenting the whole remainder once per row of a very long line.
      one.stops = graphemeStops(one.rest.slice(0, windowOf(one.rest, one.rowRoom)));
      one.low = 0;
      one.high = one.stops.length - 1;
    }
    // Narrow every row still searching by halves over grapheme boundaries, all
    // of their candidates for one step in one batch.
    for (
      let searching = open.filter((one) => one.low < one.high);
      searching.length > 0;
      searching = open.filter((one) => one.low < one.high)
    ) {
      const middles = searching.map((one) => Math.ceil((one.low + one.high) / 2));
      const measured = yield* widths(
        renderer,
        size,
        searching.map((one, at) => one.rest.slice(0, one.stops[middles[at]])),
        SEARCH_WORDS_PER_RENDER,
      );
      if (!measured.ok) {
        return measured;
      }
      for (const [at, one] of searching.entries()) {
        if (measured.value[at] <= one.rowRoom) {
          one.low = middles[at];
        } else {
          one.high = middles[at] - 1;
        }
      }
    }
    for (const one of open) {
      if (one.low === 0) {
        // Not one grapheme fits. Clipping it would show the reader a row that
        // is not what their file says, so the frame refuses instead.
        return Err(
          new ReplFitRefusal(
            `${one.rowRoom} columns hold no grapheme of ${JSON.stringify(
              one.rest.slice(0, one.stops[1] ?? 1),
            )}`,
          ),
        );
      }
      const length = rowLength(one.rest, one.stops[one.low]);
      one.cuts.push(piece(one.at, length, one.at > 0, one.at > 0 ? one.hanging : 0));
      one.at += length;
      if (one.at >= one.text.length) {
        cut[one.index] = Object.freeze(one.cuts);
      }
    }
    open = open.filter((one) => one.at < one.text.length);
  }
  return Ok(Object.freeze(cut.map((one) => one ?? [])));
}

/** One cut, before the pass that measures it. */
function piece(from: number, length: number, continuation: boolean, indent: number): ReplRowCut {
  return Object.freeze({ from, length, continuation, indent, width: 0 });
}

/**
 * How many code units of `rest` one row takes, given the longest prefix the
 * engine measured as fitting: cut where a reader would cut.
 *
 * Back to the prefix's last whitespace boundary if it has one — whitespace kept
 * in the prefix, because it is part of the line and the next row does not begin
 * with somebody else's space. A word longer than the region has no such
 * boundary and is broken at the longest fitting grapheme instead, which is the
 * only way text wider than its pane can be read at all.
 *
 * Backing off is for a prefix, and what is left of a line is not one. Where the
 * measured prefix reaches the end of the whole remainder, that remainder is the
 * row: there is nothing after it for a boundary to put on a row of its own, and
 * shortening it anyway would break a row the engine had already accepted —
 * measured, a tail of `it asks for.` came out as `it asks ` and then `for.`.
 * The end of the *remainder* is what decides it, never the end of the bounded
 * window the search was asked over, which can stop short of it.
 */
function rowLength(rest: string, longest: number): number {
  if (longest === rest.length) {
    return longest;
  }
  return wordBoundary(rest, longest) ?? longest;
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
export function slicedRuns(
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

export interface ReplEditor {
  readonly caret: ReplCaret;
  readonly rows: readonly ReplCaretRow[];
  readonly display: readonly { readonly text: string; readonly runs: readonly ReplTokenRun[] }[];
  readonly active: number;
}

export function* fitEditor(
  renderer: ReplRenderer,
  size: ReplTerminalSize,
  caret: ReplCaret,
  room: number,
  focused: boolean,
  store?: ReplPlainFitStore,
  classify: (text: string) => readonly ReplTokenRun[] = (text) => [{ text, token: "field-value" }],
  mode?: "horizontal",
): Operation<Result<ReplEditor>> {
  const lines = caret.value.split("\n").map((text, at) => ({ key: `edit:${at}`, text }));
  // Reserve a blank cell for a caret after the last grapheme of a fitted row.
  const fitted =
    mode === "horizontal"
      ? Ok(lines.map(({ key, text }) => ({ text, line: key, indent: 0 })))
      : yield* fitPlain(renderer, size, lines, Math.max(1, room - 1), store);
  if (!fitted.ok) {
    return fitted;
  }
  const offsets = new Map<string, number>();
  let source = 0;
  for (const line of lines) {
    offsets.set(line.key, source);
    source += line.text.length + 1;
  }
  const rows: ReplCaretRow[] = [];
  const retained: { text: string; indent: number; row: ReplCaretRow }[] = [];
  const display: { text: string; runs: readonly ReplTokenRun[] }[] = [];
  for (const line of fitted.value) {
    const from = offsets.get(line.line) ?? 0;
    let geometry = store?.heldCaret(line.text, line.indent, Math.max(1, room - 1), size);
    if (geometry === undefined) {
      const stops = boundaries(line.text);
      // The engine caps the width of a prefix at the terminal width.
      const measured = yield* widths(
        renderer,
        size,
        stops.map((at, index) =>
          mode === "horizontal"
            ? line.text.slice(stops[index - 1] ?? 0, at)
            : line.text.slice(0, at),
        ),
      );
      if (!measured.ok) {
        return measured;
      }
      let column = line.indent;
      geometry = {
        stops: stops.map((offset, index) => {
          column =
            mode === "horizontal"
              ? column + measured.value[index]
              : line.indent + measured.value[index];
          return { offset, column };
        }),
      };
    }
    retained.push({ text: line.text, indent: line.indent, row: geometry });
    rows.push({
      stops: geometry.stops.map((stop) => ({ offset: from + stop.offset, column: stop.column })),
    });
    const own = `${" ".repeat(line.indent)}${line.text}`;
    display.push({ text: own, runs: classify(own) });
    offsets.set(line.line, from + line.text.length);
  }
  store?.keepCarets(retained, Math.max(1, room - 1), size);
  const active = caretRow(rows, caret.offset, caret.backward);
  const line = fitted.value[active];
  if (focused && line !== undefined) {
    const from = rows[active].stops[0]?.offset ?? 0;
    const at = caret.offset - from;
    const end = boundaries(line.text).find((one) => one > at) ?? at;
    const before = `${" ".repeat(line.indent)}${line.text.slice(0, at)}`;
    const glyph = line.text.slice(at, end) || " ";
    const after = line.text.slice(end);
    display[active] = {
      text: before + glyph + after,
      runs: tokenRuns([
        ...slicedRuns(classify(before + glyph + after), 0, before.length),
        { text: glyph, token: "caret" },
        ...slicedRuns(
          classify(before + glyph + after),
          before.length + glyph.length,
          before.length + glyph.length + after.length,
        ),
      ]),
    };
  }
  if (mode === "horizontal") {
    const activeStops = rows[active]?.stops ?? [];
    const caretIndex = activeStops.findIndex((stop) => stop.offset === caret.offset);
    const activeColumn = activeStops[caretIndex]?.column ?? 0;
    const caretEnd = activeStops[caretIndex + 1]?.column ?? activeColumn + 1;
    const left = Math.max(0, Math.max(activeColumn + 1, caretEnd) - room);
    for (const [at, one] of display.entries()) {
      const stops = rows[at].stops;
      const first = stops[0]?.offset ?? 0;
      const last = stops.at(-1);
      const start = stops.find((stop) => stop.column >= left);
      let end: (typeof stops)[number] | undefined;
      for (const stop of stops) {
        if (stop.column > left + room) {
          break;
        }
        end = stop;
      }
      if (start === undefined || end === undefined || end.offset < start.offset) {
        display[at] = { text: "", runs: [] };
        continue;
      }
      const from = start.offset - first;
      const to =
        end.offset -
        first +
        (focused &&
        at === active &&
        end === last &&
        end.column < left + room &&
        end.offset === caret.offset
          ? 1
          : 0);
      display[at] = { text: one.text.slice(from, to), runs: slicedRuns(one.runs, from, to) };
    }
  }
  return Ok({ caret, rows, display, active });
}
