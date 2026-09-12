/**
 * The concrete grid an authored terminal grid derives.
 *
 * What the source says — which panes were written, in what order — is decided
 * before anything reaches here. What it cannot say is where each pane sits,
 * because that also depends on a column count the document may compute. This
 * module is where the two meet, once both are known and before anything opens.
 *
 * A layout is provider-neutral data. It names no terminal, multiplexer, socket,
 * process or window: it says how many columns the author asked for, how many
 * rows that many panes fill, and which cell each pane occupies.
 */

/** Whether a pane runs the markdown it holds or the host's default shell. */
export type TerminalPaneForm = "paired" | "self-closing";

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
  readonly form: TerminalPaneForm;
}

/** The complete grid one terminal grid asked for. */
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
  readonly form: TerminalPaneForm;
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
