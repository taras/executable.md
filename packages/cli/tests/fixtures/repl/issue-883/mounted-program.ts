/**
 * Text and geometry heuristics over the mounted REPL's screen.
 *
 * Each helper here finds a control, a pane or a focused field by reading
 * labels, prompt columns, borders or focus glyphs. The harness and doubles
 * they read are `support/mounted-repl.ts`; these readers are retired in favour
 * of `support/mounted-page.ts`, which reads the frame's own control keys and
 * region bounds.
 */

import { race, sleep } from "effection";
import type { Operation } from "effection";

import type { ReplTerminalSize } from "../../../../src/repl/terminal.ts";
import { drawerRect, FOOTER_ROWS } from "../../../../src/repl/layout.ts";
import { COMPACT_HISTORY_TITLE } from "../../../../src/repl/application.ts";
import { readScreen, usedRows } from "../../../support/terminal-screen.ts";
import {
  MOUNTED_DEADLINE_MS,
  useMountedRepl as startMountedRepl,
} from "../../../support/mounted-repl.ts";
import type { MountedRepl, Terminal } from "../../../support/mounted-repl.ts";

export {
  appendGate,
  awaited,
  awaitedFact,
  MOUNTED_AGENT,
  MOUNTED_DEADLINE_MS,
  mountedExecution,
  mountedReading,
  OTHER_MOUNTED_AGENT,
  operationGate,
  recordingTerminal,
  useMountedHost,
} from "../../../support/mounted-repl.ts";
export type {
  AppendGate,
  HeldAppend,
  HeldOperation,
  MountedHost,
  MountedRepl,
  OperationGate,
  Terminal,
} from "../../../support/mounted-repl.ts";

/** The mounted command, once its first usable screen is drawn. */
export function* useMountedRepl(
  options: Parameters<typeof startMountedRepl>[0] = {},
): Operation<MountedRepl> {
  const repl = yield* startMountedRepl(options);
  yield* untilDrawn(repl.terminal);
  return repl;
}

/** The draft row's own prompt, which is how its row is told from the other one. */
export const DRAFT_PROMPT = " DRAFT";

/** The Sidekick's message box, by the prompt that names which destination it is. */
export const MESSAGE_PROMPT = " › message the sidekick";

/**
 * The contextual status row: what the execution is doing, and what Enter does.
 *
 * Described only once a width has been measured, so its presence is also what
 * says this frame is a measured one rather than the first thing drawn.
 */
export function statusOn(terminal: Terminal): string | undefined {
  return screenOf(terminal).find((line) => line.includes(" \u00b7 "));
}

/**
 * The canvas a finished run of presentations is read on, when nobody says what
 * size the terminal was.
 *
 * The largest any mounted case draws at, so a frame of any of them lands on it
 * whole and is read from its top-left corner.
 */
const CANVAS: ReplTerminalSize = { columns: 200, rows: 140 };

/**
 * What a run of presentations leaves on a fresh screen.
 *
 * For a reading of one stretch of frames on its own — the frames from a resize
 * onward are a whole screen, because the engine redraws completely after a
 * size change. The rows end at the last one anything was written on.
 */
export function replay(written: readonly Uint8Array[]): string[] {
  return readScreen(CANVAS, written, (screen) => usedRows(screen.rows()));
}

/** The draft row as the screen draws it, or none before a frame has drawn one. */
export function maybeDraftRow(terminal: Terminal): string | undefined {
  return screenOf(terminal).find((line) => line.includes(DRAFT_PROMPT));
}

/** The draft row, or a failure saying what the screen was showing instead. */
export function draftRow(terminal: Terminal): string {
  const row = maybeDraftRow(terminal);
  if (row === undefined) {
    throw new Error(
      "the screen draws its draft row. rows=" +
        JSON.stringify(screenOf(terminal).map((line) => line.trimEnd())),
    );
  }
  return row;
}

/**
 * Whether a frame a person could actually use has been drawn.
 *
 * Not merely that bytes arrived: a reset and an empty presentation are both
 * frames, and neither is a screen. The draft row and a way out are the two things
 * every drawable frame of this product has, so their presence is what says the
 * command is up and showing something.
 */
export function usable(terminal: Terminal): boolean {
  const rows = screenOf(terminal);
  return (
    statusOn(terminal) !== undefined &&
    rows.some((line) => line.includes(DRAFT_PROMPT)) &&
    rows.some((line) => line.includes("[exit]") || line.includes("[history]"))
  );
}

/** Let every task that is ready take its turn. */
export function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/** What the screen shows now: every visible row, as the completed presentations left it. */
export function screenOf(terminal: Terminal): string[] {
  const screen = terminal.screen;
  if (screen === undefined) {
    throw new Error("this terminal has no screen until it is installed");
  }
  return screen.rows();
}

/** Whether any row of the screen contains this text. */
export function shows(terminal: Terminal, expected: string): boolean {
  return screenOf(terminal).some((line) => line.includes(expected));
}

/**
 * How the staged chat says who said a row: a mark, and then the words.
 *
 * The pane attributes every utterance — it has to, because a person's messages,
 * the Sidekick's replies, an attached client's and the REPL's own work all
 * share one list. It spells that attribution as a mark rather than as a name
 * prefix, and the mark is accompanied by the colour rather than replaced by it,
 * so a reader is told twice. These two are the ones a journey asserts against:
 * what a person at this screen said, and what the Sidekick answered.
 */
const SAID_BY_PERSON = "[U] ";
const SAID_BY_SIDEKICK = "[S] ";

/** Whether the screen shows this utterance, attributed to a person here. */
export function saidByPerson(terminal: Terminal, text: string): boolean {
  return shows(terminal, `${SAID_BY_PERSON}${text}`);
}

/** Whether the screen shows this utterance, attributed to the Sidekick. */
export function saidBySidekick(terminal: Terminal, text: string): boolean {
  return shows(terminal, `${SAID_BY_SIDEKICK}${text}`);
}

/**
 * Tab until the control this key names holds focus.
 *
 * Traversal through the ordinary normalized boundary, exactly as a person does
 * it: there is no host shortcut that jumps to a control, and the marker on the
 * focused control is how anybody — a person or this test — knows where they are.
 */
export function* focusOn(terminal: Terminal, label: string, limit = 240): Operation<void> {
  if (focusedOn(terminal, label)) {
    return;
  }
  for (let press = 0; press < limit; press += 1) {
    terminal.feed("\t");
    yield* settled(12);
    if (focusedOn(terminal, label)) {
      return;
    }
  }
  throw new Error(`focus never reached ${label} in ${limit} presses`);
}

/**
 * Put focus on the entry draft.
 *
 * There is no label to aim at: the draft is empty, and what it draws is its own
 * prompt. So the marker and the prompt together are what name it — a focused
 * field renders its marker immediately before its prompt, and the draft's
 * prompt is the only one on this screen that is itself a marker.
 */
export function* focusDraft(terminal: Terminal, limit = 240): Operation<void> {
  for (let press = 0; press <= limit; press += 1) {
    // The draft's own row, not any focused field. This screen has two input
    // destinations now — `Draft` and `Message Sidekick` — and both wear the
    // same focus marker, so a helper looking for the marker alone would stop at
    // whichever one it reached first and type a document into a chat box.
    if (screenOf(terminal).some((line) => line.includes(`>${DRAFT_PROMPT}`))) {
      return;
    }
    terminal.feed("\t");
    yield* settled(12);
  }
  throw new Error(`focus never reached the entry draft in ${limit} presses`);
}

/**
 * Whether the control holding focus is the one this label names.
 *
 * Anchored to the marker rather than matched anywhere on the line, because a
 * line of this screen crosses three columns: the sidebar, the transcript and the
 * inspection column all write to the same rows, so a label found *somewhere* on
 * a line with a marker on it is usually a different control in a different column.
 * The marker is searched for at any position for the same reason — a focused
 * control in the inspection column has the sidebar's text to the left of it.
 */
export function focusedOn(terminal: Terminal, label: string): boolean {
  for (const line of screenOf(terminal)) {
    for (let at = line.indexOf(">"); at !== -1; at = line.indexOf(">", at + 1)) {
      // Past the selection channel as well as the indent: a row can be both
      // focused and the one being read, and the two markers are independent.
      const after = line.slice(at + 1).trimStart();
      const beyond = after.startsWith("* ") ? after.slice(2) : after;
      // And past a History row's own ordinal. #881 PR 3 gives every retained
      // position its number in the full list — `12 · Entry 3 admitted` — which
      // is another prefix the product puts there, like the two above.
      const named = beyond.replace(/^\d+ \u00b7 /, "");
      // Case-folded, because the staged panes name their own tabs in capitals
      // — `BINDINGS`, `SIDEKICK`, `QUEUE` — while a caller names the thing it
      // is reaching for the way a person would say it.
      const wanted = label.toLowerCase();
      if (
        after.toLowerCase().startsWith(wanted) ||
        beyond.toLowerCase().startsWith(wanted) ||
        named.toLowerCase().startsWith(wanted)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Type this into whichever destination holds focus right now.
 *
 * One chunk, as a person's keystrokes arrive, and then a settle: what a row
 * asserts after this is what the next frame drew.
 */
export function* typing(terminal: Terminal, text: string): Operation<void> {
  terminal.feed(text);
  yield* settled(40);
}

/**
 * Put focus on the Sidekick's message box by traversal.
 *
 * Tabbing rather than activating its tab, because a row that is already looking
 * at the Sidekick and wants to type more into the box is not selecting the pane
 * again — and a second activation would make a fresh focus request, which is
 * exactly the thing several of these rows are about *not* happening.
 */
export function* focusMessage(terminal: Terminal, limit = 240): Operation<void> {
  for (let press = 0; press <= limit; press += 1) {
    if (focusedField(terminal, MESSAGE_PROMPT)) {
      return;
    }
    terminal.feed("\t");
    yield* settled(12);
  }
  throw new Error(`focus never reached the message box in ${limit} presses`);
}

/**
 * Whether the *field* this prompt names holds focus.
 *
 * Separate from `focusedOn`, and not a convenience. A field row is drawn as its
 * focus marker followed by its own prompt, and both of these prompts begin with
 * `"> "` — so ` > Draft: ` and `>> Draft: ` both contain `> Draft: `, and
 * `focusedOn` says true for either. It was written for the `row()` controls,
 * whose unfocused form carries no marker at all, and for a field it is vacuous.
 * Here the two markers are spelled out: the row's own, and the one focus adds.
 */
export function focusedField(terminal: Terminal, prompt: string): boolean {
  return screenOf(terminal).some((line) => line.includes(`>${prompt}`));
}

/**
 * Exactly what the draft is holding, after its marker and its prompt.
 *
 * What a person can read, which for several lines is the last of them under a
 * count of the rest — the field draws one row and says so.
 */
export function draftText(terminal: Terminal): string {
  return draftRowsIn(screenOf(terminal)).join("\n").trim();
}

/**
 * The rows the draft is drawn in, beneath its own name.
 *
 * The draft is a block, like the Sidekick's composer beside it: its name and
 * focus marker are one row and its value is fitted into rows of its own under
 * them. So this reads the rows after that name, up to the first control or
 * blank stretch below them.
 */
export function draftRowsIn(rows: readonly string[]): readonly string[] {
  const at = rows.findIndex((line) => line.includes(DRAFT_PROMPT));
  if (at === -1) {
    return [];
  }
  // Where this field's own content begins: the column its name starts at, one
  // past the marker in front of it.
  const from = Math.max(0, rows[at].indexOf(DRAFT_PROMPT) - 1);
  const borders = bordersBefore(rows[at], from);
  // Where the field's own allocation ends, read from the row that names it: the
  // Draft's heading shares its row with the control that acts on the draft, and
  // the field is as wide as what that control leaves. The first control on that
  // row is the Draft's own — nothing of this screen is drawn to the left of a
  // pane's own field — and the column it starts at is where the value stops.
  //
  // Without it the value rows run to whatever is beside them. A routed outlet
  // draws no divider to stop at, and a drawer in the pane alongside overwrites
  // the one a shared width draws: measured, a draft holding `mine` came back as
  // `mine                           [v later]`, which is a control of the form
  // open in the next column.
  const named = rows[at].slice(from);
  const beside = /\s\[[^\]]*\]/.exec(named);
  const allocated = beside === null ? undefined : beside.index;
  const value: string[] = [];
  for (const line of rows.slice(at + 1)) {
    // This column's own rows only, for the reason the composer's reader stops:
    // the rows below this pane run the whole width and are nobody's column. A
    // routed outlet draws no divider, so they are recognised by what they say
    // as well — a rail or a direction is not the end of somebody's draft.
    if (bordersBefore(line, from) < borders || footerRow(line)) {
      break;
    }
    // Cut at this column's own border: the draft sits in the middle column of
    // three, and a row read to the end of the screen carries the pane beside
    // it as well.
    const within = line.slice(from);
    const edge = within.indexOf("│");
    const bounded = edge === -1 ? within : within.slice(0, edge);
    const own = (allocated === undefined ? bounded : bounded.slice(0, allocated)).trimEnd();
    if (own.trim().startsWith("[")) {
      break;
    }
    value.push(own);
  }
  while (value.length > 0 && value[value.length - 1].trim() === "") {
    value.pop();
  }
  return value;
}

/**
 * The rows the Sidekick's message is drawn in, beneath its own name.
 *
 * The composer is a block: its name and focus marker are one row and its value
 * is fitted into rows of its own under them. So this reads the rows after that
 * name, up to the first control or status below them.
 *
 * What it answers is what is **visible**. A value taller than the rows this
 * screen allows is windowed to its newest, and the rest of it is in the value
 * rather than on the screen — so a row asserting a whole sent message reads
 * the retained text, not this.
 */
export function messageRows(terminal: Terminal): readonly string[] {
  return messageRowsIn(screenOf(terminal));
}

/**
 * The same, out of rows a caller already has.
 *
 * For a row holding one size's own reading: this renderer writes diffs, so a
 * caller that captured the rows of a resize reads them rather than the buffer
 * the size before it also drew into.
 */
/**
 * How many pane borders stand to the left of this column on this row.
 *
 * What makes a row part of a column rather than beside it. A block's value is
 * drawn in its own pane, and every row of that pane has the same borders in
 * front of it; a row that spans the whole screen — the History rail, the
 * guidance line — has fewer, and is not this block's row however its
 * characters happen to line up. A screen with no columns at all answers zero
 * for every row, which is what keeps a routed narrow outlet reading as it did.
 */
function bordersBefore(line: string, column: number): number {
  return line.slice(0, column).split("\u2502").length - 1;
}

/**
 * Whether this row belongs to the screen's footer rather than to any pane.
 *
 * The compact History band and the guidance below it run the whole width and
 * are nobody's column, so a block reader that walked into them would read a
 * rail or a direction as the end of somebody's draft. Recognised by what they
 * actually say — the band names itself and carries the way out — because a
 * count of rows from the bottom is the layout's business and not a reader's.
 */
function footerRow(line: string): boolean {
  return line.includes("HISTORY") || line.includes("[exit]") || line.includes("Tab/Shift+Tab");
}

export function messageRowsIn(rows: readonly string[]): readonly string[] {
  const at = rows.findIndex((line) => line.includes(MESSAGE_PROMPT));
  if (at === -1) {
    return [];
  }
  // Where this pane's own content begins. The name row is the field's marker
  // followed by its prompt — `>> ` or ` > ` — so the column three before the
  // prompt is the column every value row starts at.
  const from = Math.max(0, rows[at].indexOf(MESSAGE_PROMPT) - 3);
  const borders = bordersBefore(rows[at], from);
  const value: string[] = [];
  for (const line of rows.slice(at + 1)) {
    // This pane's own rows only. The rows below it belong to the screen rather
    // than to this column — the History rail and the guidance line run the
    // whole width — and reading one of those from this column's offset splices
    // a footer into somebody's message. A routed outlet draws no divider at
    // all, so the footer is recognised by what it says as well as by that.
    if (bordersBefore(line, from) < borders || footerRow(line)) {
      break;
    }
    // Past this column's own border, where the staged screen divides its panes.
    const within = line.slice(from).replace(/^\s*│/, "");
    const edge = within.indexOf("│");
    const own = (edge === -1 ? within : within.slice(0, edge)).trimEnd();
    const text = own.trim();
    // The composer's own rows end where this pane's controls and status begin.
    if (text.startsWith("[") || text.endsWith("is working...")) {
      break;
    }
    value.push(own);
  }
  return value;
}

/**
 * Whether a block drawn over several rows is showing this text.
 *
 * A field whose value is wider than its column is *fitted* into rows, and a
 * fitter's cut is not a character: the row break stands where a space was, and
 * the space is gone. So the screen cannot hand back the exact value once it has
 * wrapped, and comparing the rejoined rows to the text character for character
 * would be asserting where the fitter happened to break rather than what the
 * field holds. Both sides are flattened to single spaces, which is what makes
 * this a question about the words on the screen.
 *
 * For what a value *is* — byte for byte — read it where it is held: the entry
 * a draft became records its own source.
 */
export function blockSays(shown: string, expected: string): boolean {
  const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
  return flat(shown) === flat(expected);
}

/** Exactly what the Sidekick's message box is showing, as its rows show it. */
export function messageText(terminal: Terminal): string {
  return messageTextIn(screenOf(terminal));
}

/** The same, out of rows a caller already has. */
export function messageTextIn(rows: readonly string[]): string {
  return messageRowsIn(rows)
    .map((own) => own.trim())
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Whether the screen says this, across the rows a block was paid out over.
 *
 * {@link shows} asks about one row, which is the right question for a label, a
 * control or a chat message. It is the wrong question for the two blocks that
 * are fitted into as many rows as their words need — the contextual directions
 * and a refusal's own reason — because a phrase in one of those legitimately
 * straddles a cut, and whether it does is a fact about the width rather than
 * about what the screen said.
 *
 * So the rows are rejoined at their cuts and the phrase is looked for in the
 * text. Use it only for those blocks: for anything asserted to fit
 * one row, `shows` is the question.
 */
export function saysAcross(terminal: Terminal, expected: string): boolean {
  const rows = screenOf(terminal);
  const wanted = expected.replace(/\s+/g, " ");
  if (rows.some((line) => line.includes(expected))) {
    return true;
  }
  // Column by column. A divider is where one reading ends and the next begins,
  // so rejoining a block's rows means rejoining them inside their own column —
  // joining across the row would splice the pane beside it into the sentence.
  const columns = Math.max(...rows.map((line) => line.split("\u2502").length), 1);
  for (let column = 0; column < columns; column += 1) {
    const joined = rows
      .map((line) => (line.split("\u2502")[column] ?? "").trim())
      .join(" ")
      .replace(/\s+/g, " ");
    if (joined.includes(wanted)) {
      return true;
    }
  }
  return false;
}

/**
 * Wait until the first frame has been drawn.
 *
 * The command opens a terminal, a repository and a session before it can draw
 * anything, and how long that takes is not a number of turns — so every test
 * that reads the screen waits for it rather than assuming.
 */
export function* untilDrawn(terminal: Terminal): Operation<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (usable(terminal)) {
      return;
    }
    yield* sleep(10);
    yield* settled(10);
  }
  throw new Error(
    `the screen never drew its first frame. frames=${terminal.presented.length} rows=` +
      JSON.stringify(
        screenOf(terminal)
          .map((l) => l.trimEnd())
          .filter((l) => l.trim().length > 0),
      ),
  );
}

/**
 * The mark the compact History rail gives one entry, or none where it names
 * none.
 *
 * The rail marks every entry this file holds with the state the prefix being
 * read holds it in, written as the first character of that state's own word: a
 * glyph where the word has one, and a letter where it does not. It says so
 * whichever entry is being read and whether or not a catalog is open, which is
 * what makes it the thing to wait on — the catalog's own row spells the same
 * fact `[ok]`, and the catalog is a drawer somebody has to open.
 */
export function railMarkOn(terminal: Terminal, order: number): string | undefined {
  for (const line of screenOf(terminal)) {
    const at = line.indexOf(COMPACT_HISTORY_TITLE);
    if (at === -1) {
      continue;
    }
    // Up to the rule, which is where the rail ends and where the reading is
    // begins. A number past it is part of that sentence, not an entry.
    const band = line.slice(at + COMPACT_HISTORY_TITLE.length);
    const rail = band.split("\u2500\u2500")[0] ?? "";
    const match = new RegExp(`(?:^|\\s)${order}\\s*([\\u2713\\u00d7\\u25cf\\u002dU])`).exec(rail);
    return match === null ? undefined : match[1];
  }
  return undefined;
}

/** How this suite names an outcome, and the mark the rail gives it. */
export const RAIL_MARKS: Readonly<Record<string, string>> = Object.freeze({
  ok: "\u2713",
  err: "\u00d7",
  cancelled: "-",
  unfinished: "\u25cf",
});

/**
 * Wait until this entry has reached this outcome, as the rail says.
 *
 * The rail rather than the catalog, for the reason {@link railMarkOn} gives.
 */
export function settledEntry(terminal: Terminal, order: number, outcome: string): Operation<void> {
  const mark = RAIL_MARKS[outcome] ?? outcome;
  return awaiting(
    terminal,
    `entry ${order} reaching ${outcome}`,
    (one) => railMarkOn(one, order) === mark,
  );
}

/**
 * Whether the Entries catalog is the drawer this frame is showing.
 *
 * Asked of the drawer's own rectangle. A row of this screen crosses every
 * column it has — the reading beside a drawer is drawn on the same rows as the
 * drawer itself — so a reader looking at whole rows finds the word `Entries`
 * with a transcript column in front of it and a Sidekick pane behind it, and
 * cannot tell the drawer's title from the narrow frame's routing bar or from
 * the selected work's breadcrumb. Inside the rectangle there is only one of
 * them.
 */
export function catalogShowing(terminal: Terminal): boolean {
  const rect = drawerRect(terminal.size, true);
  if (rect === undefined) {
    return false;
  }
  const rows = screenOf(terminal);
  let titled = false;
  let closable = false;
  for (let row = rect.y; row < rect.y + rect.height; row += 1) {
    const text = (rows[row] ?? "").slice(rect.x, rect.x + rect.width).trim();
    if (/^Entries\b/.test(text)) {
      titled = true;
    }
    if (text.includes("[close]")) {
      closable = true;
    }
  }
  return titled && closable;
}

/**
 * Open the Entries catalog, the way a person does.
 *
 * The staged screen keeps no permanent catalog column, so the catalog is a
 * drawer somebody opens over the reading. Every row that reads a catalog row
 * opens it first and closes it after: one left open would cover the pane the
 * next assertion is about.
 */
export function* openCatalog(terminal: Terminal): Operation<void> {
  if (catalogShowing(terminal)) {
    return;
  }
  yield* activate(terminal, "Entries");
  yield* awaiting(terminal, "the catalog opening", (one) => catalogShowing(one));
}

/** Put the catalog away again, which chooses nothing. */
export function* closeCatalog(terminal: Terminal): Operation<void> {
  if (!catalogShowing(terminal)) {
    return;
  }
  yield* activate(terminal, "[close]");
  yield* awaiting(terminal, "the catalog closing", (one) => !catalogShowing(one));
}

/** Whether this label is the row being read, by the selection channel. */
export function marked(terminal: Terminal, label: string): boolean {
  return markedIn(screenOf(terminal), label);
}

/**
 * The same question, of rows a caller has already chosen.
 *
 * The two columns immediately before the label, so a focus marker beside them
 * changes nothing: the two channels are independent.
 */
export function markedIn(rows: readonly string[], label: string): boolean {
  return rows.some((line) => {
    const at = line.indexOf(label);
    return at >= 2 && line.slice(at - 2, at) === "* ";
  });
}

/**
 * Wait, in real time, until the screen says what it is asked about.
 *
 * Real time rather than a count of turns, because what these rows wait for is
 * work off this interpreter: a compile, a filesystem append, a provider turn.
 * Said loudly when it never arrives, with what the screen was showing instead —
 * a wait that gave up quietly would go on to assert against a frame nobody ever
 * drew and blame the assertion.
 */
export function* awaiting(
  terminal: Terminal,
  what: string,
  says: (terminal: Terminal) => boolean,
): Operation<void> {
  const deadline = Date.now() + MOUNTED_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (says(terminal)) {
      return;
    }
    yield* sleep(10);
    yield* settled(20);
  }
  throw new Error(
    `${what} never happened within ${MOUNTED_DEADLINE_MS}ms. rows=` +
      JSON.stringify(
        screenOf(terminal)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
  );
}

/**
 * Wait until a completed presentation shows what this asks about.
 *
 * Driven by the screen rather than by a clock: the question is asked of the
 * cells now, and again each time another presentation completes, so it costs
 * nothing while nothing is drawn and cannot miss a frame between asking and
 * listening. A command that stops first ends the wait with how it stopped, and
 * the deadline is only how long a missing frame gets before the wait says so.
 */
export function* untilShown(
  terminal: Terminal,
  what: string,
  shows: (terminal: Terminal) => boolean,
): Operation<void> {
  const rows = (): string =>
    JSON.stringify(
      screenOf(terminal)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  yield* race([
    (function* (): Operation<void> {
      while (true) {
        const seen = terminal.drawn;
        if (shows(terminal)) {
          return;
        }
        const ending = terminal.ending;
        if (ending !== undefined) {
          throw ending.failure ?? new Error(`the command ended before ${what}. rows=${rows()}`);
        }
        yield* terminal.after(seen);
      }
    })(),
    (function* (): Operation<void> {
      yield* sleep(MOUNTED_DEADLINE_MS);
      const { columns, rows: height } = terminal.size;
      throw new Error(
        `${what} was never shown within ${MOUNTED_DEADLINE_MS}ms at ${columns}x${height}. rows=${rows()}`,
      );
    })(),
  ]);
}

/** Where this text is on the screen, if it is anywhere. */
export function coordinateOf(
  terminal: Terminal,
  label: string,
  /**
   * The leftmost column to accept, for a label this screen draws twice.
   *
   * Three columns write to the same rows, and several controls are spelled the
   * same in more than one of them — both window controls, above all. A row
   * looking for the one in a particular pane says where that pane starts.
   */
  from = 0,
): { readonly column: number; readonly row: number } | undefined {
  for (const [row, line] of screenOf(terminal).entries()) {
    const column = line.indexOf(label, from);
    if (column !== -1) {
      return { column, row };
    }
  }
  return undefined;
}

/** Press at exactly this cell. The protocol counts from one; the screen from zero. */
export function* clickAt(
  terminal: Terminal,
  at: { readonly column: number; readonly row: number },
): Operation<void> {
  terminal.feed(`\x1b[<0;${at.column + 1};${at.row + 1}M`);
  yield* settled(30);
}

/**
 * Activate one control by pressing on it.
 *
 * The other way in, and the one a row uses while the execution is moving:
 * a pointer press needs no focus traversal, so it reaches a control without
 * walking past the two input destinations on the way.
 */
export function* click(terminal: Terminal, label: string, from = 0): Operation<void> {
  const at = coordinateOf(terminal, label, from);
  if (at === undefined) {
    throw new Error(
      `no control labelled ${label} is on the screen. rows=` +
        JSON.stringify(
          screenOf(terminal)
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
    );
  }
  yield* clickAt(terminal, at);
}

/** Focus one control and activate it, the way a person does. */
export function* activate(terminal: Terminal, marker: string): Operation<void> {
  yield* focusOn(terminal, marker);
  terminal.feed("\r");
  yield* settled(30);
}
/**
 * Ask the Sidekick something, the way a person asks it.
 *
 * Its tab, its box, its control — nothing here reaches the owner, reserves a
 * cycle or reduces an action. Activating the tab is what focuses the box, so a
 * row that is already in the box does not need to activate it again.
 */
export function* sendMessage(repl: MountedRepl, text: string): Operation<void> {
  if (!focusedField(repl.terminal, MESSAGE_PROMPT)) {
    yield* activate(repl.terminal, "Sidekick");
    // Waited for, not counted. The claim an activation makes is resolved when
    // the next frame is built, and a frame is measured work rather than a
    // number of turns — so typing after a fixed count of them sometimes typed
    // into whatever still held focus, which is the draft.
    yield* awaiting(repl.terminal, "the message box taking the focus its tab claimed", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
  }
  repl.terminal.feed(text);
  // Read from the composer's own rows rather than from one row with the name on
  // it: the value is drawn beneath its name, so a label-and-value row is not
  // what this screen draws any more.
  yield* awaiting(repl.terminal, `the message box holding ${JSON.stringify(text)}`, (one) =>
    messageText(one).includes(text),
  );
  // This screen has two Sends — the entry draft's and this composer's — so
  // the column the Sidekick's own pane begins at is what names which one.
  // Clicking the leftmost would submit a draft instead of sending a message.
  yield* click(repl.terminal, "[send]", sidekickColumn(repl.terminal));
  yield* settled(60);
}

/**
 * The column the Sidekick's own pane starts at, for a label it shares.
 *
 * Read from the composer's own row, which is the one row only that pane draws.
 */
export function sidekickColumn(terminal: Terminal): number {
  return sidekickColumnIn(screenOf(terminal));
}

/** The same, out of rows a caller already has. */
export function sidekickColumnIn(rows: readonly string[]): number {
  const row = rows.find((line) => line.includes(MESSAGE_PROMPT));
  return row === undefined ? 0 : Math.max(0, row.indexOf(MESSAGE_PROMPT));
}

/** The Sidekick's own pane, as the rows it draws and nothing beside it. */
export function sidekickPaneIn(rows: readonly string[]): readonly string[] {
  const from = sidekickColumnIn(rows);
  return rows.map((line) => line.slice(from));
}

/** Exactly what the entry draft is showing, out of rows a caller already has. */
export function draftTextIn(rows: readonly string[]): string {
  return draftRowsIn(rows).join("\n").trim();
}

/**
 * Whether any of these rows contains this text.
 *
 * The same question `shows` asks, over rows a caller has already chosen —
 * which is what an assertion about one size needs: this renderer writes diffs, so
 * the whole accumulated buffer still holds the rows the size before it drew.
 */
export function rowsShow(rows: readonly string[], expected: string): boolean {
  return rows.some((line) => line.includes(expected));
}

/**
 * Which of the right pane's two readings these rows are showing.
 *
 * Read from the body the pane draws rather than from its tab. Both names are in
 * that column's header on every wide and medium frame — the two tabs *are* the
 * header — so a label says only that the tab is there, and `shows("Bindings")`
 * would be true of every screen either reading ever drew. The Sidekick's body is
 * the box its messages are typed into; Bindings is the reading that has none.
 *
 * Only meaningful where there are two panes to choose between. A narrow frame
 * routes one outlet and answers for whichever outlet it routed.
 */
export function paneShown(rows: readonly string[]): "sidekick" | "bindings" {
  return rowsShow(rows, MESSAGE_PROMPT) ? "sidekick" : "bindings";
}

/** The same, read from a terminal's current screen. */
export function panePresented(terminal: Terminal): "sidekick" | "bindings" {
  return paneShown(screenOf(terminal));
}

/**
 * Resize, wait for a whole frame of the new size, and hand back its reading.
 *
 * A whole frame is one presented after the resize whose footer carries the way
 * out. The reading is a function because a row goes on driving the screen
 * after the resize, and each call answers with what it shows then.
 */
export function* resizeTo(terminal: Terminal, size: ReplTerminalSize): Operation<() => string[]> {
  const from = terminal.drawn;
  terminal.resized(size);
  yield* untilShown(
    terminal,
    `a whole frame at ${size.columns}x${size.rows}`,
    (one) =>
      one.drawn > from &&
      screenOf(one)
        .slice(Math.max(0, size.rows - FOOTER_ROWS))
        .some((line) => line.includes("[exit]")),
  );
  return () => screenOf(terminal);
}

/**
 * The same reading for a size this terminal may already be at.
 *
 * A window told it is the size it is draws nothing, so there is no resize to
 * wait for: the screen already shows this size.
 */
export function* readingAt(terminal: Terminal, size: ReplTerminalSize): Operation<() => string[]> {
  if (terminal.size.columns === size.columns && terminal.size.rows === size.rows) {
    return () => screenOf(terminal);
  }
  return yield* resizeTo(terminal, size);
}

/** The form's own editable lines, by the row each one is drawn on. */
function valueLines(terminal: Terminal): number[] {
  const at: number[] = [];
  for (const [index, line] of screenOf(terminal).entries()) {
    // The field prompt, which every editable line of a form carries and nothing
    // else on this screen does.
    if (/(^|[> ])>?\s{1,2}= /.test(line) && line.includes(" = ")) {
      at.push(index);
    }
  }
  return at;
}

/**
 * Put focus on the editable line of the form field at this position.
 *
 * By position rather than by name, because the lines themselves do not carry
 * one: a form's editable lines all read `= <value>`, and what names them is the
 * labelled row above each. The order is the schema's own declared order, which
 * is what a case asking for "the second field" already knows.
 *
 * Tabbed, as a person does it: there is no host shortcut to a control, and a
 * pointer press on an editable line is not a focus change in this product.
 */
export function* focusFormValue(
  terminal: Terminal,
  position: number,
  limit = 240,
): Operation<void> {
  for (let press = 0; press <= limit; press += 1) {
    const lines = valueLines(terminal);
    const wanted = lines[position];
    if (wanted !== undefined && (screenOf(terminal)[wanted] ?? "").includes(">  = ")) {
      return;
    }
    terminal.feed("\t");
    yield* settled(12);
  }
  throw new Error(
    `focus never reached form value ${position} in ${limit} presses. rows=` +
      JSON.stringify(
        screenOf(terminal)
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length > 0),
      ),
  );
}
