/**
 * The domain actions a live grid offers, and how work inside a cell reaches
 * its own.
 *
 * These are action handles, not resource owners. A handle closes over the live
 * cell it was issued for, so a component calls `launch()` or `shell()` without
 * naming an index or an identifier — and holding one after its grid has closed
 * grants nothing, because admission is the lifecycle's state rather than the
 * handle's.
 *
 * Only the cell UI enters a cell's context. The grid UI does not: showing the
 * grid is the lifecycle's decision, taken once every cell is ready, and a
 * component that could take it would be deciding for its siblings.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";

import type { NativeLaunchOutcome, NativeLaunchRequest } from "./launch.ts";
import type { TerminalShellOutcome } from "./host.ts";
import type { TerminalCellState, TerminalGridState } from "./state.ts";

export interface TerminalCellUI {
  /**
   * This cell's current immutable snapshot.
   *
   * Read each time: a snapshot read earlier never changes, so two reads that
   * straddle a commit are two different objects rather than one that moved.
   */
  readonly state: TerminalCellState;
  /**
   * Hand this cell's terminal to one native UI and wait for it.
   *
   * Refuses after close admission stops, and refuses while another activity is
   * live in this cell. Sequential use is ordinary: the next one is admitted
   * once the prior activity has settled and its cleanup has finished.
   */
  launch(request: NativeLaunchRequest): Operation<NativeLaunchOutcome>;
  /** Start the host's default shell in this cell and wait for it. */
  shell(): Operation<TerminalShellOutcome>;
}

export interface TerminalGridUI {
  readonly state: TerminalGridState;
  /** Every cell's handle, in authored order. */
  readonly cells: readonly TerminalCellUI[];
  /**
   * Commit `visible`, and wait until the provider has presented that exact
   * revision.
   */
  show(): Operation<void>;
}

const CellUI: Context<TerminalCellUI | undefined> = createContext<TerminalCellUI | undefined>(
  "terminal.cellUI",
  undefined,
);

/**
 * The cell the current work is running in, or `undefined` outside a grid.
 *
 * Absence is the ordinary case and means "not in a cell": work outside a grid
 * reads nothing here and goes on competing for the root foreground lease
 * exactly as it always has.
 */
export function useTerminalCellUI(): Operation<TerminalCellUI | undefined> {
  return CellUI.get();
}

/**
 * Install one cell's issued handle for the scope that interprets its work.
 *
 * The handle is installed as it was issued. Wrapping it here would put a
 * second object between the cell's work and the one the lifecycle is tracking,
 * and the refusals and readiness this seam exists to carry are that object's.
 *
 * Set rather than composed: a cell is not a layer over an enclosing cell,
 * because cells do not nest.
 */
export function* installTerminalCellUI(ui: TerminalCellUI): Operation<void> {
  yield* CellUI.set(ui);
}
