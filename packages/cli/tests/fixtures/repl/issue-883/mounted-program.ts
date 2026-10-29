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

import { action, ensure, race, resource, sleep, spawn, until, withResolvers } from "effection";
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
import type { ReplProfileAssembly } from "../../../../src/repl-profile.ts";
import { resolveAgentStack } from "../../../../src/agent-stack.ts";
import { NO_PLUGINS } from "../../../../src/plugin-host.ts";
import { pairedReplRepository } from "../../../../src/repl/sidekick/repository.ts";
import { PAIRED_DIRECTORY } from "../../../../src/repl/sidekick/history.ts";
import type { SidekickRecord } from "../../../../src/repl/sidekick/history.ts";
import { projectRepl } from "../../../../src/repl/model.ts";
import type { ReplModel } from "../../../../src/repl/model.ts";
import { REPL_DIRECTORY } from "../../../../src/repl/storage.ts";
import { drawerRect, FOOTER_ROWS } from "../../../../src/repl/layout.ts";
import { COMPACT_HISTORY_TITLE } from "../../../../src/repl/application.ts";
import type { PairedReplRepository } from "../../../../src/repl/sidekick/repository.ts";
import { API, useHostFiles } from "@executablemd/runtime";
import { ReplEntryHost } from "../../../../src/repl-entry-installation.ts";
import type { ReplEntryInstallation } from "../../../../src/repl-entry-installation.ts";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { useTempFileCompiler, useNormalizedOutput } from "@executablemd/core";
import { createFakeAcp, makeRegistry, makeStore } from "../../../support/fake-acp.ts";
import type { FakeAcp } from "../../../support/fake-acp.ts";
import { useTemporary } from "./sidekick-harness.ts";
import { readScreen, usedRows, useTerminalScreen } from "../../../support/terminal-screen.ts";
import type { TerminalScreen } from "../../../support/terminal-screen.ts";

/** The draft row's own prompt, which is how its row is told from the other one. */
export const DRAFT_PROMPT = " DRAFT";

/** The Sidekick's message box, by the prompt that names which destination it is. */
export const MESSAGE_PROMPT = " › message the sidekick";

const BYTES = new TextEncoder();

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
  /** Every presentation the program attempted, in order, including one still held. */
  readonly presented: Uint8Array[];
  /**
   * How many presentations have completed.
   *
   * A presentation reaches the screen when its write finishes, not when it is
   * attempted: a held write is in `presented` and not yet on the screen, and a
   * write that failed or was cancelled never reaches it.
   */
  readonly drawn: number;
  /** How many waits are subscribed to the next completed presentation. */
  readonly waiting: number;
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
  /** The screen the completed presentations drew, once installed. */
  readonly screen: TerminalScreen | undefined;
  feed(text: string): void;
  bytes(raw: Uint8Array): void;
  /** Make the next presentation block, so a test can look at the frame stream. */
  holdNextPresent(): void;
  /** Make the next presentation fail with this error, as a broken terminal does. */
  failNextPresent(error: Error): void;
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
  /**
   * Say the command drawing on this terminal has returned.
   *
   * A wait for the screen cannot be satisfied by a command that is no longer
   * drawing, so every pending one wakes and reports how it ended.
   */
  stopped(failure: Error | undefined): void;
  /** How the command ended, once {@link stopped} has said so. */
  readonly ending: { readonly failure: Error | undefined } | undefined;
  /** Settles once more than `count` presentations have completed, or the command stopped. */
  after(count: number): Operation<void>;
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
  const wakers = new Set<() => void>();
  let waiting: ((result: IteratorResult<Uint8Array, void>) => void) | undefined;
  let ended = false;
  let screen: TerminalScreen | undefined;
  let drawn = 0;
  let ending: { readonly failure: Error | undefined } | undefined;

  let holding = false;
  let failing: Error | undefined;
  let dragging: { after: number; next: ReplTerminalSize } | undefined;
  let churn: { left: number; settled: ReplTerminalSize } | undefined;
  const wake = (): void => {
    for (const one of [...wakers]) {
      one();
    }
  };
  const terminal: Terminal = {
    presented: [],
    get drawn() {
      return drawn;
    },
    get waiting() {
      return wakers.size;
    },
    get screen() {
      return screen;
    },
    get ending() {
      return ending;
    },
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
    failNextPresent(error: Error): void {
      failing = error;
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
      screen?.resize(next);
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
    stopped(failure: Error | undefined): void {
      ending = { failure };
      wake();
    },
    after(count: number): Operation<void> {
      return action<void>((resolve) => {
        if (drawn > count || ending !== undefined) {
          resolve();
          return () => {};
        }
        const one = (): void => resolve();
        wakers.add(one);
        return () => {
          wakers.delete(one);
        };
      });
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
        screen?.resize(next);
      } else if (dragging !== undefined && terminal.sized >= dragging.after) {
        const { next } = dragging;
        dragging = undefined;
        terminal.resized(next);
      }
      return reported;
    },
    *write(bytes: Uint8Array): Operation<void> {
      const written = new Uint8Array(bytes);
      terminal.presented.push(written);
      if (failing !== undefined) {
        const failure = failing;
        failing = undefined;
        throw failure;
      }
      if (holding) {
        holding = false;
        const held = withResolvers<void>();
        terminal.holdPresent = { release: held.resolve };
        yield* held.operation;
      } else {
        // A write that completed, which still costs the caller a turn.
        yield* sleep(0);
      }
      if (screen === undefined) {
        throw new Error("this terminal was written to before it was installed");
      }
      screen.feed(written);
      drawn += 1;
      wake();
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

  return {
    terminal,
    *install(): Operation<void> {
      screen = yield* useTerminalScreen(terminal.size);
      yield* installReplTerminal(host);
    },
  };
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

/**
 * The same wait again, for a fact only an operation can read.
 *
 * What is on disk is the case in point. A row drawn on the screen and a record
 * published in the history are two different moments: the Sidekick's words are
 * shown as soon as it has said them, and the reply they belong to is saved
 * after the entry it carries has been evaluated. A row that waited for the
 * screen and then read the file would be asking about the second moment having
 * waited for the first.
 */
export function* awaitedFact(what: string, held: () => Operation<boolean>): Operation<void> {
  const deadline = Date.now() + MOUNTED_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (yield* held()) {
      return;
    }
    yield* sleep(10);
    yield* settled(20);
  }
  throw new Error(`${what} never happened within ${MOUNTED_DEADLINE_MS}ms`);
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
  readonly profile: ReplProfileAssembly;
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
  readonly profile: ReplProfileAssembly;
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
    readonly projectCwd?: string;
    readonly includes?: readonly string[];
    readonly entryInstallation?: ReplEntryInstallation;
    readonly hostFiles?: boolean;
    readonly agentCwd?: AcpxProviderDependencies["agentCwd"];
  } = {},
): Operation<MountedHost> {
  yield* useNormalizedOutput();
  const gate = options.gate;
  const directory = options.projectCwd;
  if (directory !== undefined) {
    yield* API.Env.around(
      {
        *cwd() {
          return directory;
        },
      },
      { at: "min" },
    );
  }
  if (options.hostFiles === true) {
    yield* useHostFiles();
  }
  if (options.entryInstallation !== undefined) {
    yield* ReplEntryHost.set(options.entryInstallation);
  }
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
    ...(options.includes === undefined ? {} : { includes: options.includes }),
    acp: {
      ...(options.agentCwd === undefined ? {} : { agentCwd: options.agentCwd }),
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
    readonly projectCwd?: string;
    readonly includes?: readonly string[];
    readonly entryInstallation?: ReplEntryInstallation;
    readonly hostFiles?: boolean;
    readonly agentCwd?: AcpxProviderDependencies["agentCwd"];
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
      ...(options.projectCwd === undefined ? {} : { projectCwd: options.projectCwd }),
      ...(options.includes === undefined ? {} : { includes: options.includes }),
      ...(options.entryInstallation === undefined
        ? {}
        : { entryInstallation: options.entryInstallation }),
      ...(options.hostFiles === undefined ? {} : { hostFiles: options.hostFiles }),
      ...(options.agentCwd === undefined ? {} : { agentCwd: options.agentCwd }),
    }));
  const recording = recordingTerminal(options.size ?? { columns: 160, rows: 36 });
  yield* recording.install();
  const settledOutcome: { value?: Result<ReplOutcome> } = {};
  yield* spawn(function* (): Operation<void> {
    const outcome = yield* runReplProgram({
      profile: host.profile,
      ...(options.location === undefined ? {} : { location: options.location }),
    });
    settledOutcome.value = outcome;
    recording.terminal.stopped(outcome.ok ? undefined : outcome.error);
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
