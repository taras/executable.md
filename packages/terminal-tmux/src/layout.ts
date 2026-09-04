/**
 * The authored grid as explicit tmux geometry
 * (architecture.md §Interactive terminal grids).
 *
 * `select-layout tiled` picks its own column count from the window's
 * dimensions, so it cannot implement a `columns` the author wrote: the same
 * four panes become 2×2 in one terminal and 4×1 in another. A layout string
 * can. tmux accepts the same description it prints in `#{window_layout}` — a
 * checksum, then a tree of cells where `{…}` lays children left to right and
 * `[…]` top to bottom, each leaf naming a pane id.
 *
 * So every cell is sized here, row-major from the pane count and `columns`, and
 * tmux is told rather than asked. A final row with fewer panes than columns
 * spans the row, because tmux has no empty cells and the author wrote panes
 * rather than a rectangle.
 *
 * One thing the string cannot do is place a *particular* pane: tmux fills the
 * leaves in window-list order and ignores the pane ids they name. Authored
 * order is imposed afterwards, by swapping panes into position — which is why
 * `swapsInto()` lives here beside the geometry rather than in the provider.
 */

/** One pane's rectangle, in tmux's character coordinates. */
export interface LayoutCell {
  readonly ordinal: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Split `total` into `count` parts, leaving one column or row between them for
 * tmux's separator. The remainder goes to the leftmost or topmost parts, which
 * is what tmux itself does.
 */
function partition(total: number, count: number): number[] {
  const available = total - (count - 1);
  const base = Math.floor(available / count);
  const extra = available - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

/** The row-major rectangles for `count` panes in `columns` columns. */
export function rowMajorCells(
  width: number,
  height: number,
  columns: number,
  count: number,
): readonly LayoutCell[] {
  const rows = Math.ceil(count / columns);
  const heights = partition(height, rows);
  const cells: LayoutCell[] = [];
  let top = 0;
  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(columns, count - row * columns);
    const widths = partition(width, inRow);
    const rowHeight = heights[row] ?? 0;
    let left = 0;
    for (let column = 0; column < inRow; column++) {
      const cellWidth = widths[column] ?? 0;
      cells.push({
        ordinal: row * columns + column,
        left,
        top,
        width: cellWidth,
        height: rowHeight,
      });
      left += cellWidth + 1;
    }
    top += rowHeight + 1;
  }
  return cells;
}

/** tmux's `layout_checksum`, so the string is accepted as one of its own. */
function checksum(layout: string): string {
  let sum = 0;
  for (let index = 0; index < layout.length; index++) {
    sum = ((sum >> 1) + ((sum & 1) << 15)) & 0xffff;
    sum = (sum + layout.charCodeAt(index)) & 0xffff;
  }
  return sum.toString(16).padStart(4, "0");
}

/**
 * The layout string that gives ordinal `i` the cell `paneIds[i]` names.
 *
 * Pane ids are the numeric part of tmux's `%N`. tmux ignores which pane each
 * leaf names — see `swapsInto()` — but the string still has to name real ones
 * for tmux to accept it.
 */
export function layoutString(
  width: number,
  height: number,
  columns: number,
  paneIds: readonly number[],
): string {
  const cells = rowMajorCells(width, height, columns, paneIds.length);
  const rows = Math.ceil(paneIds.length / columns);
  const rowStrings: string[] = [];
  for (let row = 0; row < rows; row++) {
    const inRow = cells.filter((cell) => Math.floor(cell.ordinal / columns) === row);
    const leaves = inRow.map(
      (cell) => `${cell.width}x${cell.height},${cell.left},${cell.top},${paneIds[cell.ordinal]}`,
    );
    const first = inRow[0];
    if (first === undefined) {
      continue;
    }
    rowStrings.push(
      leaves.length === 1
        ? (leaves[0] ?? "")
        : `${width}x${first.height},0,${first.top}{${leaves.join(",")}}`,
    );
  }
  const body =
    rowStrings.length === 1
      ? (rowStrings[0] ?? "")
      : `${width}x${height},0,0[${rowStrings.join(",")}]`;
  return `${checksum(body)},${body}`;
}

/** One swap: put the pane now at `from` into the position `to` holds. */
export interface PaneSwap {
  readonly from: number;
  readonly to: number;
}

/**
 * The swaps that turn tmux's window order into the authored one.
 *
 * `present[i]` is the pane id tmux currently has in position `i`; `wanted[i]` is
 * the pane id ordinal `i` was authored for. Selection sort, because each swap
 * exchanges two positions and there is no cheaper honest way to say it: the
 * result is the shortest sequence that leaves every position holding the pane
 * the author put there.
 *
 * An already-correct order produces no swaps at all, which is the case a
 * provider must not do work for.
 */
export function swapsInto(
  present: readonly number[],
  wanted: readonly number[],
): readonly PaneSwap[] {
  const order = [...present];
  const swaps: PaneSwap[] = [];
  for (let position = 0; position < wanted.length; position++) {
    const target = wanted[position];
    if (target === undefined || order[position] === target) {
      continue;
    }
    const found = order.indexOf(target, position);
    if (found === -1) {
      // The window does not hold the pane this ordinal was authored for, so no
      // sequence of swaps produces the authored order. Saying so is the honest
      // answer; swapping anyway would place a pane the author did not write.
      throw new Error(`pane ${target} is not in this window, so ordinal ${position} cannot be set`);
    }
    const displaced = order[position];
    if (displaced === undefined) {
      continue;
    }
    order[position] = target;
    order[found] = displaced;
    swaps.push({ from: found, to: position });
  }
  return swaps;
}

/** Whether observed geometry is the row-major placement `columns` describes. */
export function placementProblems(
  observed: readonly LayoutCell[],
  columns: number,
): readonly string[] {
  const problems: string[] = [];
  const byOrdinal = [...observed].sort((left, right) => left.ordinal - right.ordinal);
  for (const cell of byOrdinal) {
    const column = cell.ordinal % columns;
    const above = byOrdinal.find((other) => other.ordinal === cell.ordinal - columns);
    const leftOf =
      column > 0 ? byOrdinal.find((other) => other.ordinal === cell.ordinal - 1) : undefined;
    if (above !== undefined && cell.top !== above.top + above.height + 1) {
      problems.push(`pane ${cell.ordinal} is not directly below pane ${above.ordinal}`);
    }
    if (
      leftOf !== undefined &&
      !(cell.left === leftOf.left + leftOf.width + 1 && cell.top === leftOf.top)
    ) {
      problems.push(`pane ${cell.ordinal} is not directly right of pane ${leftOf.ordinal}`);
    }
    if (column === 0 && cell.left !== 0) {
      problems.push(`pane ${cell.ordinal} should start a row at the left edge`);
    }
  }
  return problems;
}
