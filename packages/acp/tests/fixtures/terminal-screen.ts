/**
 * What a cursor-addressed terminal is showing, reconstructed from its bytes.
 *
 * A TUI does not append its output. It moves the cursor, erases, and draws over
 * what it drew before, so the byte stream a pty emitted and the screen an
 * operator is looking at are two different things. Searching the stream answers
 * the wrong question twice over: it finds text that has since been erased, text
 * the program printed before it took the screen, and text no repaint left
 * standing — while missing an answer whose only surviving form is the cells it
 * was last drawn into.
 *
 * So the bytes are applied to a screen here, and the screen is what gets read.
 * Nothing in this module is Codex-specific: it is a terminal, and the questions
 * asked of it are supplied by the caller.
 */

import { withResolvers } from "effection";
import type { Operation } from "effection";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);
const BLANK = " ";

/**
 * Where one piece of text stops, marked in a row before the row is cut up.
 *
 * A noncharacter, so no terminal output can supply one and be mistaken for a
 * cut this module made.
 */
const BOUNDARY = String.fromCharCode(0xffff);

/**
 * The glyphs a TUI draws its frame out of — box drawing and block elements.
 *
 * A pane border can land between two words of a wrapped sentence, so these have
 * to come out before the words either side of one can be read as adjacent. No
 * model emits them mid-sentence, so removing them recovers the text without
 * letting anything else through.
 */
const FRAME_GLYPH = /[─-▟]/gu;

/** Collapse every run of whitespace, so a TUI's own layout cannot hide a word. */
function squeeze(text: string): string {
  return text.replaceAll(/\s+/gu, "");
}

export interface ScreenSize {
  readonly rows: number;
  readonly columns: number;
}

export interface ScreenSnapshot {
  /** Whether the alternate buffer is showing, which is a full-screen TUI's. */
  readonly alternate: boolean;
  /** The visible rows of whichever buffer is showing, trailing blanks removed. */
  readonly rows: readonly string[];
}

function blankRow(columns: number): string[] {
  return new Array<string>(columns).fill(BLANK);
}

function blankCells(size: ScreenSize): string[][] {
  return Array.from({ length: size.rows }, () => blankRow(size.columns));
}

export class TerminalScreen {
  readonly #rows: number;
  readonly #columns: number;
  readonly #decoder = new TextDecoder();
  #primary: string[][];
  #alternate: string[][];
  #onAlternate = false;
  #row = 0;
  #column = 0;
  /**
   * Whether the last glyph filled the final column.
   *
   * A terminal does not move to the next row when the last column is written;
   * it waits to see whether another glyph arrives. Without that delay a
   * sentence ending exactly at the right margin drags a blank row after it, and
   * a cursor move that follows one lands a row too low.
   */
  #wrapPending = false;
  #savedRow = 0;
  #savedColumn = 0;
  #top = 0;
  #bottom: number;
  /** An escape sequence split across two reads, held until the rest arrives. */
  #partial = "";
  /**
   * What was on show when the program asked for its drawing to be held back.
   *
   * `CSI ?2026h` tells the terminal to stop presenting until `CSI ?2026l`, so a
   * program can erase and redraw a region without the reader ever seeing the
   * half-drawn state. Codex asks for this, which means the rows in between are
   * cells this screen holds and a terminal never showed anybody — while this
   * stays what it showed last, so a reader has something true to read.
   *
   * Taken where the hold begins rather than at the end of the read carrying it:
   * bytes before that point were presented, and bytes after it were not.
   */
  #held: ScreenSnapshot | undefined;
  readonly #onFrame: (() => void) | undefined;

  /**
   * @param onFrame Called each time a synchronized update commits, at the point
   * in the byte stream where it commits rather than at the end of the read that
   * carried it — a frame is finished by `CSI ?2026l` and not by an operating
   * system deciding where one `data` event stops.
   */
  constructor(size: ScreenSize, onFrame?: () => void) {
    this.#rows = size.rows;
    this.#columns = size.columns;
    this.#primary = blankCells(size);
    this.#alternate = blankCells(size);
    this.#bottom = size.rows - 1;
    this.#onFrame = onFrame;
  }

  /** Whether a frame is part-drawn, so what the cells hold is not on show. */
  get synchronized(): boolean {
    return this.#held !== undefined;
  }

  /** Apply one read from the terminal. Byte chunks may split any sequence. */
  write(chunk: string | Uint8Array): void {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    this.#consume(`${this.#partial}${text}`);
  }

  /** The cells as they stand, whether or not a terminal has shown them. */
  snapshot(): ScreenSnapshot {
    return {
      alternate: this.#onAlternate,
      rows: this.#cells().map((row) => row.join("").replace(/\s+$/u, "")),
    };
  }

  /**
   * What a terminal last put on show, which is the only thing anybody read.
   *
   * The same as {@link snapshot} except while a frame is being held back, when
   * it stays the frame before it until `CSI ?2026l` commits the new one. Any
   * question about what was on the screen — what it answered, and what it was
   * showing when it did not — has to be asked of this.
   */
  presented(): ScreenSnapshot {
    return this.#held ?? this.snapshot();
  }

  #cells(): string[][] {
    return this.#onAlternate ? this.#alternate : this.#primary;
  }

  #consume(input: string): void {
    this.#partial = "";
    let index = 0;
    while (index < input.length) {
      const char = input[index] ?? "";
      if (char !== ESC) {
        this.#put(char);
        index += 1;
        continue;
      }
      const next = this.#escape(input, index);
      if (next === undefined) {
        this.#partial = input.slice(index);
        return;
      }
      index = next;
    }
  }

  /** Consume one escape sequence, or report that it has not all arrived. */
  #escape(input: string, start: number): number | undefined {
    const kind = input[start + 1];
    if (kind === undefined) {
      return undefined;
    }
    if (kind === "[") {
      return this.#csi(input, start);
    }
    if (kind === "]" || kind === "P" || kind === "^" || kind === "_") {
      return this.#stringSequence(input, start);
    }
    if (kind === "(" || kind === ")" || kind === "*" || kind === "+") {
      return input[start + 2] === undefined ? undefined : start + 3;
    }
    if (kind === "7") {
      this.#save();
    } else if (kind === "8") {
      this.#restore();
    } else if (kind === "M") {
      this.#reverseIndex();
    } else if (kind === "D") {
      this.#index();
    } else if (kind === "E") {
      this.#index();
      this.#column = 0;
    } else if (kind === "c") {
      this.#reset();
    }
    return start + 2;
  }

  #csi(input: string, start: number): number | undefined {
    let index = start + 2;
    while (index < input.length && /[0-9;:?<>=!]/u.test(input[index] ?? "")) {
      index += 1;
    }
    while (index < input.length && /[ -/]/u.test(input[index] ?? "")) {
      index += 1;
    }
    const final = input[index];
    if (final === undefined) {
      return undefined;
    }
    this.#dispatch(input.slice(start + 2, index), final);
    return index + 1;
  }

  /** OSC, DCS, APC and PM all run to a BEL or a string terminator. */
  #stringSequence(input: string, start: number): number | undefined {
    let index = start + 2;
    while (index < input.length) {
      const char = input[index];
      if (char === BEL) {
        return index + 1;
      }
      if (char === ESC) {
        const after = input[index + 1];
        if (after === undefined) {
          return undefined;
        }
        if (after === "\\") {
          return index + 2;
        }
      }
      index += 1;
    }
    return undefined;
  }

  #dispatch(body: string, final: string): void {
    const priv = body.startsWith("?");
    const params = (priv ? body.slice(1) : body).split(";").map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isNaN(value) ? 0 : value;
    });
    if (priv) {
      if (final === "h" || final === "l") {
        this.#mode(params, final === "h");
      }
      return;
    }
    /** A parameter a terminal reads as "how many", where zero means one. */
    const count = (position: number, fallback: number): number => {
      const value = params[position];
      return value === undefined || value === 0 ? fallback : value;
    };
    /** A parameter a terminal reads as "which", where zero is a real choice. */
    const choice = params[0] ?? 0;
    switch (final) {
      case "A":
        this.#moveTo(this.#row - count(0, 1), this.#column);
        break;
      case "B":
        this.#moveTo(this.#row + count(0, 1), this.#column);
        break;
      case "C":
        this.#moveTo(this.#row, this.#column + count(0, 1));
        break;
      case "D":
        this.#moveTo(this.#row, this.#column - count(0, 1));
        break;
      case "E":
        this.#moveTo(this.#row + count(0, 1), 0);
        break;
      case "F":
        this.#moveTo(this.#row - count(0, 1), 0);
        break;
      case "G":
      case "`":
        this.#moveTo(this.#row, count(0, 1) - 1);
        break;
      case "d":
        this.#moveTo(count(0, 1) - 1, this.#column);
        break;
      case "H":
      case "f":
        this.#moveTo(count(0, 1) - 1, count(1, 1) - 1);
        break;
      case "J":
        this.#eraseDisplay(choice);
        break;
      case "K":
        this.#eraseLine(choice);
        break;
      case "L":
        this.#insertLines(count(0, 1));
        break;
      case "M":
        this.#deleteLines(count(0, 1));
        break;
      case "@":
        this.#insertChars(count(0, 1));
        break;
      case "P":
        this.#deleteChars(count(0, 1));
        break;
      case "X":
        this.#eraseChars(count(0, 1));
        break;
      case "S":
        this.#scrollUp(count(0, 1));
        break;
      case "T":
        this.#scrollDown(count(0, 1));
        break;
      case "r":
        this.#margins(count(0, 1) - 1, count(1, this.#rows) - 1);
        break;
      case "s":
        this.#save();
        break;
      case "u":
        this.#restore();
        break;
      default:
        // Colour, weight, cursor visibility, bracketed paste: no cell changes.
        break;
    }
  }

  #mode(params: readonly number[], set: boolean): void {
    for (const value of params) {
      if (value === 2026) {
        if (set) {
          // A hold inside a hold is still the same hold: what was on show is
          // what was on show when the drawing first stopped.
          this.#held ??= this.snapshot();
          continue;
        }
        this.#held = undefined;
        this.#onFrame?.();
        continue;
      }
      if (value !== 1049 && value !== 47 && value !== 1047) {
        continue;
      }
      // 1049 hands a TUI a screen with nothing of the shell's on it and gives
      // the shell's cursor back on the way out. 47 and 1047 only switch.
      const owns = value === 1049;
      if (set) {
        this.#enter(owns);
      } else {
        this.#leave(owns);
      }
    }
  }

  #enter(owns: boolean): void {
    if (this.#onAlternate) {
      return;
    }
    if (owns) {
      this.#save();
    }
    this.#onAlternate = true;
    if (owns) {
      this.#alternate = blankCells({ rows: this.#rows, columns: this.#columns });
      this.#moveTo(0, 0);
    }
  }

  #leave(owns: boolean): void {
    if (!this.#onAlternate) {
      return;
    }
    this.#onAlternate = false;
    if (owns) {
      this.#restore();
    }
  }

  #put(char: string): void {
    if (char === "\n") {
      this.#index();
      return;
    }
    if (char === "\r") {
      this.#column = 0;
      this.#wrapPending = false;
      return;
    }
    if (char === "\b") {
      this.#moveTo(this.#row, this.#column - 1);
      return;
    }
    if (char === "\t") {
      this.#moveTo(this.#row, (Math.floor(this.#column / 8) + 1) * 8);
      return;
    }
    if (char < BLANK || char === DEL) {
      return;
    }
    if (this.#wrapPending) {
      this.#index();
      this.#column = 0;
      this.#wrapPending = false;
    }
    const row = this.#cells()[this.#row];
    if (row === undefined) {
      return;
    }
    row[this.#column] = char;
    if (this.#column + 1 >= this.#columns) {
      this.#wrapPending = true;
      return;
    }
    this.#column += 1;
  }

  #index(): void {
    this.#wrapPending = false;
    if (this.#row === this.#bottom) {
      this.#scrollUp(1);
      return;
    }
    if (this.#row < this.#rows - 1) {
      this.#row += 1;
    }
  }

  #reverseIndex(): void {
    this.#wrapPending = false;
    if (this.#row === this.#top) {
      this.#scrollDown(1);
      return;
    }
    if (this.#row > 0) {
      this.#row -= 1;
    }
  }

  #scrollUp(lines: number): void {
    const cells = this.#cells();
    for (let step = 0; step < lines; step += 1) {
      cells.splice(this.#top, 1);
      cells.splice(this.#bottom, 0, blankRow(this.#columns));
    }
  }

  #scrollDown(lines: number): void {
    const cells = this.#cells();
    for (let step = 0; step < lines; step += 1) {
      cells.splice(this.#bottom, 1);
      cells.splice(this.#top, 0, blankRow(this.#columns));
    }
  }

  #insertLines(lines: number): void {
    if (this.#row < this.#top || this.#row > this.#bottom) {
      return;
    }
    const cells = this.#cells();
    for (let step = 0; step < lines; step += 1) {
      cells.splice(this.#bottom, 1);
      cells.splice(this.#row, 0, blankRow(this.#columns));
    }
    this.#column = 0;
    this.#wrapPending = false;
  }

  #deleteLines(lines: number): void {
    if (this.#row < this.#top || this.#row > this.#bottom) {
      return;
    }
    const cells = this.#cells();
    for (let step = 0; step < lines; step += 1) {
      cells.splice(this.#row, 1);
      cells.splice(this.#bottom, 0, blankRow(this.#columns));
    }
    this.#column = 0;
    this.#wrapPending = false;
  }

  #insertChars(chars: number): void {
    const row = this.#cells()[this.#row];
    if (row === undefined) {
      return;
    }
    for (let step = 0; step < chars; step += 1) {
      row.splice(this.#column, 0, BLANK);
      row.length = this.#columns;
    }
  }

  #deleteChars(chars: number): void {
    const row = this.#cells()[this.#row];
    if (row === undefined) {
      return;
    }
    for (let step = 0; step < chars; step += 1) {
      row.splice(this.#column, 1);
      row.push(BLANK);
    }
  }

  #eraseChars(chars: number): void {
    const row = this.#cells()[this.#row];
    if (row === undefined) {
      return;
    }
    const end = Math.min(this.#columns, this.#column + chars);
    for (let column = this.#column; column < end; column += 1) {
      row[column] = BLANK;
    }
  }

  #eraseDisplay(choice: number): void {
    const cells = this.#cells();
    this.#wrapPending = false;
    if (choice === 0) {
      this.#eraseLine(0);
      for (let row = this.#row + 1; row < this.#rows; row += 1) {
        cells[row] = blankRow(this.#columns);
      }
      return;
    }
    if (choice === 1) {
      this.#eraseLine(1);
      for (let row = 0; row < this.#row; row += 1) {
        cells[row] = blankRow(this.#columns);
      }
      return;
    }
    if (choice !== 2) {
      // `3J` clears scrollback, which this screen does not keep, and anything
      // else is a mode this terminal does not implement. Neither may fall
      // through to a whole-screen erase: a proof that blanked the visible rows
      // on an unrecognized parameter would report the answer it was looking at
      // as absent.
      return;
    }
    for (let row = 0; row < this.#rows; row += 1) {
      cells[row] = blankRow(this.#columns);
    }
  }

  #eraseLine(choice: number): void {
    const row = this.#cells()[this.#row];
    if (row === undefined) {
      return;
    }
    this.#wrapPending = false;
    const from = choice === 0 ? this.#column : 0;
    const to = choice === 1 ? this.#column + 1 : this.#columns;
    for (let column = from; column < Math.min(to, this.#columns); column += 1) {
      row[column] = BLANK;
    }
  }

  #margins(top: number, bottom: number): void {
    const first = Math.max(0, Math.min(top, this.#rows - 1));
    const last = Math.max(first, Math.min(bottom, this.#rows - 1));
    this.#top = first;
    this.#bottom = last;
    this.#moveTo(0, 0);
  }

  #moveTo(row: number, column: number): void {
    this.#row = Math.max(0, Math.min(row, this.#rows - 1));
    this.#column = Math.max(0, Math.min(column, this.#columns - 1));
    this.#wrapPending = false;
  }

  #save(): void {
    this.#savedRow = this.#row;
    this.#savedColumn = this.#column;
  }

  #restore(): void {
    this.#moveTo(this.#savedRow, this.#savedColumn);
  }

  #reset(): void {
    this.#primary = blankCells({ rows: this.#rows, columns: this.#columns });
    this.#alternate = blankCells({ rows: this.#rows, columns: this.#columns });
    this.#onAlternate = false;
    this.#top = 0;
    this.#bottom = this.#rows - 1;
    // A terminal reset ends any frame that was being withheld. Leaving it held
    // would suspend observation for the rest of the run, and go on reporting a
    // screen this reset has just blanked.
    this.#held = undefined;
    this.#moveTo(0, 0);
  }
}

/**
 * The screen's text, cut where the layout says one piece of text ends.
 *
 * Rows are joined rather than kept apart, because a wrapped sentence continues
 * from the end of one row into the start of the next — with no space where the
 * terminal wrapped it mid-word, and one where the program wrapped it between
 * words. Joining and then squeezing reads both.
 *
 * A run ends at anything that says the text does not continue: a blank row, a
 * row of the program's own furniture, a pane border, or a gap of two or more
 * cells inside a row. That last cut is what keeps erasure honest — cells an
 * erase blanked in the middle of a sentence would otherwise close up and let
 * the words either side of the hole read as one.
 */
export function runsOf(rows: readonly string[], chrome: readonly string[]): string[] {
  const furniture = chrome.map(squeeze).filter((marker) => marker.length > 0);
  const runs: string[] = [];
  let open = "";
  const flush = (): void => {
    if (open.length > 0) {
      runs.push(open);
    }
    open = "";
  };
  for (const row of rows) {
    const framed = row.replaceAll(FRAME_GLYPH, BOUNDARY);
    const bare = squeeze(framed.replaceAll(BOUNDARY, ""));
    if (bare.length === 0 || furniture.some((marker) => bare.includes(marker))) {
      flush();
      continue;
    }
    const segments = framed
      .split(BOUNDARY)
      .flatMap((pane) => pane.trim().split(/ {2,}/u))
      .filter((segment) => segment.length > 0);
    const [first, ...rest] = segments;
    if (first === undefined) {
      flush();
      continue;
    }
    open += first;
    for (const segment of rest) {
      flush();
      open = segment;
    }
  }
  flush();
  return runs;
}

export interface AnswerQuestion {
  /** The exact text an answer has to show. */
  readonly expected: string;
  /**
   * What this harness typed.
   *
   * A TUI shows the turn it was given as well as the reply, so the screen
   * carries this harness's own words back. Reading the expectation out of them
   * would let a question that quoted its answer satisfy itself.
   */
  readonly typed: string;
  /** Markers naming the program's own furniture rather than anything it said. */
  readonly chrome: readonly string[];
}

/**
 * Why the screen was or was not read as carrying the answer.
 *
 * `only-typed` is kept apart from `absent` because they are different facts: one
 * says the words are on screen but every copy of them is this harness's own, and
 * the other says they are not there at all.
 */
export type AnswerReason = "answer" | "absent" | "only-typed";

export interface AnswerObservation {
  readonly found: boolean;
  readonly reason: AnswerReason;
}

function rangesOf(text: string, needle: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    spans.push({ start: index, end: index + needle.length });
    index = text.indexOf(needle, index + 1);
  }
  return spans;
}

/** Whether the screen is showing `question.expected` as something it said. */
export function observeAnswer(
  snapshot: ScreenSnapshot,
  question: AnswerQuestion,
): AnswerObservation {
  const wanted = squeeze(question.expected);
  if (wanted.length === 0) {
    return { found: false, reason: "absent" };
  }
  const echoed = squeeze(question.typed);
  let masked = false;
  for (const run of runsOf(snapshot.rows, question.chrome)) {
    const text = squeeze(run);
    // Where this harness's own turn is showing, so a copy of the expectation
    // that lies inside one is read as the echo it is. Scoped to the occurrence
    // rather than the run, because a run that carries the echo can carry the
    // reply after it, and a reply that happens to be a fragment of the question
    // is still a reply.
    const spans = echoed.length === 0 ? [] : rangesOf(text, echoed);
    let index = text.indexOf(wanted);
    while (index !== -1) {
      const inside = spans.some((span) => index >= span.start && index + wanted.length <= span.end);
      if (!inside) {
        return { found: true, reason: "answer" };
      }
      masked = true;
      index = text.indexOf(wanted, index + 1);
    }
  }
  return { found: false, reason: masked ? "only-typed" : "absent" };
}

/**
 * Whether the screen — furniture included — is showing `marker`.
 *
 * Deliberately unlike {@link observeAnswer}: this is how the terminal's state is
 * described after a wait gave up, and furniture is exactly what that describes.
 */
export function screenShows(snapshot: ScreenSnapshot, marker: string): boolean {
  const text = snapshot.rows.join("\n").replaceAll(FRAME_GLYPH, "");
  return squeeze(text).includes(squeeze(marker));
}

/**
 * The terminal one invocation drew, across the reads that built it.
 *
 * The one stateful thing the live proof and the offline streams both drive, so
 * what the offline cases decide is what the pty path does — the alternative is
 * two readers that agree until the day they do not.
 *
 * Every invocation gets one, because every invocation decides what surface it
 * is looking at and a surface is a fact about the screen: the byte stream
 * retains a composer drawn before a dialog covered it, and text an erase wiped
 * out. Only an invocation that submits a turn also *watches* — see
 * {@link watching} — because latching an answer is a claim about a reply to a
 * turn, and a run that spoke none has no reply to attribute.
 *
 * The latch latches. Once the answer has been on the screen it stays observed,
 * because the question is whether the agent answered and a TUI is entitled to
 * repaint over its own reply the moment it finishes. Nothing un-answers a turn.
 *
 * Nothing is latched until {@link ask}, which is the point in a run where the
 * turn has been submitted. Reads before then still build the screen — an answer
 * arrives on a terminal the whole session drew — but they cannot latch, so text
 * from before the turn is not a reply to it.
 *
 * Nothing is read out of a part-drawn frame either. A program that holds its
 * drawing back with `CSI ?2026h` is saying the cells in between were never
 * presented, and a reader of those would decide on a frame no terminal
 * displayed and no operator could have seen.
 */
export class TerminalReader {
  readonly #screen: TerminalScreen;
  readonly #watching: boolean;
  readonly #watches = new Set<Watch>();
  #question: AnswerQuestion | undefined;
  #found = false;

  constructor(size: ScreenSize, watching: boolean) {
    this.#watching = watching;
    // Committed frames are collected where they commit, so what a wait is
    // answered with does not depend on where the operating system happened to
    // cut a read.
    this.#screen = new TerminalScreen(size, () => {
      this.#look();
      this.#collect();
    });
  }

  /** Whether this invocation may latch an answer at all. */
  get watching(): boolean {
    return this.#watching;
  }

  /** Feed one read, and say whether the answer has been observed. */
  write(chunk: string | Uint8Array): boolean {
    this.#screen.write(chunk);
    // The screen this read ended on, which the commits inside it did not offer.
    // A read need not end on a commit at all — a frame drawn with no
    // synchronization is finished by the bytes stopping and by nothing else.
    this.#collect();
    // Waits are woken here rather than at the commit that first satisfied them,
    // so what one is answered with is every frame the read presented and not
    // merely the frames up to the first match. Nothing can be acted on before a
    // read has been applied in any case, and waking part of the way through one
    // is what would let a refusal drawn behind an earlier match go unseen.
    this.#wake();
    return this.#settled();
  }

  /**
   * Watch presented frames for `predicate`, and keep every one that satisfies it.
   *
   * Kept, because what a terminal presented is not undone by what it presents
   * next. One read from a pty can finish several frames, and a caller told only
   * *that* a surface arrived would have to look at the screen again to find out
   * which — by which time the frame it is being asked about may be two repaints
   * old. Codex commits its refusal and draws a composer over it inside a single
   * read, so that gap is where a refusal goes missing.
   *
   * Every one, and not just the first, because the first is not always the one
   * that matters. A predicate wide enough to catch what a caller is watching for
   * is wide enough to be satisfied by something ordinary ahead of it in the same
   * read: Codex reloads a model, refuses the identity and repaints its composer
   * in that order and in one read, and a watch that closed at the reload would
   * report a reload and lose the refusal entirely.
   *
   * Answered against what is already on show before anything else, since a frame
   * that satisfies this may have committed before a caller thought to ask. No
   * read follows in that case, so nothing further is collected and `notify` is
   * never called: the caller is still here, and has the frame in its hand.
   */
  watch(predicate: (snapshot: ScreenSnapshot) => boolean, notify: () => void): PresentedWatch {
    const entry: Watch = { test: predicate, notify, matches: [] };
    const handle: PresentedWatch = {
      get matches(): readonly ScreenSnapshot[] {
        return entry.matches;
      },
      close: () => {
        this.#watches.delete(entry);
      },
    };
    const presented = this.#screen.presented();
    if (predicate(presented)) {
      entry.matches.push(presented);
      return handle;
    }
    this.#watches.add(entry);
    return handle;
  }

  /**
   * Watch for this answer from now on, against what is already showing.
   *
   * Answered immediately as well as latched, because the reply can be complete
   * before a caller gets here and no further read need arrive.
   *
   * Refused outright on a reader that is not watching. Such a reader belongs to
   * an invocation that submitted no turn, so an answer it reported would be a
   * reply attributed to a turn nobody spent.
   */
  ask(question: AnswerQuestion): boolean {
    if (!this.#watching) {
      throw new Error("this invocation submits no turn and cannot watch for an answer");
    }
    this.#question = question;
    return this.#settled();
  }

  /** Whether the answer has been observed at any point since {@link ask}. */
  get found(): boolean {
    return this.#found;
  }

  /**
   * What the terminal has put on show — furniture included.
   *
   * Never a frame it is still drawing. A caller that reaches here after a bound
   * expired is asking what the operator would have been looking at, and cells
   * held back for a repaint are not that: reporting them would name a surface
   * as the reason no answer arrived when nobody was ever shown it.
   */
  snapshot(): ScreenSnapshot {
    return this.#screen.presented();
  }

  /** Look, unless a frame is part-drawn — then the last commit still stands. */
  #settled(): boolean {
    if (this.#screen.synchronized) {
      return this.#found;
    }
    return this.#look();
  }

  #look(): boolean {
    if (this.#found || this.#question === undefined) {
      return this.#found;
    }
    this.#found = observeAnswer(this.#screen.snapshot(), this.#question).found;
    return this.#found;
  }

  /** Offer the frame now on show to every open watch, keeping what satisfies. */
  #collect(): void {
    if (this.#watches.size === 0) {
      return;
    }
    const presented = this.#screen.presented();
    for (const entry of this.#watches) {
      // A read ending on a commit reaches here twice with the same frame — once
      // where it committed and once as the screen the read ended on — and that
      // is one thing the terminal presented rather than two.
      if (sameCells(entry.matches[entry.matches.length - 1], presented)) {
        continue;
      }
      if (entry.test(presented)) {
        entry.matches.push(presented);
      }
    }
  }

  /** Wake every watch this read answered, and stop collecting for it. */
  #wake(): void {
    for (const entry of this.#watches) {
      if (entry.matches.length === 0) {
        continue;
      }
      this.#watches.delete(entry);
      entry.notify();
    }
  }
}

/** Whether these are the same cells, so one presentation rather than two. */
function sameCells(one: ScreenSnapshot | undefined, two: ScreenSnapshot): boolean {
  return (
    one !== undefined &&
    one.alternate === two.alternate &&
    one.rows.length === two.rows.length &&
    one.rows.every((row, index) => row === two.rows[index])
  );
}

interface Watch {
  readonly test: (snapshot: ScreenSnapshot) => boolean;
  readonly notify: () => void;
  readonly matches: ScreenSnapshot[];
}

/** A standing question about the presented screen, answered by one read. */
export interface PresentedWatch {
  /** The frames that satisfied the predicate, in the order they were presented. */
  readonly matches: readonly ScreenSnapshot[];
  /** Stop watching. Whatever was matched is kept. */
  close(): void;
}

/** How a wait learns that a read has answered it. */
export interface PresentedWait {
  /** Settles once a read has presented a frame satisfying the predicate. */
  readonly matched: Operation<void>;
  /** Whether one already has. */
  settled(): boolean;
}

/**
 * Wait for a read presenting `predicate`, and answer with every frame that did.
 *
 * The frames themselves, and never the screen as it stands when the wait
 * returns. Those are routinely different things: one read from a pty commits
 * however many frames its bytes finished, so a surface can be presented and
 * painted over without a single byte arriving in between for anybody to be woken
 * by.
 *
 * All of them, in the order they were presented, because a caller asking a
 * question broad enough to catch what it is watching for gets ordinary frames
 * answering it too — and which of them decides is the caller's to say, not
 * whichever happened to come first.
 *
 * Empty where the bound was spent, because a surface that never arrived is
 * something to report rather than an error.
 *
 * `read` owns everything about waiting that is not about the screen — how long,
 * and what else may end it — so the live pty and the offline scripts differ only
 * in that, and what decides is this.
 */
export function* waitForPresented(
  reader: TerminalReader,
  predicate: (snapshot: ScreenSnapshot) => boolean,
  read: (wait: PresentedWait) => Operation<void>,
): Operation<readonly ScreenSnapshot[]> {
  const waiter = withResolvers<void>();
  const watch = reader.watch(predicate, waiter.resolve);
  try {
    if (watch.matches.length === 0) {
      yield* read({
        matched: waiter.operation,
        settled: () => watch.matches.length !== 0,
      });
    }
  } finally {
    watch.close();
  }
  return watch.matches;
}

/**
 * Wait out a fixed delay, and answer with every frame presented during it.
 *
 * A pause is a window like any other. Nothing shortens it and nothing is being
 * waited for, but the terminal goes on drawing for its whole duration all the
 * same — so a settle or a grace that only sleeps is a window in which something
 * can be shown and taken back, and a caller reading the screen afterwards is
 * asking what survived rather than what happened. Between those two questions
 * sits every refusal Codex presented and repainted over while a driver was
 * deliberately not looking.
 *
 * Held frames stay invisible here as everywhere else: a watch is offered frames
 * at their commit, and what a terminal never put on show was never presented.
 *
 * `delay` owns the waiting entirely, so a pause cancelled or timed out partway
 * keeps whatever it had collected by then and closes its watch with the scope
 * that owned it.
 */
export function* presentedDuring(
  reader: TerminalReader,
  predicate: (snapshot: ScreenSnapshot) => boolean,
  delay: Operation<void>,
): Operation<readonly ScreenSnapshot[]> {
  // Nothing to notify: a pause runs for as long as it was asked to, and a frame
  // arriving early is collected rather than acted on.
  const watch = reader.watch(predicate, () => {});
  try {
    yield* delay;
  } finally {
    watch.close();
  }
  return watch.matches;
}

/** What one invocation of the product does, as far as observation goes. */
export interface ObservedInvocation {
  /** Which invocation of its journey this is. Only the first submits a turn. */
  readonly index: number;
  /** What it types into the composer, if it types anything. */
  readonly say?: string;
  /** What proves the answer to that arrived, if an answer is expected. */
  readonly expect?: string;
}

/**
 * The reader an invocation gets, which is always one — watching only if the
 * invocation submits a turn and expects an answer to it.
 *
 * The submitting invocation is a journey's first, so a later one carrying an
 * expectation is a mistake rather than a second thing to watch; saying so here
 * keeps that out of reach of an edit to any single call site.
 */
export function terminalReader(size: ScreenSize, invocation: ObservedInvocation): TerminalReader {
  const { index, say, expect } = invocation;
  const watching = index === 0 && say !== undefined && expect !== undefined && expect.length > 0;
  return new TerminalReader(size, watching);
}

/**
 * Where each thing a pty says may be read.
 *
 * `script` puts the emulated terminal on stdout. Its stderr is this harness's
 * own out-of-band channel — the shell's complaints, `script`'s own diagnostics —
 * which never went through the terminal and so is not part of what was
 * displayed. Both are kept as stream evidence; only one may reach the screen.
 */
export interface TerminalChannels {
  /** Whether an answer is being watched for at all. */
  readonly observing: boolean;
  /** Bytes the emulated terminal presented. Says whether that answered. */
  display(chunk: string | Uint8Array): boolean;
  /** Bytes that reached this process beside the terminal. Answers nothing. */
  diagnostic(chunk: string | Uint8Array): void;
}

export function terminalChannels(
  record: (chunk: string | Uint8Array) => void,
  reader: TerminalReader,
): TerminalChannels {
  return {
    observing: reader.watching,
    display(chunk) {
      record(chunk);
      return reader.write(chunk);
    },
    diagnostic(chunk) {
      record(chunk);
    },
  };
}
