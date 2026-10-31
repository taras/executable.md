/**
 * The running REPL as a page a test drives through the terminal and reads from
 * what the terminal shows.
 *
 * Every act is terminal input: keystrokes, and pointer presses at the first
 * cell of a label a person can read. Every reading is the emulator's screen
 * after one write the command completed — captured by middleware this scope
 * installs around the existing `ReplTerminal.write`, which delegates to the
 * real write first and copies the cells only once it returns. A held write
 * suspends inside that delegation and a failed one throws out of it, so
 * neither publishes a reading: holding and failing stay observable exactly as
 * the terminal double already made them.
 *
 * A reading is **not** a frame. The first one is the mode-apply sequence on an
 * empty screen, and a completed write is not a committed frame, so
 * `index` counts writes and proves nothing about frame counts. Keys, focus,
 * region rectangles and window offsets are not here at all: they are not in the
 * bytes, and the tests that own those invariants hold them with explicit
 * renderer and tree handles instead.
 *
 * A control is found by its visible label inside a scope stated from other
 * visible text. A locator refuses zero matches and refuses more than one, so a
 * reply that echoes `[send]`, or two panes that both draw it, fails loudly with
 * the rows it saw rather than pressing whichever came first.
 */

import { action, race, sleep } from "effection";
import type { Operation } from "effection";

import { ReplTerminal } from "../../src/repl/terminal.ts";
import type { ReplTerminalSize } from "../../src/repl/terminal.ts";
import { MOUNTED_DEADLINE_MS, useMountedRepl } from "./mounted-repl.ts";
import type { MountedRepl } from "./mounted-repl.ts";

/** One cell of the screen, counted from zero. */
export interface ScreenCell {
  readonly column: number;
  readonly row: number;
}

/**
 * Where a label may be looked for, stated from other visible text.
 *
 * `onRow` is the row some heading or prompt is drawn on, which is where a
 * control beside that heading lives. `after` is the rows below it. `rightOf`
 * is the columns at or right of that text's own first cell — the one bounded
 * layout statement this file makes, and it says only what it says: a label
 * left of that column is not in the scope. It does not state where a pane
 * begins.
 */
export interface ScreenScope {
  readonly onRow?: string;
  readonly after?: string;
  readonly rightOf?: string;
}

/** The screen after one write the command completed. */
export interface ScreenReading {
  /** How many writes had completed when this was captured, from one. */
  readonly index: number;
  /** The size the terminal had while this was captured. */
  readonly size: ReplTerminalSize;
  readonly rows: readonly string[];
  shows(text: string): boolean;
  /** How many times the text appears, over every row, counting repeats in one row. */
  occurrences(text: string): number;
  /** The same count inside a scope. */
  found(text: string, scope?: ScreenScope): number;
  /**
   * The first cell of the one match in this scope.
   *
   * Refuses zero matches and refuses more than one, naming the label, the
   * scope and the rows it read.
   */
  locate(text: string, scope?: ScreenScope): ScreenCell;
}

export type PageKey =
  | "Enter"
  | "Escape"
  | "Tab"
  | "Backtab"
  | "Backspace"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Alt+ArrowUp"
  | "Alt+ArrowDown";

const KEYS: Readonly<Record<PageKey, string>> = Object.freeze({
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backtab: "\x1b[Z",
  Backspace: "\x7f",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  "Alt+ArrowUp": "\x1b[1;3A",
  "Alt+ArrowDown": "\x1b[1;3B",
});

export interface ReplPage {
  /** The mounted command: its terminal, scripted agent, gates and outcome. */
  readonly repl: MountedRepl;
  /** The latest reading. */
  screen(): ScreenReading;
  /**
   * Wait for a reading this holds of, asking the latest one first.
   *
   * Fails with what the last reading showed when the command ends or the
   * deadline passes first.
   */
  until(what: string, holds: (reading: ScreenReading) => boolean): Operation<ScreenReading>;
  /** Press the pointer at the first cell of this label. Waits for nothing. */
  press(label: string, scope?: ScreenScope): Operation<void>;
  /** Send one named key. Waits for nothing. */
  key(name: PageKey): Operation<void>;
  wheel(direction: "up" | "down", at: ScreenCell): Operation<void>;
  /** Send text to whatever holds focus. Waits for nothing. */
  type(text: string): Operation<void>;
  /** Resize the terminal and wait for a reading the new size produced. */
  resize(size: ReplTerminalSize): Operation<ScreenReading>;
  /** The latest reading as a refusal reports it. */
  describe(): string;
}

/** Every offset into this row's text where it holds this text, including repeats. */
function offsetsIn(row: string, text: string): number[] {
  const found: number[] = [];
  let at = row.indexOf(text);
  while (at !== -1) {
    found.push(at);
    at = row.indexOf(text, at + 1);
  }
  return found;
}

/**
 * The terminal column each character of this row's text was drawn in.
 *
 * A cell is a column and a character is not: a double-width glyph occupies two
 * columns and the emulator reports the second of them as nothing at all, so a
 * row holding one is shorter as text than it is wide on the screen. Pressing
 * needs the column, and every offset this file resolves goes through here
 * before it becomes one. A grapheme the emulator reports as several characters
 * in one cell maps all of them to that cell.
 */
function columnsOf(cells: readonly string[]): number[] {
  const columns: number[] = [];
  for (const [column, cell] of cells.entries()) {
    for (let index = 0; index < cell.length; index += 1) {
      columns.push(column);
    }
  }
  return columns;
}

/** The one row this text is drawn on, or a refusal naming how many there were. */
function rowOf(rows: readonly string[], text: string, what: string): number {
  const matched = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.includes(text));
  if (matched.length !== 1) {
    throw new Error(
      `${what} needs exactly one row showing ${JSON.stringify(text)} and ${matched.length} ` +
        `were shown. rows=${JSON.stringify(visible(rows))}`,
    );
  }
  return matched[0].index;
}

/** The rows anything is drawn on, trimmed, for a refusal to quote. */
function visible(rows: readonly string[]): string[] {
  return rows.map((row) => row.trim()).filter((row) => row.length > 0);
}

function reading(index: number, size: ReplTerminalSize, cells: string[][]): ScreenReading {
  const rows = cells.map((line) => line.join("").trimEnd());
  const columns = cells.map((line) => columnsOf(line));
  /** The column one offset into a row's text was drawn in. */
  const columnAt = (row: number, offset: number): number => columns[row]?.[offset] ?? offset;
  /** The cells this scope admits: a row range, and a column floor. */
  const bounded = (scope: ScreenScope | undefined, what: string) => {
    let from = 0;
    let to = rows.length;
    let floor = 0;
    if (scope?.onRow !== undefined) {
      const at = rowOf(rows, scope.onRow, what);
      from = at;
      to = at + 1;
    }
    if (scope?.after !== undefined) {
      from = Math.max(from, rowOf(rows, scope.after, what) + 1);
    }
    if (scope?.rightOf !== undefined) {
      const at = rowOf(rows, scope.rightOf, what);
      floor = columnAt(at, rows[at].indexOf(scope.rightOf));
    }
    return { from, to, floor };
  };
  const matches = (text: string, scope: ScreenScope | undefined, what: string): ScreenCell[] => {
    const { from, to, floor } = bounded(scope, what);
    const found: ScreenCell[] = [];
    for (let row = from; row < to; row += 1) {
      for (const offset of offsetsIn(rows[row] ?? "", text)) {
        const column = columnAt(row, offset);
        if (column >= floor) {
          found.push({ column, row });
        }
      }
    }
    return found;
  };
  return {
    index,
    size,
    rows,
    shows: (text) => rows.some((row) => row.includes(text)),
    occurrences: (text) => rows.reduce((count, row) => count + offsetsIn(row, text).length, 0),
    found: (text, scope) => matches(text, scope, `looking for ${JSON.stringify(text)}`).length,
    locate(text, scope) {
      const what = `pressing ${JSON.stringify(text)}`;
      const found = matches(text, scope, what);
      if (found.length !== 1) {
        throw new Error(
          `${JSON.stringify(text)} is shown ${found.length} times in ${scopeOf(scope)} and one ` +
            `was needed${
              found.length === 0
                ? ""
                : ` (at ${found.map((one) => `${one.column},${one.row}`).join("; ")})`
            }. rows=${JSON.stringify(visible(rows))}`,
        );
      }
      return found[0];
    },
  };
}

function scopeOf(scope: ScreenScope | undefined): string {
  if (scope === undefined) {
    return "the whole screen";
  }
  const parts = [
    scope.onRow === undefined ? undefined : `the row showing ${JSON.stringify(scope.onRow)}`,
    scope.after === undefined ? undefined : `below ${JSON.stringify(scope.after)}`,
    scope.rightOf === undefined ? undefined : `at or right of ${JSON.stringify(scope.rightOf)}`,
  ].filter((part) => part !== undefined);
  return parts.join(", ");
}

/**
 * Mount the real command and wait for a screen a person could act on.
 *
 * Takes the same options as `useMountedRepl`. The middleware is installed in
 * this scope before the command is spawned, so every write it completes is
 * read; the terminal double feeds the emulator inside that write, so the cells
 * copied here are the ones that write left and nothing later.
 */
export function* useReplPage(
  options: Parameters<typeof useMountedRepl>[0] = {},
): Operation<ReplPage> {
  let latest: ScreenReading | undefined;
  let count = 0;
  const wakers = new Set<() => void>();
  let mounted: MountedRepl | undefined;

  yield* ReplTerminal.around({
    *write([bytes], next) {
      yield* next(bytes);
      const screen = mounted?.terminal.screen;
      if (screen !== undefined) {
        count += 1;
        latest = reading(count, screen.size, screen.cells());
        for (const wake of Array.from(wakers)) {
          wake();
        }
      }
    },
  });

  const repl = yield* useMountedRepl(options);
  mounted = repl;

  const captured = (seen: number): Operation<void> =>
    action<void>((resolve) => {
      if (count > seen) {
        resolve();
        return () => {};
      }
      const one = (): void => resolve();
      wakers.add(one);
      return () => {
        wakers.delete(one);
      };
    });
  function* ended(): Operation<void> {
    while (repl.terminal.ending === undefined) {
      yield* repl.terminal.after(repl.terminal.drawn);
    }
  }
  const next = (seen: number): Operation<void> => race([captured(seen), ended()]);

  const describe = (): string => {
    if (latest === undefined) {
      return "no write has completed yet";
    }
    const { columns, rows } = latest.size;
    return `reading ${latest.index} at ${columns}x${rows}, rows ${JSON.stringify(
      visible(latest.rows),
    )}`;
  };

  const screen = (): ScreenReading => {
    if (latest === undefined) {
      throw new Error("the command has completed no write yet");
    }
    return latest;
  };

  function* until(what: string, holds: (one: ScreenReading) => boolean): Operation<ScreenReading> {
    return yield* race([
      (function* (): Operation<ScreenReading> {
        while (true) {
          const seen = count;
          if (latest !== undefined && holds(latest)) {
            return latest;
          }
          const ending = repl.terminal.ending;
          if (ending !== undefined) {
            throw ending.failure ?? new Error(`the command ended before ${what}. ${describe()}`);
          }
          yield* next(seen);
        }
      })(),
      (function* (): Operation<ScreenReading> {
        yield* sleep(MOUNTED_DEADLINE_MS);
        throw new Error(`${what} was never shown within ${MOUNTED_DEADLINE_MS}ms. ${describe()}`);
      })(),
    ]);
  }

  function* press(label: string, scope?: ScreenScope): Operation<void> {
    const at = screen().locate(label, scope);
    repl.terminal.feed(`\x1b[<0;${at.column + 1};${at.row + 1}M`);
  }

  function* sendKey(name: PageKey): Operation<void> {
    repl.terminal.feed(KEYS[name]);
  }

  function* wheel(direction: "up" | "down", at: ScreenCell): Operation<void> {
    repl.terminal.feed(`\x1b[<${direction === "up" ? 64 : 65};${at.column + 1};${at.row + 1}M`);
  }

  function* type(text: string): Operation<void> {
    repl.terminal.feed(text);
  }

  function* resize(size: ReplTerminalSize): Operation<ScreenReading> {
    const from = count;
    repl.terminal.resized(size);
    return yield* until(
      `a screen at ${size.columns}x${size.rows}`,
      (one) => one.index > from && one.size.columns === size.columns && one.size.rows === size.rows,
    );
  }

  // A screen a person can act on. Usually that is the footer's way out; at a
  // terminal below the minimum it is the refusal naming the size, which draws
  // no control at all and is still a screen to act on — grow the window, or
  // press Escape.
  yield* until(
    "a screen a person can act on",
    (one) => one.shows("[exit]") || one.shows("needs at least"),
  );

  return { repl, screen, until, press, key: sendKey, wheel, type, resize, describe };
}
