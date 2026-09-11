/**
 * One grid's private state, and the only way to change it.
 *
 * The store is presentation state, not durability: the journal remains the
 * source of replay and recovery, and nothing here is ever written down. What
 * it owns is the one immutable aggregate a provider renders, the revision that
 * names it, and the serialized lane every change goes through.
 *
 * The lane exists because cells act concurrently. Two cells appending output
 * and a third admitting a launch are three effects running at once, and a
 * store that let their commits interleave would publish a revision describing
 * neither. Each commit therefore runs to completion — compare, increment,
 * publish, notify — before the next one begins.
 *
 * A subscription registers and takes its first snapshot in the same
 * synchronous step. There is deliberately no "read the current state" call to
 * pair with a later subscribe: the gap between those two is exactly where a
 * commit would be lost, and an interface that cannot express the gap cannot
 * have the bug.
 */

import { createChannel, createQueue, ensure, resource, useScope, withResolvers } from "effection";
import type { Operation, Queue, Stream } from "effection";
import { createStore, createThunks, StoreUpdateContext } from "starfx";

import { TerminalGridError } from "./errors.ts";
import type {
  TerminalCellId,
  TerminalCellState,
  TerminalGridRevision,
  TerminalGridState,
} from "./state.ts";

/**
 * A candidate aggregate built from the one in force.
 *
 * It carries no revision decision: whether this is a change at all, and what
 * revision it becomes, belong to the store.
 */
export type GridChange = (current: TerminalGridState) => TerminalGridState;

/** One cell's fixed placement, as the store is seeded with it. */
export interface SeededCell {
  readonly cellId: TerminalCellId;
  readonly title: string;
  readonly row: number;
  readonly column: number;
  /** What this cell starts at: `starting` live, or a restored outcome. */
  readonly status?: TerminalCellState["status"];
}

export interface TerminalGridStoreSeed {
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly SeededCell[];
  /**
   * Where this grid's revision sequence begins.
   *
   * A live grid always begins at zero, partial replay included. The start is a
   * parameter because the refusal at the safe-integer ceiling is otherwise
   * unreachable, and a ceiling nothing can reach is a ceiling nothing has
   * checked.
   */
  readonly startRevision?: TerminalGridRevision;
}

export interface TerminalGridStore {
  /** The aggregate in force. A snapshot read earlier never changes. */
  state(): TerminalGridState;
  /**
   * Every snapshot from this moment on, beginning with the one in force.
   *
   * Registration and that first snapshot happen in one synchronous step, and
   * everything after it has a strictly greater revision.
   */
  readonly states: Stream<TerminalGridState, never>;
  /** Apply one semantic change, serialized against every other. */
  commit(change: GridChange): Operation<TerminalGridState>;
  /**
   * Mint one more blocking controller on this grid's private thunks instance.
   *
   * The returned operation runs the controller synchronously in its caller, so
   * the caller awaits every state transition and host effect the controller
   * owns. Nothing reaches one of these through dispatch.
   */
  controller<P>(
    name: string,
    body: (payload: P) => Operation<void>,
  ): (payload: P) => Operation<void>;
}

/** Where a revision would stop naming exactly one state. */
const REVISION_CEILING = Number.MAX_SAFE_INTEGER;

export function revisionCeilingMessage(revision: TerminalGridRevision): string {
  return (
    `this terminal grid has published revision ${revision} and cannot publish another: a ` +
    `revision past ${REVISION_CEILING} would stop naming exactly one state, so a waiter could ` +
    `be satisfied by a screen it never asked for`
  );
}

type GridStoreState = { grid: TerminalGridState };

function frozenCell(cell: TerminalCellState): TerminalCellState {
  return Object.freeze({
    cellId: cell.cellId,
    title: cell.title,
    row: cell.row,
    column: cell.column,
    status: cell.status,
    content: cell.content,
  });
}

/** One immutable aggregate, built member by member so nothing shares a draft. */
function frozenState(state: TerminalGridState): TerminalGridState {
  return Object.freeze({
    revision: state.revision,
    phase: state.phase,
    columns: state.columns,
    rows: state.rows,
    cells: Object.freeze(state.cells.map(frozenCell)),
  });
}

/**
 * Whether two aggregates describe the same desired presentation.
 *
 * Revision is excluded on purpose: it is what this answer decides.
 */
function sameAggregate(a: TerminalGridState, b: TerminalGridState): boolean {
  if (a.phase !== b.phase || a.columns !== b.columns || a.rows !== b.rows) {
    return false;
  }
  if (a.cells.length !== b.cells.length) {
    return false;
  }
  return a.cells.every((cell, index) => {
    const other = b.cells[index]!;
    return (
      cell.cellId === other.cellId &&
      cell.title === other.title &&
      cell.row === other.row &&
      cell.column === other.column &&
      cell.status === other.status &&
      cell.content === other.content
    );
  });
}

/**
 * The lane every commit runs through.
 *
 * Each entrant waits for the one ahead of it and releases the one behind it
 * from a `finally`, so a caller cancelled while queued hands the lane on
 * rather than stranding everybody behind it.
 */
interface CommitLane {
  run<T>(body: () => Operation<T>): Operation<T>;
}

function createCommitLane(): CommitLane {
  let tail: Operation<void> | undefined;
  return {
    *run<T>(body: () => Operation<T>): Operation<T> {
      const ahead = tail;
      const mine = withResolvers<void>();
      tail = mine.operation;
      try {
        if (ahead !== undefined) {
          yield* ahead;
        }
        return yield* body();
      } finally {
        mine.resolve();
      }
    },
  };
}

function initialState(seed: TerminalGridStoreSeed): TerminalGridState {
  return frozenState({
    revision: seed.startRevision ?? 0,
    phase: "preparing",
    columns: seed.columns,
    rows: seed.rows,
    cells: seed.cells.map((cell) => ({
      cellId: cell.cellId,
      title: cell.title,
      row: cell.row,
      column: cell.column,
      status: cell.status ?? "starting",
      content: "",
    })),
  });
}

/**
 * Open one grid's store in the calling scope.
 *
 * The StarFX store is handed this scope rather than making one of its own, so
 * the grid's contexts, its store and its controllers come down together with
 * the operation that owns them and nothing survives as an independent root.
 */
export function createTerminalGridStore(seed: TerminalGridStoreSeed): Operation<TerminalGridStore> {
  return (function* (): Operation<TerminalGridStore> {
    // A channel of this grid's own. StarFX's default is one module-level
    // channel that every store in the process would otherwise share.
    yield* StoreUpdateContext.set(createChannel<void, void>());

    const scope = yield* useScope();
    let current = initialState(seed);
    const store = createStore<GridStoreState>({ initialState: { grid: current }, scope });

    const subscribers = new Set<Queue<TerminalGridState, never>>();
    const lane = createCommitLane();

    const thunks = createThunks();
    thunks.use(thunks.routes());
    // Registered so the store knows these controllers exist. Nothing is
    // dispatched to them: every caller runs its controller directly, and the
    // supervisors this installs sit waiting for actions that never arrive.
    yield* scope.spawn(thunks.register);

    function* publish(change: GridChange): Operation<void> {
      const candidate = change(current);
      if (sameAggregate(current, candidate)) {
        return;
      }
      if (current.revision >= REVISION_CEILING) {
        throw new TerminalGridError(revisionCeilingMessage(current.revision));
      }
      const next = frozenState({ ...candidate, revision: current.revision + 1 });
      yield* store.update((state) => {
        state.grid = next;
      });
      current = store.getState().grid;
      // Every registered subscriber, in one synchronous pass: a subscriber
      // added while this commit was in flight already holds a snapshot at
      // least this new, because registration takes one.
      for (const queue of subscribers) {
        queue.add(current);
      }
    }

    const commitController = thunks.create<{ readonly change: GridChange }>(
      "terminal.grid.commit",
      function* (ctx, next) {
        yield* publish(ctx.payload.change);
        yield* next();
      },
    );

    const states: Stream<TerminalGridState, never> = resource(function* (provide) {
      const queue = createQueue<TerminalGridState, never>();
      // Registered before anything is: a subscriber halted while it registers
      // must not leave a queue nobody reads being written to forever.
      yield* ensure(() => {
        subscribers.delete(queue);
      });
      subscribers.add(queue);
      queue.add(current);
      yield* provide({ next: () => queue.next() });
    });

    return {
      state: () => current,
      states,
      commit(change) {
        return lane.run(function* (): Operation<TerminalGridState> {
          yield* commitController.run({ change });
          return current;
        });
      },
      controller<P>(name: string, body: (payload: P) => Operation<void>) {
        const created = thunks.create<{ readonly input: P }>(name, function* (ctx, next) {
          yield* body(ctx.payload.input);
          yield* next();
        });
        return (payload: P) =>
          (function* (): Operation<void> {
            yield* created.run({ input: payload });
          })();
      },
    };
  })();
}
