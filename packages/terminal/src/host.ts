/**
 * What a provider supplies, and what the grid can ask of it.
 *
 * The provider draws a grid and nothing else decides: it observes the desired
 * state, converges the screen to it, hands one cell's terminal to a child, and
 * says when the reader left or when its own machinery failed. It cannot settle
 * a grid by returning, close one by calling something, or change a state it
 * was shown.
 */

import type { Operation, Stream } from "effection";

import type { NativeLaunchOutcome, NativeLaunchRequest } from "./launch.ts";
import type { TerminalGridRequest } from "./layout.ts";
import type { TerminalCellId, TerminalGridRevision, TerminalGridState } from "./state.ts";

/** How a cell's default shell ended. */
export interface TerminalShellOutcome {
  exitCode?: number;
  signal?: string;
}

/**
 * One terminal activity: something interactive a cell runs.
 *
 * A resource, and the acquisition is the whole point. Preparing a child and
 * spawning it happen before the value exists, so a provider that could not
 * start one never yields — and the cell it belongs to never becomes ready.
 * Acquiring it means the child is running; the value acquired is the operation
 * that settles with how that child ended; releasing it kills and reaps
 * whatever is left.
 *
 * A child that starts and exits immediately is therefore both ready and
 * settled. Allocating a process identifier and receiving first output are not
 * acquisition.
 */
export type TerminalActivity<T> = Operation<Operation<T>>;

/**
 * The provider's only window onto the grid.
 *
 * Starting a subscription atomically registers it and enqueues the current
 * snapshot, then delivers only strictly newer revisions. There is no separate
 * "read the current state" operation to combine with a later subscription,
 * because the gap between those two is exactly where a commit would be lost.
 */
export interface TerminalGridView {
  readonly states: Stream<TerminalGridState, never>;
}

/**
 * One provider's realization of one complete grid.
 *
 * Supplied as a resource, so acquiring it is the provider grid coming into
 * existence and releasing it is the grid going away — exactly once, whether
 * the grid succeeded, failed to start, was closed by the reader, was failed by
 * the provider, or was cancelled. There is no destroy to call and no way to
 * call one twice.
 */
export interface TerminalGridHost {
  /** Settles when the reader closes or leaves the grid. */
  readonly closed: Operation<void>;
  /**
   * Settles with the provider's own error when its background work fails.
   *
   * Independent of `closed`, and observed for the host's whole acquired
   * lifetime: a renderer that died while no action was waiting on it may not
   * stay hidden until something happens to call the provider again.
   */
  readonly failed: Operation<Error>;
  /**
   * Converge through `requiredRevision` and then present the prepared grid,
   * atomically. Called once, and only after every cell is ready.
   */
  show(requiredRevision: TerminalGridRevision): Operation<void>;
  /**
   * Settle once a complete snapshot with a revision of at least
   * `requiredRevision` has been fully applied.
   *
   * A later revision satisfies an earlier requirement, because the aggregate
   * subsumes everything before it.
   */
  converge(requiredRevision: TerminalGridRevision): Operation<void>;
  /** Hand one live cell's terminal to the exact native request. */
  launch(
    cellId: TerminalCellId,
    request: NativeLaunchRequest,
  ): TerminalActivity<NativeLaunchOutcome>;
  /** Start the host's default interactive shell in one live cell. */
  shell(cellId: TerminalCellId): TerminalActivity<TerminalShellOutcome>;
}

/**
 * What a registered provider is: something that can realize one request.
 *
 * A provider object is implementation, not authority. It cannot present
 * another request, choose another installation generation, mutate state, or
 * settle the grid by what it returns.
 */
export interface TerminalGridProvider {
  host(request: TerminalGridRequest, view: TerminalGridView): Operation<TerminalGridHost>;
}

/**
 * What a registered provider is handed, and the only way to present.
 *
 * Delivered directly to the provider factory as it installs, and reachable
 * nowhere else: it does not travel through a context, a request, a result, a
 * prop, a binding or a durable record. Presenting the exact request core
 * issued is what runs the grid; anything else authorizes nothing.
 */
export type PresentTerminalGrid = (
  request: TerminalGridRequest,
  provider: TerminalGridProvider,
) => Operation<void>;
