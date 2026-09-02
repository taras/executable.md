/**
 * The authored grid as explicit tmux geometry.
 *
 * `select-layout tiled` chooses its own column count from the window's
 * dimensions, so it cannot implement an authored `columns`. A layout string
 * can: tmux accepts the same description it prints in `#{window_layout}` —
 * a checksum, then a tree of cells where `{…}` lays children left to right and
 * `[…]` top to bottom, each leaf naming its pane id. Every cell is sized here,
 * row-major from the pane count and `columns`, and tmux is told rather than
 * asked. A final row with fewer panes than columns spans the row: tmux has no
 * empty cells, and the ordinal placement is what the author wrote.
 */

export interface Cell {
  ordinal: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Split `total` into `count` parts with a one-cell separator between them. */
function partition(total: number, count: number): number[] {
  const available = total - (count - 1);
  const base = Math.floor(available / count);
  const extra = available - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

export function rowMajorCells(
  width: number,
  height: number,
  columns: number,
  count: number,
): Cell[] {
  const rows = Math.ceil(count / columns);
  const heights = partition(height, rows);
  const cells: Cell[] = [];
  let top = 0;
  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(columns, count - row * columns);
    const widths = partition(width, inRow);
    let left = 0;
    for (let column = 0; column < inRow; column++) {
      cells.push({
        ordinal: row * columns + column,
        left,
        top,
        width: widths[column],
        height: heights[row],
      });
      left += widths[column] + 1;
    }
    top += heights[row] + 1;
  }
  return cells;
}

/** tmux's `layout_checksum`, so the string is accepted as its own. */
function checksum(layout: string): string {
  let sum = 0;
  for (let index = 0; index < layout.length; index++) {
    sum = ((sum >> 1) + ((sum & 1) << 15)) & 0xffff;
    sum = (sum + layout.charCodeAt(index)) & 0xffff;
  }
  return sum.toString(16).padStart(4, "0");
}

/**
 * The layout string placing `paneIds[i]` at ordinal `i`. Pane ids are the
 * numeric part of tmux's `%N`.
 */
export function layoutString(
  width: number,
  height: number,
  columns: number,
  paneIds: number[],
): string {
  const cells = rowMajorCells(width, height, columns, paneIds.length);
  const rows = Math.ceil(paneIds.length / columns);
  const rowStrings: string[] = [];
  for (let row = 0; row < rows; row++) {
    const inRow = cells.filter((cell) => Math.floor(cell.ordinal / columns) === row);
    const leaves = inRow.map(
      (cell) => `${cell.width}x${cell.height},${cell.left},${cell.top},${paneIds[cell.ordinal]}`,
    );
    if (leaves.length === 1) {
      rowStrings.push(leaves[0]);
    } else {
      const first = inRow[0];
      rowStrings.push(`${width}x${first.height},0,${first.top}{${leaves.join(",")}}`);
    }
  }
  const body =
    rowStrings.length === 1 ? rowStrings[0] : `${width}x${height},0,0[${rowStrings.join(",")}]`;
  return `${checksum(body)},${body}`;
}

/** Whether observed pane geometry is the row-major placement for `columns`. */
export function placementMatches(observed: Cell[], columns: number): string[] {
  const problems: string[] = [];
  const byOrdinal = observed.toSorted((a, b) => a.ordinal - b.ordinal);
  for (const cell of byOrdinal) {
    const row = Math.floor(cell.ordinal / columns);
    const column = cell.ordinal % columns;
    const above = byOrdinal.find((other) => other.ordinal === cell.ordinal - columns);
    const leftOf =
      column > 0 ? byOrdinal.find((other) => other.ordinal === cell.ordinal - 1) : undefined;
    if (above && !(cell.top > above.top && cell.top === above.top + above.height + 1)) {
      problems.push(
        `pane ${cell.ordinal} is not directly below pane ${above.ordinal} (row ${row})`,
      );
    }
    if (leftOf && !(cell.left === leftOf.left + leftOf.width + 1 && cell.top === leftOf.top)) {
      problems.push(`pane ${cell.ordinal} is not directly right of pane ${leftOf.ordinal}`);
    }
    if (column === 0 && cell.left !== 0) {
      problems.push(`pane ${cell.ordinal} should start a row at the left edge`);
    }
  }
  return problems;
}
