/**
 * The terminal's own memory, so a frame can be read back.
 *
 * `@bomb.sh/tty` emits only the cells that changed since the previous frame,
 * which is what makes it cheap and also what makes staleness invisible: a
 * renderer that forgot to redraw something emits nothing for it, and nothing is
 * indistinguishable from correct until you look at the screen. Applying the
 * bytes to a grid here is how the evidence looks at the screen.
 *
 * The vocabulary is deliberately tiny — cursor addressing, colour, and text are
 * everything 0.9.0 emits — and anything else is refused rather than ignored, so
 * a future version that starts scrolling or erasing cannot slip past unnoticed.
 */

export class UnsupportedSequenceError extends Error {
  readonly sequence: string;

  constructor(sequence: string) {
    super(`the harness does not model the terminal sequence ${JSON.stringify(sequence)}`);
    this.name = "UnsupportedSequenceError";
    this.sequence = sequence;
  }
}

export interface Grid {
  readonly cols: number;
  readonly rows: number;
  readonly cells: string[][];
  row: number;
  column: number;
  /**
   * Glyphs addressed at cells this terminal does not have.
   *
   * A real terminal does not discard them: it clamps or wraps them, and what
   * the person sees is corruption. Counting them is how a renderer still
   * drawing at the previous size is caught.
   */
  overflow: number;
}

export function createGrid(cols: number, rows: number): Grid {
  return {
    cols,
    rows,
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => " ")),
    row: 0,
    column: 0,
    overflow: 0,
  };
}

// The escape byte is the thing being parsed here, so matching a control
// character is the point rather than an accident.
// oxlint-disable-next-line no-control-regex
const CSI = /^\u001b\[([0-9;]*)([A-Za-z])/;

export function applyAnsi(grid: Grid, bytes: Uint8Array): Grid {
  const stream = new TextDecoder().decode(bytes);
  let at = 0;
  while (at < stream.length) {
    const glyph = stream[at];
    if (glyph === "\u001b") {
      const match = CSI.exec(stream.slice(at));
      if (!match) {
        throw new UnsupportedSequenceError(stream.slice(at, at + 8));
      }
      const [sequence, parameters, final] = match;
      if (final === "H") {
        const [row, column] = parameters.split(";");
        grid.row = (Number(row) || 1) - 1;
        grid.column = (Number(column) || 1) - 1;
        if (grid.row >= grid.rows || grid.column >= grid.cols) {
          grid.overflow += 1;
        }
      } else if (final !== "m") {
        throw new UnsupportedSequenceError(sequence);
      }
      at += sequence.length;
      continue;
    }
    if (glyph === "\n") {
      grid.row += 1;
      grid.column = 0;
      at += 1;
      continue;
    }
    if (grid.row >= 0 && grid.row < grid.rows && grid.column >= 0 && grid.column < grid.cols) {
      grid.cells[grid.row][grid.column] = glyph;
    } else if (glyph !== " ") {
      grid.overflow += 1;
    }
    grid.column += 1;
    at += 1;
  }
  return grid;
}

/**
 * The part of a larger grid a smaller terminal can still see.
 *
 * After a terminal shrinks, whatever sits beyond its new edges is out of view
 * and no longer anyone's business. What is inside those edges is, which is the
 * region a stale cell would be found in.
 */
export function viewport(grid: Grid, cols: number, rows: number): Grid {
  return {
    cols,
    rows,
    cells: Array.from({ length: rows }, (_unused, row) =>
      Array.from({ length: cols }, (_also, column) => grid.cells[row]?.[column] ?? " "),
    ),
    row: 0,
    column: 0,
    overflow: grid.overflow,
  };
}

/** The grid as a person reads it: one line per row, trailing blanks removed. */
export function gridText(grid: Grid): string {
  return grid.cells.map((row) => row.join("").replace(/ +$/, "")).join("\n");
}

/** Where two grids differ, named by cell, for a failure that has to be readable. */
export function gridDifferences(one: Grid, other: Grid): string[] {
  const differences: string[] = [];
  const rows = Math.max(one.rows, other.rows);
  const cols = Math.max(one.cols, other.cols);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const left = one.cells[row]?.[column] ?? "";
      const right = other.cells[row]?.[column] ?? "";
      if (left !== right) {
        differences.push(`${row},${column}: ${JSON.stringify(left)} ≠ ${JSON.stringify(right)}`);
      }
    }
  }
  return differences;
}
