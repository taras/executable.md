/**
 * Driving the real REPL command, through a terminal a test owns.
 *
 * These rows are about the mounted product: `runReplProgram` opens the
 * repository, validates the route, opens one session, acquires this
 * execution's Sidekick and runs the screen — and the only things replaced are
 * the transport under the agent provider and the terminal under the renderer.
 * Everything a case asks for goes in as keystrokes or pointer events and comes
 * back as drawn cells, because a control reached by calling the owner directly
 * would prove nothing about the control a person actually has.
 *
 * The terminal harness and the keyboard helpers were the journey suite's; they
 * are here so the mounted Sidekick rows and the entry journeys drive the
 * product the same way rather than through two accounts of it.
 */

import { ensure, resource, sleep, spawn, until, withResolvers } from "effection";
import type { Operation, Result, Stream, Subscription } from "effection";
import { appendFile, open as openFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { installReplHost } from "../../../../src/repl-assembly.ts";
import { ReplHost } from "../../../../src/repl/host.ts";
import { installReplTerminal } from "../../../../src/repl/terminal-host.ts";
import type { ReplTerminalCapabilities } from "../../../../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../../../../src/repl/terminal.ts";
import { ReplClock } from "../../../../src/repl/frame.ts";
import { runReplProgram } from "../../../../src/repl/program.ts";
import type { ReplOutcome } from "../../../../src/repl/program.ts";
import { assembleReplProfile } from "../../../../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../../../../src/repl-profile.ts";
import { resolveAgentStack } from "../../../../src/agent-stack.ts";
import { NO_PLUGINS } from "../../../../src/plugin-host.ts";
import { pairedReplRepository } from "../../../../src/repl/sidekick/repository.ts";
import { PAIRED_DIRECTORY } from "../../../../src/repl/sidekick/history.ts";
import type { SidekickRecord } from "../../../../src/repl/sidekick/history.ts";
import { projectRepl } from "../../../../src/repl/model.ts";
import type { ReplModel } from "../../../../src/repl/model.ts";
import { REPL_DIRECTORY } from "../../../../src/repl/storage.ts";
import { FOOTER_ROWS } from "../../../../src/repl/layout.ts";
import type { PairedReplRepository } from "../../../../src/repl/sidekick/repository.ts";
import { useTempFileCompiler } from "@executablemd/core";
import { createFakeAcp, makeRegistry, makeStore } from "../../../support/fake-acp.ts";
import type { FakeAcp } from "../../../support/fake-acp.ts";
import { useTemporary } from "./sidekick-harness.ts";

/** The draft row's own prompt, which is how its row is told from the other one. */
export const DRAFT_PROMPT = "Draft: ";

/** The Sidekick's message box, by the prompt that names which destination it is. */
export const MESSAGE_PROMPT = "Message Sidekick: ";

const BYTES = new TextEncoder();
const TEXT = new TextDecoder();

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
 * The same replay over a chosen run of presentations.
 *
 * What a resize draws can only be read on its own: this renderer writes diffs,
 * so a buffer that also holds the frames before the resize holds rows the
 * smaller terminal no longer has. The engine redraws completely after a size
 * change, so the presentations from the resize onward are a whole screen.
 */
export function replay(written: readonly Uint8Array[]): string[] {
  const rows: string[][] = [];
  let row = 0;
  let column = 0;

  const put = (character: string): void => {
    while (rows.length <= row) {
      rows.push([]);
    }
    const line = rows[row];
    while (line.length < column) {
      line.push(" ");
    }
    line[column] = character;
    column += 1;
  };

  const text = written.map((bytes) => TEXT.decode(bytes)).join("");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\u001B") {
      if (character === "\n") {
        row += 1;
        column = 0;
      } else if (character === "\r") {
        column = 0;
      } else {
        put(character);
      }
      continue;
    }
    // CSI: the only sequences this renderer uses to position and to clear.
    const csi = /^\u001B\[([0-9;]*)([@-~])/.exec(text.slice(index));
    if (csi !== null) {
      const parameters = csi[1].split(";").map((one) => (one === "" ? 0 : Number(one)));
      if (csi[2] === "H") {
        row = Math.max(0, (parameters[0] ?? 1) - 1);
        column = Math.max(0, (parameters[1] ?? 1) - 1);
      } else if (csi[2] === "J") {
        rows.length = 0;
        row = 0;
        column = 0;
      }
      index += csi[0].length - 1;
      continue;
    }
    // OSC, and the two-byte escapes. Neither carries anything readable.
    const osc = /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/.exec(text.slice(index));
    if (osc !== null) {
      index += osc[0].length - 1;
      continue;
    }
    index += 1;
  }
  return rows.map((line) => line.join(""));
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

/**
 * The sizes a churning drag passes through, all of them drawable.
 *
 * Four, cycled, so consecutive reads never answer with the same size twice —
 * and none of them is below the minimum, because what this exercises is a frame
 * being outrun rather than the refusal a too-small window shows.
 */
const DRAGGED: readonly ReplTerminalSize[] = [
  { columns: 160, rows: 36 },
  { columns: 120, rows: 30 },
  { columns: 100, rows: 26 },
  { columns: 84, rows: 22 },
];

/** Let every task that is ready take its turn. */
export function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/** A terminal the test drives completely. */
export interface Terminal {
  /** Everything ever presented, in order. */
  readonly presented: Uint8Array[];
  /**
   * When set, the next presentation blocks here until it is released.
   *
   * The seam the frame-order control needs: while a frame is being written, the
   * stream must not have been told that frame was applied.
   */
  holdPresent: { release(): void } | undefined;
  size: ReplTerminalSize;
  /** How many times the program has asked this terminal how big it is. */
  sized: number;
  /**
   * How many chunks have been fed to this terminal's input.
   *
   * What a row needs to say "and nothing was pressed": an assertion that the
   * screen updated on its own holds only if no keystroke could have caused it,
   * and a comment saying so is not evidence.
   */
  fed: number;
  readonly raw: boolean[];
  resets: number;
  listeners: number;
  readers: number;
  feed(text: string): void;
  bytes(raw: Uint8Array): void;
  /** Make the next presentation block, so a test can look at the frame stream. */
  holdNextPresent(): void;
  resized(size: ReplTerminalSize): void;
  /**
   * Resize *between* two of the program's size reads.
   *
   * A window dragged while a frame is being prepared is exactly this: the read
   * the frame was resolved against reports one size, and every read after it
   * reports another. `after` counts reads from now, and the read that triggers
   * it still answers with the size that is going away.
   */
  resizeAfterRead(after: number, next: ReplTerminalSize): void;
  /**
   * Move the terminal on *every* one of the next `reads` size reads.
   *
   * A window still being dragged. Each read answers with the size that was
   * there and leaves a different one behind it, so every preparation the
   * program takes is invalidated before it can revalidate — which is what
   * exhausting a frame's rebuild budget looks like from outside. The last of
   * those reads settles on `settled` and the churn is over.
   */
  churnSize(reads: number, settled: ReplTerminalSize): void;
  /** How many churned reads are still owed, so a test can wait for the end. */
  churning(): number;
  end(): void;
}

export function recordingTerminal(
  size: ReplTerminalSize = { columns: 160, rows: 36 },
  interactive = true,
): {
  terminal: Terminal;
  install(): Operation<void>;
} {
  const queue: Uint8Array[] = [];
  const watchers = new Set<() => void>();
  let waiting: ((result: IteratorResult<Uint8Array, void>) => void) | undefined;
  let ended = false;

  let holding = false;
  let dragging: { after: number; next: ReplTerminalSize } | undefined;
  let churn: { left: number; settled: ReplTerminalSize } | undefined;
  const terminal: Terminal = {
    presented: [],
    holdPresent: undefined,
    size,
    sized: 0,
    fed: 0,
    raw: [],
    resets: 0,
    listeners: 0,
    readers: 0,
    feed(text: string): void {
      terminal.bytes(BYTES.encode(text));
    },
    holdNextPresent(): void {
      holding = true;
    },
    bytes(raw: Uint8Array): void {
      terminal.fed += 1;
      const resolve = waiting;
      if (resolve === undefined) {
        queue.push(raw);
        return;
      }
      waiting = undefined;
      resolve({ done: false, value: raw });
    },
    resized(next: ReplTerminalSize): void {
      terminal.size = next;
      for (const watcher of watchers) {
        watcher();
      }
    },
    resizeAfterRead(after: number, next: ReplTerminalSize): void {
      dragging = { after: terminal.sized + after, next };
    },
    churnSize(reads: number, settled: ReplTerminalSize): void {
      churn = { left: reads, settled };
    },
    churning(): number {
      return churn?.left ?? 0;
    },
    end(): void {
      ended = true;
      const resolve = waiting;
      if (resolve !== undefined) {
        waiting = undefined;
        resolve({ done: true, value: undefined });
      }
    },
  };

  const host: ReplTerminalCapabilities = {
    interactive: () => interactive,
    size: () => {
      terminal.sized += 1;
      const reported = terminal.size;
      if (churn !== undefined) {
        churn.left -= 1;
        // Always a different size from the one just answered with, so no
        // preparation can be revalidated against the size it was measured for.
        const next = churn.left > 0 ? DRAGGED[churn.left % DRAGGED.length] : churn.settled;
        if (churn.left <= 0) {
          churn = undefined;
        }
        // Set rather than announced. The host's own resize watcher reads the
        // size from inside its listener, so announcing here would re-enter this
        // read and drain the whole drag in one call. Nothing needs the
        // announcement: the frame being outrun is already reading again.
        terminal.size = next;
      } else if (dragging !== undefined && terminal.sized >= dragging.after) {
        const { next } = dragging;
        dragging = undefined;
        terminal.resized(next);
      }
      return reported;
    },
    *write(bytes: Uint8Array): Operation<void> {
      terminal.presented.push(new Uint8Array(bytes));
      if (!holding) {
        // A write that completed, which still costs the caller a turn.
        yield* sleep(0);
        return;
      }
      holding = false;
      const held = withResolvers<void>();
      terminal.holdPresent = { release: held.resolve };
      yield* held.operation;
    },
    writeNow(): void {
      terminal.resets += 1;
    },
    setRaw(raw: boolean): void {
      terminal.raw.push(raw);
    },
    input(): Stream<Uint8Array, void> {
      return resource<Subscription<Uint8Array, void>>(function* (provide) {
        let open = false;
        // Registered before the reader is taken, so a scope cancelled between
        // the two leaves nothing holding this terminal's input.
        yield* ensure(() => {
          if (!open) {
            return;
          }
          open = false;
          terminal.readers -= 1;
          // Actively cancelled: a cleanup that waited for the outstanding read
          // to end on its own would need another keystroke to get one.
          const resolve = waiting;
          waiting = undefined;
          resolve?.({ done: true, value: undefined });
        });
        terminal.readers += 1;
        open = true;
        yield* provide({
          *next(): Operation<IteratorResult<Uint8Array, void>> {
            // Always one suspension per chunk, buffered or not: the reader turns
            // one chunk into many decoded events, and draining a buffer without
            // yielding hands them over faster than the scanner takes them.
            const pending = withResolvers<IteratorResult<Uint8Array, void>>();
            const head = queue.shift();
            if (head !== undefined) {
              pending.resolve({ done: false, value: head });
            } else if (ended) {
              pending.resolve({ done: true, value: undefined });
            } else {
              waiting = pending.resolve;
            }
            return yield* pending.operation;
          },
        });
      });
    },
    onResize(listener: () => void): () => void {
      watchers.add(listener);
      terminal.listeners += 1;
      return () => {
        watchers.delete(listener);
        terminal.listeners -= 1;
      };
    },
  };

  return { terminal, install: () => installReplTerminal(host) };
}

/**
 * What the screen says, by replaying what was written to it.
 *
 * A real buffer rather than the bytes with escapes stripped, because this
 * renderer writes *diffs*: it moves the cursor to what changed and writes only
 * that. Concatenating the diffs gives characters in the order they were written
 * rather than the order they appear, and a character the previous frame already
 * had is not written again at all — so stripped bytes read as words with letters
 * missing. Interpreting the cursor moves is what makes an assertion about the
 * screen an assertion about the screen.
 */
export function screenOf(terminal: Terminal): string[] {
  return replay(terminal.presented);
}

/** Whether any row of the screen contains this text. */
export function shows(terminal: Terminal, expected: string): boolean {
  return screenOf(terminal).some((line) => line.includes(expected));
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
    if (screenOf(terminal).some((line) => line.includes(`>> ${DRAFT_PROMPT}`))) {
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
      if (after.startsWith(label) || beyond.startsWith(label) || named.startsWith(label)) {
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
  return screenOf(terminal).some((line) => line.includes(`>> ${prompt}`));
}

/**
 * Exactly what the draft is holding, after its marker and its prompt.
 *
 * What a person can read, which for several lines is the last of them under a
 * count of the rest — the field draws one row and says so.
 */
export function draftText(terminal: Terminal): string {
  const row = draftRow(terminal);
  return row.slice(row.indexOf(DRAFT_PROMPT) + DRAFT_PROMPT.length).trimEnd();
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
export function messageRowsIn(rows: readonly string[]): readonly string[] {
  const at = rows.findIndex((line) => line.includes(MESSAGE_PROMPT));
  if (at === -1) {
    return [];
  }
  // Where this pane's own content begins. The name row is the field's marker
  // followed by its prompt — `>> ` or ` > ` — so the column three before the
  // prompt is the column every value row starts at.
  const from = Math.max(0, rows[at].indexOf(MESSAGE_PROMPT) - 3);
  const value: string[] = [];
  for (const line of rows.slice(at + 1)) {
    const own = line.slice(from).trimEnd();
    const text = own.trim();
    // The composer's own rows end where this pane's controls and status begin.
    if (text.startsWith("[") || text.endsWith("is working...")) {
      break;
    }
    value.push(own);
  }
  return value;
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

/** How long any mounted wait gives something before it says it never happened. */
export const MOUNTED_DEADLINE_MS = 15_000;

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
 * The same wait for something that is not on the screen.
 *
 * A file landing, a provider being asked, a job joining: facts a row needs
 * before it reads cells, and none of them are drawn.
 */
export function* awaited(what: string, settled_: () => boolean): Operation<void> {
  const deadline = Date.now() + MOUNTED_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (settled_()) {
      return;
    }
    yield* sleep(10);
    yield* settled(20);
  }
  throw new Error(`${what} never happened within ${MOUNTED_DEADLINE_MS}ms`);
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
 * One append this case is holding open, and when it actually started.
 *
 * Two observations rather than one, because "asked for" and "in flight" are
 * different moments and only the second one is a gate: the movable writer's own
 * count is raised inside the host's append, so a case that released before the
 * append started would have held nothing and proved nothing about ordering.
 */
export interface HeldAppend {
  /** Settles once this append is genuinely in flight. */
  started(): Operation<void>;
  /** Whether it has started. */
  readonly inFlight: boolean;
  /** Whether it has been let go. */
  readonly released: boolean;
  /** Let it finish. */
  release(): void;
}

/**
 * The seam a case holds a real record open at.
 *
 * Inside the host's `appendRecord`, before the bytes are written, which is the
 * only place that makes a held append genuinely in flight: the movable writer's
 * count is already raised and the storage handoff's wait has something to wait
 * for. A gate that held the caller instead would be a gate on the test.
 */
export interface AppendGate {
  /** Every path an append actually reached, in order. */
  readonly reached: string[];
  /** How many appends have reached this path. */
  reaching(path: string): number;
  /**
   * Hold the next append this predicate accepts.
   *
   * The next one rather than all of them, so a case holds the record it means
   * to and everything behind it keeps writing.
   */
  holdNext(accepts: (path: string, record: string) => boolean): HeldAppend;
  /**
   * What the installed host calls for every append, and nothing else calls.
   *
   * Promises on both sides because the host's own append is defined in them:
   * this is the boundary, and `until` suspends the appending task on what comes
   * back exactly as it suspends on the write itself.
   */
  around(path: string, record: string): Promise<void> | undefined;
}

export function appendGate(): AppendGate {
  const reached: string[] = [];
  const pending: Array<{
    accepts: (path: string, record: string) => boolean;
    arrived(): void;
    waiting: Promise<void>;
  }> = [];

  return {
    reached,
    reaching(path: string): number {
      return reached.filter((one) => one === path).length;
    },
    holdNext(accepts: (path: string, record: string) => boolean): HeldAppend {
      let letGo = (): void => {};
      let announce = (): void => {};
      let inFlight = false;
      let released = false;
      const waiting = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      const arrival = new Promise<void>((resolve) => {
        announce = resolve;
      });
      pending.push({
        accepts,
        arrived: (): void => {
          inFlight = true;
          announce();
        },
        waiting,
      });
      return {
        *started(): Operation<void> {
          yield* until(arrival);
        },
        get inFlight(): boolean {
          return inFlight;
        },
        get released(): boolean {
          return released;
        },
        release(): void {
          released = true;
          letGo();
        },
      };
    },
    around(path: string, record: string): Promise<void> | undefined {
      const index = pending.findIndex((one) => one.accepts(path, record));
      if (index === -1) {
        return undefined;
      }
      const [held] = pending.splice(index, 1);
      held.arrived();
      return held.waiting;
    },
  };
}

/**
 * One append held *inside* the operation that owns it.
 *
 * The difference from {@link HeldAppend} is the whole point of it: that gate
 * holds a Promise the host has already been handed, so cancelling the wait
 * leaves the write scheduled and releasing afterwards still performs it. This
 * one holds the contextual operation `ReplHost.operations.appendRecord` *is*,
 * before anything physical happens — so halting whatever owns that operation
 * unwinds the hold and the record is never written at all.
 */
export interface HeldOperation {
  /** Settles once this append's own operation is suspended in the hold. */
  started(): Operation<void>;
  /** Whether it is suspended in the hold now. */
  readonly holding: boolean;
  /** Whether the operation holding it came down without appending. */
  readonly abandoned: boolean;
  /** Let it go on and perform the append. */
  release(): void;
}

/**
 * A hold at the contextual operation boundary, for a case about cancellation.
 *
 * Installed as ordinary middleware over the host Api at the instrumentation
 * band, so the implementation underneath is the product's own and what this
 * adds is a suspension in front of it. `appended` is the physical record: a
 * path lands in it only once the host has actually written, which is what lets
 * a row assert that nothing was written rather than that nothing was read.
 */
export interface OperationGate {
  /** Every append the host physically performed, in order. */
  readonly appended: readonly { readonly path: string; readonly record: string }[];
  /** Hold the next append this predicate accepts, in its own operation. */
  holdNext(accepts: (path: string, record: string) => boolean): HeldOperation;
  /** Install the middleware. The mounted host calls this; cases do not. */
  install(): Operation<void>;
}

export function operationGate(): OperationGate {
  const appended: { path: string; record: string }[] = [];
  const pending: {
    accepts: (path: string, record: string) => boolean;
    begin(): void;
    settle(): void;
    waiting: Operation<void>;
  }[] = [];

  return {
    appended,
    holdNext(accepts) {
      const arrival = withResolvers<void>();
      const letGo = withResolvers<void>();
      let holding = false;
      let abandoned = false;
      let appendedHere = false;
      pending.push({
        accepts,
        begin: () => {
          holding = true;
          arrival.resolve();
        },
        settle: () => {
          holding = false;
          abandoned = !appendedHere;
          // Resolved on the way out as well, so a release that arrives after
          // this operation came down has nothing left waiting on it.
          letGo.resolve();
        },
        waiting: letGo.operation,
      });
      return {
        *started(): Operation<void> {
          yield* arrival.operation;
        },
        get holding(): boolean {
          return holding;
        },
        get abandoned(): boolean {
          return abandoned;
        },
        release(): void {
          appendedHere = true;
          letGo.resolve();
        },
      };
    },
    *install(): Operation<void> {
      yield* ReplHost.around(
        {
          appendRecord: ([path, record], next) => ({
            *[Symbol.iterator]() {
              const at = pending.findIndex((one) => one.accepts(path, record));
              if (at === -1) {
                yield* next(path, record);
                appended.push({ path, record });
                return;
              }
              const [held] = pending.splice(at, 1);
              // Registered before the hold is taken, so an operation halted
              // while suspended here still says what became of it — and a
              // release that arrives afterwards has nothing to resolve.
              yield* ensure(function* (): Operation<void> {
                held.settle();
              });
              held.begin();
              yield* held.waiting;
              yield* next(path, record);
              appended.push({ path, record });
            },
          }),
        },
        { at: "max" },
      );
    },
  };
}

/** One mounted command, and everything a case needs to drive and read it. */
export interface MountedRepl {
  /** The terminal the program drew on, and the keyboard a case types with. */
  readonly terminal: Terminal;
  /** The scripted agent behind the Sidekick's own provider. */
  readonly fake: FakeAcp;
  /** Where the executions live, for a case that reads the files. */
  readonly repository: PairedReplRepository;
  /** The repository root, for a case that lists what is on disk. */
  readonly root: string;
  /** The profile this command runs under. */
  readonly profile: ReplExecutionProfile;
  /** The append gate, where this command's host was installed with one. */
  readonly gate: AppendGate | undefined;
  /** The operation-level append gate, where this host was installed with one. */
  readonly operations: OperationGate | undefined;
  /** The command's own outcome, once it has returned. */
  outcome(): Result<ReplOutcome> | undefined;
}

/** One installed REPL host, and the handles a case reopens or reads it with. */
export interface MountedHost {
  /** The repository root the command itself resolves. */
  readonly root: string;
  /** The scripted agent behind the Sidekick's own provider. */
  readonly fake: FakeAcp;
  /** The profile the command runs under. */
  readonly profile: ReplExecutionProfile;
  /** The executions on disk, for a case that opens one itself. */
  readonly repository: PairedReplRepository;
  /** The append gate, where this host was installed with one. */
  readonly gate: AppendGate | undefined;
  /** The operation-level append gate, where this host was installed with one. */
  readonly operations: OperationGate | undefined;
}

/** The agent the scripted provider answers for. */
export const MOUNTED_AGENT = "scribe";

/**
 * A second agent this registry also knows, for a row about replacement.
 *
 * Known to the registry so that choosing it is a real replacement rather than
 * an availability refusal: what makes a replacement fail has to be the thing a
 * row is about, not a name nothing could ever resolve.
 */
export const OTHER_MOUNTED_AGENT = "scrivener";

/**
 * Install one REPL host over a directory nothing else uses, and a scripted agent.
 *
 * The profile is the product's: `assembleReplProfile` builds it from a resolved
 * agent stack exactly as the command does, so the Sidekick assembly under test
 * is the constrained one the command would install — no tools, no servers,
 * deny-all, strict, no prompt customization — with this fake under it.
 */
export function* useMountedHost(
  options: {
    /** A gate over the host's appends, for a case that holds a real record. */
    readonly gate?: AppendGate;
    /**
     * A gate over the *operation* each append is, for a case about cancelling.
     *
     * Beside the Promise gate rather than instead of it: one holds the write
     * the host was handed and the other holds the operation that would hand it
     * over, and only the second is something a halt can take back.
     */
    readonly operations?: OperationGate;
    /**
     * A data root that already holds a history, rather than a fresh one.
     *
     * For a case whose history has to be one an earlier *process* left behind:
     * those are produced by the recovery phases, and the only way to mount the
     * command over one is to point this host at the root they wrote.
     */
    readonly dataRoot?: string;
    /**
     * The entry default and the Sidekick's own agent, as two selections.
     *
     * Both default to {@link MOUNTED_AGENT}, which is what every row that does
     * not care about the distinction already runs under. A case that does care
     * names them separately and they travel the production path: the entry
     * default through `resolveAgentStack`, the Sidekick's through
     * `assembleReplProfile` — the same two inputs the flags settle.
     */
    readonly defaultAgent?: string;
    readonly sidekickAgent?: string;
  } = {},
): Operation<MountedHost> {
  const gate = options.gate;
  // An entry's eval block compiles through a module the host supplies, so a
  // harness without it would run entries that fail for a reason no row is about.
  yield* useTempFileCompiler();
  const dataRoot = options.dataRoot ?? (yield* useTemporary("xmd-repl-mounted-"));
  yield* installReplHost({
    dataRoot: () => dataRoot,
    environment: () => [
      { label: "runtime", value: "a controlled mounted host" },
      { label: "xmd", value: "0.0.0-mounted" },
    ],
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => openFile(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => {
      const held = gate?.around(path, record);
      const written = (held ?? Promise.resolve()).then(() => appendFile(path, record));
      return gate === undefined
        ? written
        : written.then(() => {
            gate.reached.push(path);
          });
    },
  });
  // Over the installed implementation, at the instrumentation band, so the
  // thing a case can halt is the operation the product performs rather than a
  // Promise the host has already been given.
  if (options.operations !== undefined) {
    yield* options.operations.install();
  }
  const fake = createFakeAcp();
  const stack = yield* resolveAgentStack(
    {
      agentProvider: "acpx",
      defaultAgent: options.defaultAgent ?? MOUNTED_AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: false,
    },
    undefined,
  );
  if (!stack.ok) {
    throw stack.error;
  }
  const profile = yield* assembleReplProfile(stack.value, NO_PLUGINS, {
    acp: {
      createRuntime: fake.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({
        [MOUNTED_AGENT]: `${MOUNTED_AGENT}-cmd`,
        [OTHER_MOUNTED_AGENT]: `${OTHER_MOUNTED_AGENT}-cmd`,
      }),
    },
    // Named to the profile rather than left to the environment: the Sidekick
    // assembly is built with it, and a conversation opened under an agent this
    // registry does not know would fail as an availability refusal before it
    // ever reached the fake.
    sidekickAgent: options.sidekickAgent ?? MOUNTED_AGENT,
    planWriterRoot: yield* useTemporary("xmd-repl-mounted-plan-"),
  });
  // The directory the command itself resolves, so a case that writes a file for
  // the command to find writes it where the command actually looks.
  const root = join(dataRoot, ...REPL_DIRECTORY);
  return {
    root,
    fake,
    profile,
    repository: pairedReplRepository(root),
    gate,
    operations: options.operations,
  };
}

/**
 * Run the real command on a terminal this case owns, and hand back the handles.
 *
 * Spawned, because the command runs until somebody leaves: a case feeds keys,
 * reads cells and then asks for Exit or Control-C. The outcome is readable
 * afterwards, which is what a release row needs.
 */
export function* useMountedRepl(
  options: {
    readonly size?: ReplTerminalSize;
    readonly location?: string;
    /** A host already installed, for a case that reopens the same root. */
    readonly host?: MountedHost;
    /** A gate over the host's appends, when this call installs the host. */
    readonly gate?: AppendGate;
    /** A gate over each append's own operation, when this call installs the host. */
    readonly operations?: OperationGate;
    /** A data root that already holds a history, when this call installs the host. */
    readonly dataRoot?: string;
    /** The entry default, when this call installs the host. */
    readonly defaultAgent?: string;
    /** The Sidekick's own agent, when this call installs the host. */
    readonly sidekickAgent?: string;
  } = {},
): Operation<MountedRepl> {
  const host =
    options.host ??
    (yield* useMountedHost({
      ...(options.gate === undefined ? {} : { gate: options.gate }),
      ...(options.operations === undefined ? {} : { operations: options.operations }),
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }),
      ...(options.sidekickAgent === undefined ? {} : { sidekickAgent: options.sidekickAgent }),
    }));
  const recording = recordingTerminal(options.size ?? { columns: 160, rows: 36 });
  yield* recording.install();
  const settledOutcome: { value?: Result<ReplOutcome> } = {};
  yield* spawn(function* (): Operation<void> {
    settledOutcome.value = yield* runReplProgram({
      profile: host.profile,
      ...(options.location === undefined ? {} : { location: options.location }),
    });
  });
  yield* untilDrawn(recording.terminal);
  return {
    terminal: recording.terminal,
    fake: host.fake,
    repository: host.repository,
    root: host.root,
    profile: host.profile,
    gate: host.gate,
    operations: host.operations,
    outcome: () => settledOutcome.value,
  };
}

/**
 * The one execution this command published, by name.
 *
 * Discovered rather than told: a fresh command mints its own identifier, and a
 * row that named one would be naming the fixture's bookkeeping instead of the
 * execution the product created.
 */
export function* mountedExecution(repl: MountedRepl): Operation<string> {
  const published = yield* until(readdir(join(repl.root, PAIRED_DIRECTORY)));
  if (published.length !== 1) {
    throw new Error(`one execution was expected on disk, and there are ${published.length}`);
  }
  return published[0];
}

/** What is actually on disk for this command: its chat, and its entry history. */
export function* mountedReading(repl: MountedRepl): Operation<{
  readonly execution: string;
  readonly chat: readonly SidekickRecord[];
  readonly model: ReplModel;
}> {
  const execution = yield* mountedExecution(repl);
  const opened = yield* repl.repository.open(execution);
  if (opened.chat.form !== "paired") {
    throw new Error("this execution has no published chat history to read");
  }
  const projected = projectRepl(yield* opened.stream.readAll());
  if (!projected.ok) {
    throw projected.error;
  }
  return { execution, chat: opened.chat.records, model: projected.value };
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
  yield* click(repl.terminal, "[send]");
  yield* settled(60);
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
 * The reading is a function rather than an array because a row goes on driving
 * the screen after the resize: every call replays only the presentations from
 * this resize onward, so what it answers is this size's own screen rather than
 * a buffer still holding the taller one's rows.
 */
export function* resizeTo(terminal: Terminal, size: ReplTerminalSize): Operation<() => string[]> {
  const from = terminal.presented.length;
  const rows = (): string[] => replay(terminal.presented.slice(from));
  terminal.resized(size);
  yield* awaited(`a whole frame at ${size.columns}x${size.rows}`, () =>
    (rows()[Math.max(0, size.rows - FOOTER_ROWS)] ?? "").includes("[exit]"),
  );
  return rows;
}

/**
 * The same reading for a size this terminal may already be at.
 *
 * A window told it is the size it is draws nothing, so there is no resize to
 * wait for — and no need for one: the engine redraws completely after a size
 * change, so the accumulated buffer is already this size's own whole screen.
 * Replaying only the frames since a *same-size* mark would read a diff, which
 * holds the cells that changed and not the footer.
 */
export function* readingAt(terminal: Terminal, size: ReplTerminalSize): Operation<() => string[]> {
  if (terminal.size.columns === size.columns && terminal.size.rows === size.rows) {
    // deno-lint-ignore require-yield
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
