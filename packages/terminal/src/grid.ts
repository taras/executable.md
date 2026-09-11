/**
 * One terminal grid, from the lease to the last finalizer.
 *
 * Opening a grid is atomic from the reader's side, and that is the whole shape
 * of this module. The grid is built while it is still hidden, every cell
 * starts concurrently, and only once all of them have actually started does
 * anything appear. A failure before that barrier releases the hidden grid
 * instead of leaving half a grid on the screen.
 *
 * ```
 * layout reconciled → lease → flush → routed to a provider → admitted
 *   → store and provider host → cells start → readiness barrier → show
 *   → cells settle independently → reader closes → teardown → lease released
 * ```
 *
 * Nothing owns a grid but the expansion that submitted it. `terminalGrid()` is
 * a resource whose task is the whole grid: releasing it early cancels that
 * task and waits for the same complete teardown, and there is no registry,
 * supervisor or execution-wide owner that could keep one running after the
 * work that asked for it has gone.
 */

import {
  all,
  createScope,
  Err,
  ensure,
  Ok,
  race,
  resource,
  scoped,
  spawn,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Task } from "effection";

import { TerminalGridError, TerminalGridPresentationError } from "./errors.ts";
import type {
  PresentTerminalGrid,
  TerminalActivity,
  TerminalGridHost,
  TerminalGridProvider,
  TerminalShellOutcome,
} from "./host.ts";
import { flushOutput, reserveTerminal } from "./launch.ts";
import type { NativeLaunchOutcome, NativeLaunchRequest } from "./launch.ts";
import { terminalGridRequest } from "./layout.ts";
import type { TerminalGridLayout, TerminalGridRequest } from "./layout.ts";
import { retainedGridLayout } from "./journal.ts";
import type {
  RetainedCellOutcome,
  RetainedGrid,
  TerminalCellWork,
  TerminalGridJournal,
} from "./journal.ts";
import { installTerminalCellOutput } from "./output.ts";
import { terminalInstallation } from "./presentation.ts";
import type { IssuedGrid } from "./presentation.ts";
import { TerminalGrids } from "./routing.ts";
import { createTerminalGridStore } from "./store.ts";
import type { TerminalGridStore } from "./store.ts";
import type {
  TerminalCellId,
  TerminalCellState,
  TerminalCellStatus,
  TerminalGridPhase,
  TerminalGridState,
} from "./state.ts";
import { installTerminalCellUI } from "./ui.ts";
import type { TerminalCellUI, TerminalGridUI } from "./ui.ts";

export function noProviderMessage(): string {
  return (
    "no terminal provider opened this grid — a handler answered without delivering the " +
    "request to a registered provider"
  );
}

export function outsideExecutionMessage(): string {
  return (
    "a terminal grid is available only inside a document execution with an installed " +
    "terminal provider — a grid outside one retains nothing and could not be resumed"
  );
}

/**
 * What a cell that never acquired a terminal activity says.
 *
 * A cell whose work finished without ever starting something interactive has
 * not started: presenting it as a running cell would be presenting a grid the
 * reader cannot use.
 */
export function cellNeverStartedMessage(position: number, title: string): string {
  return (
    `terminal ${position} ("${title}") finished without starting anything interactive, so the ` +
    `grid never opened. A terminal cell runs an interactive child — a <Session.Launch>, or the ` +
    `default shell a self-closing terminal starts.`
  );
}

export function cellClosedMessage(position: number, title: string): string {
  return (
    `terminal ${position} ("${title}") is closed: its grid has stopped admitting terminal ` +
    `activities`
  );
}

export function cellBusyMessage(position: number, title: string): string {
  return (
    `terminal ${position} ("${title}") already has a live terminal activity — one owns a cell ` +
    `terminal at a time`
  );
}

/**
 * Run one grid beneath the operation that submitted it.
 *
 * The returned task is the grid. Awaiting it is how the caller learns what the
 * grid retained; releasing the resource before that cancels it and waits for
 * every cell, renderer, host finalizer and the lease.
 */
export function terminalGrid(
  layout: TerminalGridLayout,
  cells: readonly TerminalCellWork[],
  journal: TerminalGridJournal,
): Operation<Task<RetainedGrid>> {
  // Written as an operation the caller delegates into rather than with
  // `resource()`, because where the deferral finalizer is *registered* decides
  // whether it works. A resource body is a task of its own, and a finalizer
  // registered inside one unwinds with that task rather than beside the
  // detached scope it has to outlive — which lets a cancellation reach the
  // grid's durable child before the owner has finished it, and turns a
  // completed reader close into a cancelled record a later run would have to
  // revive. Delegating puts both on the caller's own frame, in the order they
  // were written. Cleanup is still scope-bound, so this is a resource in every
  // sense the caller can observe.
  return {
    *[Symbol.iterator]() {
      // Checked before anything exists. A layout that disagrees with its cell
      // work is the caller's mistake rather than something a grid came to, so
      // it refuses at acquisition and no scope, store or provider is reached.
      validateCellWork(layout, cells);

      const close = createCloseHandshake();
      // The grid runs in a scope of its own — a child of this one, so it inherits
      // every context the document runs under, and its own so that tearing this
      // one down does not reach the grid first. That ordering is what makes the
      // finalizer below genuinely deferred once close has been acknowledged: the
      // grid and its cells finish their own teardown and append their ordinary
      // completed records, and only then does a pending cancellation carry on to
      // the parent.
      //
      // A scope rather than an ordinary spawn for a second reason: how a grid
      // ended is the caller's answer to read. A spawned task that fails takes its
      // host scope down with it, which would unwind the expansion before it could
      // account for the failure.
      const [detached, destroy] = createScope(yield* useScope());
      const held: { task?: Task<RetainedGrid>; outcome?: Result<RetainedGrid> } = {};

      // Registered after the scope and before the task, so a cancellation runs it
      // and waits for it. Before the boundary is crossed there is nothing to
      // finish, and destroying the scope cancels the active grid under the
      // ordinary rules.
      yield* ensure(function* () {
        if (held.task !== undefined && close.acknowledged && held.outcome === undefined) {
          held.outcome = yield* settle(held.task);
        }
        yield* until(destroy());
      });

      held.task = detached.run(() => runGrid(layout, cells, journal, close));
      // The owner acknowledges, and only the owner. By the time it can, the
      // finalizer above is already registered — so crossing the boundary and
      // being committed to finishing the child are the same moment.
      yield* spawn(function* () {
        yield* close.proposed();
        close.acknowledge();
      });

      return held.task;
    },
  };
}

/**
 * The live boundary reader close crosses.
 *
 * The provider settling `closed` only *proposes* the boundary. It is crossed
 * when the owner awaiting the grid's durable child acknowledges that proposal
 * from inside its own cancellation-deferred await — and only then may the grid
 * close admission and ask its cells to close.
 *
 * Nothing here is journaled and nothing here names a provider: it is one live
 * rendezvous between a durable child and the owner waiting on it. What it buys
 * is the ordering the contract needs — a cancellation arriving before the
 * acknowledgement cancels the active grid, and one arriving after it waits for
 * the grid to finish closing.
 */
interface CloseHandshake {
  /** The child: publish the proposal and wait for it to be acknowledged. */
  propose(): Operation<void>;
  /** The owner: settle once close has been proposed. */
  proposed(): Operation<void>;
  /** The owner: cross the boundary. */
  acknowledge(): void;
  /** Whether the boundary has been crossed. */
  readonly acknowledged: boolean;
}

function createCloseHandshake(): CloseHandshake {
  const proposal = withResolvers<void>();
  const acknowledgement = withResolvers<void>();
  let crossed = false;
  return {
    *propose() {
      proposal.resolve();
      yield* acknowledgement.operation;
    },
    proposed: () => proposal.operation,
    acknowledge() {
      if (crossed) {
        return;
      }
      crossed = true;
      acknowledgement.resolve();
    },
    get acknowledged() {
      return crossed;
    },
  };
}

/**
 * Reconcile the layout, then run the grid as one durable child of the
 * submitting expansion.
 */
function runGrid(
  layout: TerminalGridLayout,
  cells: readonly TerminalCellWork[],
  journal: TerminalGridJournal,
  close: CloseHandshake,
): Operation<RetainedGrid> {
  return (function* (): Operation<RetainedGrid> {
    // Before the lease and before any provider is contacted: a resumed run
    // whose resolved layout changed refuses while nothing has been opened.
    yield* journal.reconcileLayout(retainedGridLayout(layout));
    return yield* journal.retainGrid(liveGrid(layout, cells, journal, close));
  })();
}

function* settle<T>(task: Task<T>): Operation<Result<T>> {
  try {
    return Ok(yield* task);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

function validateCellWork(layout: TerminalGridLayout, cells: readonly TerminalCellWork[]): void {
  if (layout.cells.length === 0) {
    throw new TerminalGridError("a terminal grid layout places no cells");
  }
  if (cells.length !== layout.cells.length) {
    throw new TerminalGridError(
      `a terminal grid layout places ${layout.cells.length} cells and was given ` +
        `${cells.length} cell operations: ordered array position is a cell's identity, so the ` +
        `two must agree`,
    );
  }
  const identities = new Set(cells.map((cell) => cell.cellId));
  if (identities.size !== cells.length) {
    throw new TerminalGridError(
      "a terminal grid was given the same live cell identity twice: one fresh identity is " +
        "minted per authored position",
    );
  }
}

/**
 * Take the lease, issue the request, and read what presentation settled.
 *
 * The routed answer is discarded on purpose: a handler that short-circuits or
 * fabricates a return has presented nothing, and this says so rather than
 * letting the document believe a grid opened.
 */
function liveGrid(
  layout: TerminalGridLayout,
  cells: readonly TerminalCellWork[],
  journal: TerminalGridJournal,
  close: CloseHandshake,
): Operation<RetainedGrid> {
  return scoped(function* (): Operation<RetainedGrid> {
    const installation = yield* terminalInstallation();
    if (installation === undefined) {
      throw new TerminalGridPresentationError(outsideExecutionMessage());
    }

    const request = terminalGridRequest(layout);
    let settled: RetainedGrid | undefined;

    // Issued, not started. The lookup holds the request and this work until a
    // provider presents a grid for this exact object; the grid then runs
    // beneath this operation's own scope.
    const issued: IssuedGrid = {
      request,
      generation: installation.generation,
      used: false,
      *run(provider) {
        settled = yield* runPresented(request, cells, journal, provider, close);
      },
    };
    installation.grids.add(issued);
    yield* ensure(() => {
      installation.grids.delete(issued);
    });

    // The one foreground-terminal lease, taken before any provider is asked
    // for anything. A root native launch and a grid contend for exactly this.
    yield* reserveTerminal();
    // Everything the document has produced so far reaches the reader before
    // the grid covers it up.
    yield* flushOutput();

    yield* TerminalGrids.operations.open(request);

    if (settled === undefined) {
      throw new TerminalGridPresentationError(noProviderMessage());
    }
    return settled;
  });
}

/** One cell's live bookkeeping. Private, and never a second capability model. */
interface CellRuntime {
  readonly position: number;
  readonly cellId: TerminalCellId;
  readonly title: string;
  /** Whether this cell has ever acquired a terminal activity, or was restored. */
  ready: boolean;
  /** Whether one terminal activity is live in this cell right now. */
  busy: boolean;
  outcome?: RetainedCellOutcome;
}

function runPresented(
  request: TerminalGridRequest,
  cells: readonly TerminalCellWork[],
  journal: TerminalGridJournal,
  provider: TerminalGridProvider,
  close: CloseHandshake,
): Operation<RetainedGrid> {
  return scoped(function* (): Operation<RetainedGrid> {
    const runtimes: CellRuntime[] = cells.map((work, position) => ({
      position,
      cellId: work.cellId,
      title: request.cells[position]!.title,
      ready: false,
      busy: false,
    }));

    const store = yield* createTerminalGridStore({
      columns: request.columns,
      rows: request.rows,
      cells: runtimes.map((runtime) => ({
        cellId: runtime.cellId,
        title: runtime.title,
        row: request.cells[runtime.position]!.row,
        column: request.cells[runtime.position]!.column,
      })),
    });

    // Registered before the host is acquired, so it runs after the host has
    // been released and the root terminal restored — which is the only moment
    // at which `closed` is the whole truth about this grid.
    yield* ensure(function* () {
      yield* publishClosedPhase(store);
    });

    const host = yield* provider.host(request, { states: store.states });

    // Independent of reader close, and observed for the host's whole acquired
    // lifetime: a renderer that died while no action was waiting on it may not
    // stay hidden until something happens to call the provider again. Spawned
    // after acquisition, so it comes down before the host is released and an
    // ordinary release settles nothing as a false event.
    yield* spawn(function* (): Operation<never> {
      throw yield* host.failed;
    });

    let admitting = true;
    let shown = false;
    const closing = withResolvers<void>();
    const readiness = runtimes.map(() => withResolvers<void>());
    const startupFailed = withResolvers<never>();

    // Nothing new is admitted once teardown begins, so a cell that was about
    // to start a terminal activity is refused rather than racing the close.
    yield* ensure(() => {
      admitting = false;
    });

    const markReady = (runtime: CellRuntime): void => {
      if (runtime.ready) {
        return;
      }
      runtime.ready = true;
      readiness[runtime.position]!.resolve();
    };

    const performActivity = function* <T>(
      runtime: CellRuntime,
      start: () => TerminalActivity<T>,
    ): Operation<T> {
      if (!admitting) {
        throw new TerminalGridPresentationError(cellClosedMessage(runtime.position, runtime.title));
      }
      if (runtime.busy) {
        throw new TerminalGridPresentationError(cellBusyMessage(runtime.position, runtime.title));
      }
      runtime.busy = true;
      try {
        // Admitted, and the revision that includes every causally prior output
        // of this cell captured with it.
        const admitted = yield* store.commit((state) =>
          withCellStatus(state, runtime.cellId, "launching"),
        );
        // Nothing of the provider's is called until the screen it will draw on
        // is the screen this action asked for. A cancellation here therefore
        // makes no child call and establishes no readiness.
        yield* host.converge(admitted.revision);
        return yield* scoped(function* (): Operation<T> {
          // Acquisition happens only once the child has actually spawned, and
          // acquiring it *is* the cell becoming ready.
          const outcome = yield* start();
          yield* store.commit((state) => withCellStatus(state, runtime.cellId, "running"));
          markReady(runtime);
          return yield* outcome;
        });
      } finally {
        // The activity's own cleanup has been awaited by the scope above, so
        // the next activity is admitted only after this one is quiescent.
        runtime.busy = false;
      }
    };

    interface LaunchRun {
      readonly runtime: CellRuntime;
      readonly request: NativeLaunchRequest;
      outcome?: NativeLaunchOutcome;
    }
    interface ShellRun {
      readonly runtime: CellRuntime;
      outcome?: TerminalShellOutcome;
    }

    const launchController = store.controller<LaunchRun>("terminal.cell.launch", function* (run) {
      run.outcome = yield* performActivity(run.runtime, () =>
        host.launch(run.runtime.cellId, run.request),
      );
    });
    const shellController = store.controller<ShellRun>("terminal.cell.shell", function* (run) {
      run.outcome = yield* performActivity(run.runtime, () => host.shell(run.runtime.cellId));
    });
    const showController = store.controller<Record<string, never>>(
      "terminal.grid.show",
      function* () {
        const visible = yield* store.commit((state) => withPhase(state, "visible"));
        yield* host.show(visible.revision);
      },
    );

    const cellHandles: TerminalCellUI[] = runtimes.map((runtime) => ({
      get state(): TerminalCellState {
        return store.state().cells[runtime.position]!;
      },
      *launch(nativeRequest: NativeLaunchRequest): Operation<NativeLaunchOutcome> {
        const run: LaunchRun = { runtime, request: nativeRequest };
        yield* launchController(run);
        return run.outcome ?? {};
      },
      *shell(): Operation<TerminalShellOutcome> {
        const run: ShellRun = { runtime };
        yield* shellController(run);
        return run.outcome ?? {};
      },
    }));

    const ui: TerminalGridUI = {
      get state(): TerminalGridState {
        return store.state();
      },
      cells: cellHandles,
      show: () => showController({}),
    };

    const appendOutput = (runtime: CellRuntime) =>
      function* (text: string): Operation<void> {
        yield* store.commit((state) => withCellContent(state, runtime.cellId, text));
      };

    const children: Task<RetainedCellOutcome>[] = [];
    for (const [position, work] of cells.entries()) {
      const runtime = runtimes[position]!;
      children.push(
        yield* spawn(() =>
          journal.retainCell(
            position,
            cellOutcome(
              runtime,
              work,
              ui.cells[position]!,
              appendOutput(runtime),
              closing.operation,
            ),
          ),
        ),
      );
    }

    // Observing each child is what turns a cell's outcome — replayed or live —
    // into a published status and a cell the barrier counts as started.
    for (const [position, child] of children.entries()) {
      const runtime = runtimes[position]!;
      yield* spawn(function* () {
        const outcome = yield* child;
        runtime.outcome = outcome;
        // A cell restored from its retained outcome satisfies the barrier
        // without acquiring anything: it did start, on the run that recorded it.
        markReady(runtime);
        yield* store.commit((state) => withCellStatus(state, runtime.cellId, outcome.status));
        if (outcome.status === "failed" && !shown) {
          // Before the barrier a cell failure is the whole grid's: nothing has
          // been shown, so the grid fails closed rather than showing what is
          // left. After it, the failure is this cell's status alone.
          startupFailed.reject(new Error(outcome.reason));
        }
      });
    }

    // Every cell must actually have started before anything is shown. Racing
    // the barrier against startup failure is what stops a grid whose cell
    // already failed from waiting forever for an acquisition that cannot happen.
    try {
      yield* race([all(readiness.map((gate) => gate.operation)), startupFailed.operation]);
    } catch {
      // Simultaneous startup failures are selected by authored position, not by
      // whichever rejected the race first.
      throw new TerminalGridError(firstReason(runtimes) ?? "a terminal grid cell failed to start");
    }

    yield* ui.show();
    shown = true;

    // The grid stays visible after its cells settle. The reader leaving is
    // what finishes the grid, not the last cell exiting.
    yield* host.closed;

    // Proposed, then acknowledged by the owner from inside its own
    // cancellation-deferred await. Until it is crossed, a cancellation cancels
    // the active grid under the ordinary rules; once crossed, the close result
    // is committed first and the cancellation waits for it.
    yield* close.propose();

    admitting = false;
    yield* store.commit((state) => withPhase(state, "closing"));
    closing.resolve();
    // Published before anything is awaited: once the reader has left, a cell
    // that had not settled is closed, and that is true whether or not its own
    // finalizers are quick about it.
    for (const runtime of runtimes) {
      if (runtime.outcome === undefined) {
        yield* store.commit((state) => withCellStatus(state, runtime.cellId, "closed"));
      }
    }
    for (const [position, child] of children.entries()) {
      // Awaited, not halted. Each cell settles on the close signal and records
      // the outcome it reached, which is what a resumed run reads.
      const outcome = yield* child;
      runtimes[position]!.outcome ??= outcome;
    }

    const outcomes = runtimes.map((runtime) => runtime.outcome ?? closedOutcome());
    const reason = firstReason(runtimes);
    return {
      layout: retainedGridLayout({
        columns: request.columns,
        rows: request.rows,
        cells: request.cells.map((cell) => ({
          title: cell.title,
          form: cell.form,
          row: cell.row,
          column: cell.column,
        })),
      }),
      close: reason === undefined ? "reader" : "failed",
      cells: outcomes,
    };
  });
}

/**
 * Publish `closed`, once the host has gone and the root terminal is back.
 *
 * Cleanup enforces quiescence; it does not decide outcomes. A commit that
 * cannot happen here — a grid already at its revision ceiling, a store whose
 * scope is coming down — must not replace the result the grid already reached.
 */
function* publishClosedPhase(store: TerminalGridStore): Operation<void> {
  try {
    yield* store.commit((state) => withPhase(state, "closed"));
  } catch {
    // The phase is live display state. Nothing reads it after this point, and
    // the outcome this grid settled on is already decided.
  }
}

/** Run one cell's work and say what it came to. */
function cellOutcome(
  runtime: CellRuntime,
  work: TerminalCellWork,
  handle: TerminalCellUI,
  append: (text: string) => Operation<void>,
  closing: Operation<void>,
): Operation<RetainedCellOutcome> {
  return (function* (): Operation<RetainedCellOutcome> {
    try {
      // The cell's work runs beside the close signal rather than under it.
      // When the reader leaves, this settles as `closed` straight away and the
      // work comes down in the enclosing scope's own teardown — so a cell whose
      // finalizers are slow cannot hold up the outcome the grid already knows,
      // and the record a resumed run reads is written either way.
      const running = yield* spawn(() => interpretCell(work, handle, append));
      const closed = yield* race([
        (function* (): Operation<boolean> {
          yield* running;
          return false;
        })(),
        (function* (): Operation<boolean> {
          yield* closing;
          return true;
        })(),
      ]);
      if (closed) {
        // The nested work is stopped by this cell's own scope, and its
        // finalizers are awaited here: the durable child settles as closed only
        // once that work and its finalizers have settled.
        yield* running.halt();
        return { status: "closed", reason: "" };
      }
      if (!runtime.ready) {
        // Settled without ever starting: a startup failure even though the work
        // itself raised nothing.
        return {
          status: "failed",
          reason: cellNeverStartedMessage(runtime.position, runtime.title),
        };
      }
      return { status: "succeeded", reason: "" };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })();
}

/** Interpret one cell's lazy operation exactly once, under its issued handle. */
function interpretCell(
  work: TerminalCellWork,
  handle: TerminalCellUI,
  append: (text: string) => Operation<void>,
): Operation<void> {
  return scoped(function* () {
    yield* installTerminalCellUI(handle);
    yield* installTerminalCellOutput(append);
    yield* work.operation;
  });
}

/** The first failed cell's sentence in authored order, which is the grid's. */
function firstReason(runtimes: readonly CellRuntime[]): string | undefined {
  return runtimes.find((runtime) => runtime.outcome?.status === "failed")?.outcome?.reason;
}

/** What a cell the reader closed came to. */
function closedOutcome(): RetainedCellOutcome {
  return { status: "closed", reason: "" };
}

function withPhase(state: TerminalGridState, phase: TerminalGridPhase): TerminalGridState {
  return { ...state, phase };
}

function withCellStatus(
  state: TerminalGridState,
  cellId: TerminalCellId,
  status: TerminalCellStatus,
): TerminalGridState {
  return {
    ...state,
    cells: state.cells.map((cell) => (cell.cellId === cellId ? { ...cell, status } : cell)),
  };
}

function withCellContent(
  state: TerminalGridState,
  cellId: TerminalCellId,
  text: string,
): TerminalGridState {
  return {
    ...state,
    cells: state.cells.map((cell) =>
      cell.cellId === cellId ? { ...cell, content: cell.content + text } : cell,
    ),
  };
}

export type { PresentTerminalGrid, TerminalGridHost };
