/**
 * The concrete grid an authored `<Terminal.Grid>` derives (spec §6.21).
 *
 * `structural-rules.ts` decides what the source says: which panes were written,
 * in what order, and what is wrong with the way they were written. What it
 * cannot decide is where each pane sits, because that also depends on `columns`
 * — a value the document may compute. This module is where the two meet, once
 * both are known and before anything is opened.
 *
 * A layout is provider-neutral data. It names no terminal, multiplexer, socket,
 * process or window: it says how many columns the author asked for, how many
 * rows that many panes fill, and which cell each pane occupies.
 */

import type { TerminalPane } from "./structural-rules.ts";

/** One pane, placed. */
export interface TerminalGridCell {
  /** The pane's structural identity: its position among the panes, from zero. */
  readonly ordinal: number;
  /** The row it occupies, from zero. */
  readonly row: number;
  /** The column it occupies, from zero. */
  readonly column: number;
  /** The label it displays. Two cells may carry the same one. */
  readonly title: string;
  /** Whether it runs the markdown the pane holds or the host's default shell. */
  readonly form: TerminalPane["form"];
}

/** The complete grid one `<Terminal.Grid>` asked for. */
export interface TerminalGridLayout {
  readonly columns: number;
  /** How many rows those columns take to hold every pane. */
  readonly rows: number;
  /** Every pane, in authored order, which is also row-major order. */
  readonly cells: readonly TerminalGridCell[];
}

/** One pane's placeable facts, once its title has been resolved. */
export interface PlacedPane {
  readonly title: string;
  readonly form: TerminalPane["form"];
}

/**
 * Place the panes across `columns` columns in the order they were authored.
 *
 * Row-major: the first `columns` panes fill the first row, the next fill the
 * second, and a count that does not divide leaves the positions at the end of
 * the last row unused. Nothing is reordered, padded, or balanced — the author's
 * order is the layout, and a pane's ordinal is its identity wherever it lands.
 */
export function terminalGridLayout(
  columns: number,
  panes: readonly PlacedPane[],
): TerminalGridLayout {
  return {
    columns,
    rows: Math.ceil(panes.length / columns),
    cells: panes.map((pane, ordinal) => ({
      ordinal,
      row: Math.floor(ordinal / columns),
      column: ordinal % columns,
      title: pane.title,
      form: pane.form,
    })),
  };
}
