/**
 * What a grid retains, and how the lifecycle reaches a journal it knows
 * nothing about.
 *
 * The neutral package defines this interface and calls it; the host that has a
 * journal implements it with its own source-aware descriptions already closed
 * over. Only provider-neutral layouts, outcomes and lazy operations cross the
 * boundary, so nothing here names a journal type, a coroutine, or a durable
 * record shape.
 *
 * Array position is the durable identity of a cell. No ordinal, index or key
 * duplicates that fact, because a stored one could disagree with the position
 * it sits at.
 */

import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";

import type { TerminalCellForm } from "./layout.ts";
import type { TerminalCellId } from "./state.ts";

/**
 * One retained cell's placement, in authored order.
 *
 * Every retained shape here is `Json`, which is the durable stream's own
 * vocabulary rather than a structural look-alike: a host writes these records
 * straight down, and a type that only resembled JSON would let a value through
 * that no journal could hold. It is the one thing this package takes from
 * anywhere else, and it is a data type — nothing of core, the CLI, a runtime
 * host or a multiplexer crosses this boundary.
 */
export interface RetainedCell extends Record<string, Json> {
  readonly title: string;
  readonly form: TerminalCellForm;
  readonly row: number;
  readonly column: number;
}

/** The provider-neutral layout a grid retains. */
export interface RetainedGridLayout extends Record<string, Json> {
  readonly columns: number;
  readonly rows: number;
  readonly cells: RetainedCell[];
}

/** How a grid ended. */
export type TerminalGridCloseKind = "reader" | "failed";

/** One cell's retained outcome: what it came to, and why when it failed. */
export interface RetainedCellOutcome extends Record<string, Json> {
  readonly status: TerminalCellStatusOutcome;
  readonly reason: string;
}

/** What a cell can have come to, as the journal records it. */
export type TerminalCellStatusOutcome = "succeeded" | "failed" | "closed";

/**
 * What a grid retains: the provider-neutral layout, how it closed, and each
 * cell's outcome in authored order.
 *
 * Nothing here names a provider. No command, socket, path, process identifier,
 * session, window or terminal identifier, no argv or environment, and no
 * terminal byte — none of that describes the document, it describes whichever
 * provider happened to present it, and a resumed run builds a fresh one.
 */
export interface RetainedGrid extends Record<string, Json> {
  readonly layout: RetainedGridLayout;
  readonly close: TerminalGridCloseKind;
  readonly cells: RetainedCellOutcome[];
}

/**
 * One cell's work, as the submitting expansion constructed it.
 *
 * The operation is lazy: constructing it performs no expansion, shell, Agent,
 * provider or journal work at all. The lifecycle interprets it exactly once,
 * inside the durable child derived from its position, with that cell's issued
 * handle and output sink installed.
 */
export interface TerminalCellWork {
  readonly cellId: TerminalCellId;
  readonly operation: Operation<void>;
}

/**
 * The three durable boundaries a grid has.
 *
 * `reconcileLayout()` runs before provider admission, so a resumed run whose
 * resolved layout changed refuses while nothing has been opened and nothing has
 * started. `retainGrid()` may return a completed retained outcome without
 * interpreting its live operation, which is how completed replay creates no
 * live state at all; `retainCell()` does the same for one completed cell.
 */
export interface TerminalGridJournal {
  reconcileLayout(layout: RetainedGridLayout): Operation<void>;
  retainGrid(operation: Operation<RetainedGrid>): Operation<RetainedGrid>;
  retainCell(
    position: number,
    operation: Operation<RetainedCellOutcome>,
  ): Operation<RetainedCellOutcome>;
}

/** What a resolved layout has to say to be retained. */
export interface PlacedGridLayout {
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly {
    readonly title: string;
    readonly form: TerminalCellForm;
    readonly row: number;
    readonly column: number;
  }[];
}

/** The retained shape of one resolved layout. */
export function retainedGridLayout(layout: PlacedGridLayout): RetainedGridLayout {
  return {
    columns: layout.columns,
    rows: layout.rows,
    cells: layout.cells.map((cell) => ({
      title: cell.title,
      form: cell.form,
      row: cell.row,
      column: cell.column,
    })),
  };
}
