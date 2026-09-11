/**
 * What a grid currently wants shown.
 *
 * One immutable aggregate, not a delta or a command log. A provider reads a
 * snapshot and makes the screen say that; it never replays the steps that got
 * there. So a later snapshot contains every earlier cell output that is still
 * part of the presentation, and a provider that skipped one has lost nothing.
 *
 * `revision` is live-only and per-grid. It starts at zero, increments exactly
 * once per commit that changes the aggregate, and is never authored, retained,
 * replayed, diagnosed, or placed in a native or Agent request. It exists so a
 * caller can name the state it needs on screen and wait for exactly that.
 */

/** A live grid's monotonic state counter. */
export type TerminalGridRevision = number;

/**
 * One live cell's identity.
 *
 * A symbol, because it is live: minted fresh for each cell of each running
 * grid, never written down, and unforgeable by anything that did not receive
 * it. It keeps a cell handle, its state, the provider's effects and the
 * provider's private endpoint binding together even when positions move. It is
 * not authored, retained, replayed, diagnosed, placed in a native or Agent
 * request, or used as provider identity.
 */
export type TerminalCellId = symbol;

/** What a cell is doing, as the provider observes it. */
export type TerminalCellStatus =
  | "starting"
  | "launching"
  | "running"
  | "succeeded"
  | "failed"
  | "closed";

/** What the grid as a whole is doing. */
export type TerminalGridPhase = "preparing" | "visible" | "closing" | "closed";

export interface TerminalCellState {
  readonly cellId: TerminalCellId;
  /** The label to display. Fixed for the life of the grid. */
  readonly title: string;
  readonly row: number;
  readonly column: number;
  readonly status: TerminalCellStatus;
  /**
   * The complete rendered Markdown display desired for this cell.
   *
   * Not an output event: a later snapshot carries everything earlier snapshots
   * carried. Terminal bytes a native UI or shell exchanges with the reader
   * never enter this state at all.
   */
  readonly content: string;
}

export interface TerminalGridState {
  readonly revision: TerminalGridRevision;
  readonly phase: TerminalGridPhase;
  readonly columns: number;
  readonly rows: number;
  /** Every cell, in authored order. */
  readonly cells: readonly TerminalCellState[];
}
