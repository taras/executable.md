/**
 * The concrete grid an authored terminal grid derives, and the request one
 * expansion submits for it.
 *
 * A layout is provider-neutral data. It names no terminal, multiplexer,
 * socket, process or window: it says how many columns the author asked for,
 * how many rows that many cells fill, and which position each cell occupies.
 *
 * A cell's identity is its position in the ordered array, which is why nothing
 * here carries an ordinal, index or key. Two arrays in authored order say the
 * same thing, and a stored ordinal could disagree with the position it sits at.
 */

/** Whether a cell runs the markdown it holds or the host's default shell. */
export type TerminalCellForm = "paired" | "self-closing";

/** One cell, placed. */
export interface TerminalGridCell {
  /** The row it occupies, from zero. */
  readonly row: number;
  /** The column it occupies, from zero. */
  readonly column: number;
  /** The label it displays. Two cells may carry the same one. */
  readonly title: string;
  readonly form: TerminalCellForm;
}

/** The complete grid one terminal-grid element asked for. */
export interface TerminalGridLayout {
  readonly columns: number;
  /** How many rows those columns take to hold every cell. */
  readonly rows: number;
  /** Every cell, in authored order, which is also row-major order. */
  readonly cells: readonly TerminalGridCell[];
}

/** One cell's placeable facts, once its title has been resolved. */
export interface PlacedCell {
  readonly title: string;
  readonly form: TerminalCellForm;
}

/**
 * Place the cells across `columns` columns in the order they were authored.
 *
 * Row-major: the first `columns` cells fill the first row, the next fill the
 * second, and a count that does not divide leaves the positions at the end of
 * the last row unused. Nothing is reordered, padded, or balanced — the author's
 * order is the layout, and a cell's position is its identity wherever it lands.
 */
export function terminalGridLayout(
  columns: number,
  cells: readonly PlacedCell[],
): TerminalGridLayout {
  return {
    columns,
    rows: Math.ceil(cells.length / columns),
    cells: cells.map((cell, position) => ({
      row: Math.floor(position / columns),
      column: position % columns,
      title: cell.title,
      form: cell.form,
    })),
  };
}

/** One cell the provider is asked to present, by its position in the array. */
export interface TerminalCellRequest {
  /** The label to display. Two cells may carry the same one. */
  readonly title: string;
  /** The row it occupies, from zero. */
  readonly row: number;
  /** The column it occupies, from zero. */
  readonly column: number;
  /**
   * Whether the document supplies this cell's work or the host's default shell
   * does. A provider reads it to know which cells it must start a shell in.
   */
  readonly form: TerminalCellForm;
}

/**
 * The grid one expansion asks for.
 *
 * Provider-neutral throughout: it names no terminal, multiplexer, socket,
 * process, window or cell identifier, and carries no command, argv or
 * environment. It is what the author wrote, resolved.
 *
 * It is also **one-use and identity-bearing**. Core mints exactly one of these
 * per grid expansion and presentation compares the object it is given against
 * the one it issued, so a request that was copied, rebuilt with the same
 * members, kept from an earlier grid, or already used authorizes nothing.
 */
export interface TerminalGridRequest {
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly TerminalCellRequest[];
}

/** The provider-neutral request one derived layout asks for. */
export function terminalGridRequest(layout: TerminalGridLayout): TerminalGridRequest {
  return Object.freeze({
    columns: layout.columns,
    rows: layout.rows,
    cells: Object.freeze(
      layout.cells.map((cell) =>
        Object.freeze({
          title: cell.title,
          row: cell.row,
          column: cell.column,
          form: cell.form,
        }),
      ),
    ),
  });
}
