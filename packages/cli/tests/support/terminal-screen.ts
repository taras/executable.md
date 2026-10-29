/**
 * A terminal's screen, as a real emulator leaves it after the bytes written to it.
 *
 * Every reader a REPL test has — the mounted terminal, the presenter's grid,
 * the `script` pty — reads the screen through this one implementation, which
 * is xterm.js's headless emulator under Termless's backend. A renderer that
 * writes diffs, erases a line, paints a background or draws a wide glyph is
 * read the way a terminal shows it, rather than the way a hand-written replay
 * happened to interpret it.
 *
 * The backend is owned directly rather than through Termless's `TestTerminal`,
 * because its `destroy()` is synchronous: a screen is released in a `finally`,
 * and `TestTerminal.close()` answers with a promise for work this in-memory
 * backend does not have.
 */

import { resource } from "effection";
import type { Operation } from "effection";
import type { Cell, TerminalBackend } from "@termless/core";
import { createXtermBackend } from "@termless/xtermjs";

import type { ReplTerminalSize } from "../../src/repl/terminal.ts";

/**
 * What one cell was drawn with.
 *
 * `foreground` and `background` are 24-bit, the way the palette states them.
 * `attrs` holds the SGR parameters of the attributes in force — `1` for bold —
 * in ascending order. `undefined` is the terminal's own default.
 */
export interface CellStyle {
  readonly foreground: number | undefined;
  readonly background: number | undefined;
  readonly attrs: readonly number[];
}

/** One emulated screen, at one size, until it is closed. */
export interface TerminalScreen {
  readonly size: ReplTerminalSize;
  /**
   * Whether this screen has been released.
   *
   * A released screen still answers {@link rows} and {@link buffer} with what
   * it showed last, because what a command left on the screen is read after
   * the scope that drew it has ended. Nothing else about it can be asked.
   */
  readonly closed: boolean;
  feed(bytes: Uint8Array | string): void;
  resize(size: ReplTerminalSize): void;
  /**
   * The visible rows, each up to its last written cell.
   *
   * A cell nothing ever wrote, or an erase cleared, ends a row; a space the
   * renderer wrote does not. A wide glyph's second cell contributes nothing, so
   * the glyph appears once.
   */
  rows(): string[];
  /** Every row the buffer holds, scrollback first, in the same form. */
  buffer(): string[];
  /** One visible cell: a space where nothing is drawn, empty behind a wide glyph. */
  at(column: number, row: number): string;
  /** Every visible cell, row by row, each read as {@link at} reads it. */
  cells(): string[][];
  styleAt(column: number, row: number): CellStyle;
  close(): void;
}

const ATTRIBUTES: ReadonlyArray<readonly [number, (cell: Cell) => boolean]> = [
  [1, (cell) => cell.bold],
  [2, (cell) => cell.dim],
  [3, (cell) => cell.italic],
  [4, (cell) => cell.underline !== "none" && cell.underline !== false],
  [5, (cell) => cell.blink],
  [7, (cell) => cell.inverse],
  [8, (cell) => cell.hidden],
  [9, (cell) => cell.strikethrough],
];

function packed(color: Cell["fg"]): number | undefined {
  return color === null ? undefined : (color.r << 16) | (color.g << 8) | color.b;
}

function cellAt(backend: TerminalBackend, row: number, column: number): string {
  const cell = backend.getCell(row, column);
  if (cell.char !== "") {
    return cell.char;
  }
  // xterm marks neither a blank cell nor the one behind a wide glyph, and
  // only the glyph before it tells the two apart.
  return column > 0 && backend.getCell(row, column - 1).wide ? "" : " ";
}

/** Open a screen nobody owns yet. Prefer {@link useTerminalScreen}. */
function openScreen(initial: ReplTerminalSize): TerminalScreen {
  const backend: TerminalBackend = createXtermBackend({
    cols: initial.columns,
    rows: initial.rows,
  });
  let size = initial;
  let closed = false;
  let last: { readonly rows: readonly string[]; readonly buffer: readonly string[] } | undefined;

  const open = (): TerminalBackend => {
    if (closed) {
      throw new Error("this screen has been closed");
    }
    return backend;
  };
  const top = (): number => {
    const scrollback = backend.getScrollback();
    return scrollback.totalRows - scrollback.screenRows;
  };

  return {
    get size() {
      return size;
    },
    get closed() {
      return closed;
    },
    feed(bytes) {
      open().feed(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
    },
    resize(next) {
      size = next;
      open().resize(next.columns, next.rows);
    },
    rows() {
      if (last !== undefined) {
        return [...last.rows];
      }
      return open()
        .getText()
        .split("\n")
        .slice(top(), top() + size.rows);
    },
    buffer() {
      if (last !== undefined) {
        return [...last.buffer];
      }
      return open().getText().split("\n");
    },
    at(column, row) {
      if (column < 0 || column >= size.columns || row < 0 || row >= size.rows) {
        return " ";
      }
      return cellAt(open(), top() + row, column);
    },
    cells() {
      const from = top();
      const grid: string[][] = [];
      for (let row = 0; row < size.rows; row += 1) {
        const line: string[] = [];
        for (let column = 0; column < size.columns; column += 1) {
          line.push(cellAt(open(), from + row, column));
        }
        grid.push(line);
      }
      return grid;
    },
    styleAt(column, row) {
      if (column < 0 || column >= size.columns || row < 0 || row >= size.rows) {
        return { foreground: undefined, background: undefined, attrs: [] };
      }
      const cell = open().getCell(top() + row, column);
      return {
        foreground: packed(cell.fg),
        background: packed(cell.bg),
        attrs: ATTRIBUTES.filter(([, on]) => on(cell)).map(([code]) => code),
      };
    },
    close() {
      if (!closed) {
        last = { rows: this.rows(), buffer: this.buffer() };
        closed = true;
        backend.destroy();
      }
    },
  };
}

/** A screen this scope owns, released when the scope ends however it ends. */
export function useTerminalScreen(size: ReplTerminalSize): Operation<TerminalScreen> {
  return resource(function* (provide) {
    const screen = openScreen(size);
    try {
      yield* provide(screen);
    } finally {
      screen.close();
    }
  });
}

/** Read what some finished output leaves on a fresh screen, and release it. */
export function readScreen<T>(
  size: ReplTerminalSize,
  written: readonly (Uint8Array | string)[],
  read: (screen: TerminalScreen) => T,
): T {
  const screen = openScreen(size);
  try {
    for (const bytes of written) {
      screen.feed(bytes);
    }
    return read(screen);
  } finally {
    screen.close();
  }
}

/** Drop the rows below the last one anything was written on. */
export function usedRows(rows: readonly string[]): string[] {
  let end = rows.length;
  while (end > 0 && rows[end - 1] === "") {
    end -= 1;
  }
  return rows.slice(0, end);
}
