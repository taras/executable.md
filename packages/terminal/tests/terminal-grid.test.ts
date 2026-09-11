/**
 * Tier TG — the provider-neutral terminal grid lifecycle (architecture.md
 * §Terminal grid presentation, §Atomic presentation and settlement,
 * §Durability and replay).
 *
 * These rows drive `terminalGrid()` directly, with cell work written by hand
 * and a journal that retains nothing. What they prove is the part of a grid
 * that has no document in it: who may present one, what owns the running
 * grid, how the immutable state advances, when an action is allowed to ask the
 * provider for a terminal, and what teardown must have finished before any of
 * it settles.
 *
 * Nothing here opens a terminal, looks for a multiplexer, or starts a process.
 * Every ordering claim is read off a record or a gate, because a grid that
 * converged too early and one that converged on time take the same wall clock.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { each, ensure, race, resource, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Task } from "effection";

import {
  installTerminalProvider,
  registerTerminalProvider,
  reserveTerminal,
  TerminalGridPresentationError,
  TerminalGrids,
  terminalGridLayout,
  TerminalProviderInstallError,
  TerminalProviders,
  useTerminalCellUI,
} from "../mod.ts";
import type {
  PlacedCell,
  RetainedCellOutcome,
  RetainedGrid,
  TerminalActivity,
  TerminalCellUI,
  TerminalGridHost,
  TerminalGridJournal,
  TerminalGridLayout,
  TerminalGridProvider,
  TerminalGridRequest,
  TerminalGridState,
  TerminalShellOutcome,
} from "../mod.ts";
import { appendTerminalCellOutput, terminalGrid, useTerminalInstallation } from "../lifecycle.ts";
import type { PresentTerminalGrid } from "../lifecycle.ts";
import {
  barrier,
  controlledTerminalProvider,
  gate,
  installControlledLauncher,
  terminalProviderLog,
} from "../test/mod.ts";
import type {
  ControlledProviderOptions,
  TerminalProviderLog,
  TerminalProviderResources,
} from "../test/mod.ts";
import { createTerminalGridStore, revisionCeilingMessage } from "../src/store.ts";

/** A journal with nothing behind it: every retention is its live operation. */
function directJournal(record: string[] = []): TerminalGridJournal {
  return {
    // deno-lint-ignore require-yield
    *reconcileLayout() {
      record.push("reconcile");
    },
    retainGrid: (operation) => operation,
    retainCell: (position, operation) =>
      (function* (): Operation<RetainedCellOutcome> {
        record.push(`retain:${position}`);
        return yield* operation;
      })(),
  };
}

/** A layout of `titles.length` cells across `columns`, all paired. */
function layoutOf(columns: number, titles: readonly string[]): TerminalGridLayout {
  const cells = titles.map((title): PlacedCell => ({ title, form: "paired" }));
  return terminalGridLayout(columns, cells);
}

function refusalOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Everything a controlled host installs, for an in-process grid. */
function useHost(provider: TerminalGridProvider): Operation<PresentTerminalGrid> {
  return (function* (): Operation<PresentTerminalGrid> {
    yield* installControlledLauncher();
    yield* registerTerminalProvider("controlled", function* (_options, present) {
      yield* TerminalGrids.around(
        {
          *open([request]) {
            yield* present(request, provider);
            return undefined;
          },
        },
        { at: "min" },
      );
    });
    const present = yield* useTerminalInstallation();
    yield* installTerminalProvider("controlled", { label: "controlled" }, present);
    return present;
  })();
}

/** Cell work that acquires one shell and settles with it. */
function shellCell(marks?: string[], mark = ""): Operation<void> {
  return (function* (): Operation<void> {
    const cell = yield* useTerminalCellUI();
    if (cell === undefined) {
      throw new Error("this cell work ran outside the scope that issued its handle");
    }
    marks?.push(`enter:${mark}`);
    yield* cell.shell();
    marks?.push(`leave:${mark}`);
  })();
}

/** One ordered `{cellId, operation}` record per position. */
function cellWork(
  titles: readonly string[],
  body: (position: number) => Operation<void>,
): { cellId: symbol; operation: Operation<void> }[] {
  return titles.map((title, position) => ({
    cellId: Symbol(`cell:${position}:${title}`),
    operation: body(position),
  }));
}

describe("Tier TG — owning one grid", () => {
  it("TG22: cell work is inert until interpreted, and interpreted exactly once", function* () {
    const constructed: number[] = [];
    const entered: number[] = [];
    const log = terminalProviderLog();

    const retained = yield* scoped(function* (): Operation<RetainedGrid> {
      const settled = settledCells(2);
      yield* useHost(
        controlledTerminalProvider({ log, close: () => settled.opened, render: settled.render }),
      );
      const titles = ["a", "b"];
      const cells = titles.map((title, position) => {
        // Built here and not entered: constructing a cell's operation performs
        // no expansion, shell, provider or journal work at all.
        constructed.push(position);
        return {
          cellId: Symbol(title),
          operation: (function* (): Operation<void> {
            entered.push(position);
            yield* shellCell();
          })(),
        };
      });
      expect(entered).toEqual([]);

      const task = yield* terminalGrid(layoutOf(2, titles), cells, directJournal());
      return yield* task;
    });

    expect(constructed).toEqual([0, 1]);
    // Once each, in authored order, and never a second time.
    expect(entered.slice().sort()).toEqual([0, 1]);
    expect(retained.cells).toHaveLength(2);
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
  });

  it("TG22: the returned task is owned by the submitting scope", function* () {
    const log = terminalProviderLog();
    const finalized: string[] = [];
    const live = gate();
    let heldWhileLive: TerminalProviderResources | undefined;

    yield* scoped(function* () {
      yield* useHost(
        controlledTerminalProvider({ log, close: () => suspend(), ...heldShell(live) }),
      );

      // The grid is live — its host acquired, its cell holding an activity —
      // and the row's own branch then wins the race, cancelling the submitting
      // operation and nothing else.
      yield* race([
        (function* (): Operation<void> {
          const task = yield* terminalGrid(
            layoutOf(1, ["a"]),
            cellWork(["a"], () => holdingCell(finalized, "cell")),
            directJournal(),
          );
          yield* task;
        })(),
        (function* (): Operation<void> {
          yield* live.opened;
          heldWhileLive = { ...log.live };
        })(),
      ]);
    });

    expect(heldWhileLive).toEqual({ grids: 1, shown: 0, activities: 1 });
    // The cell's activity was released and the provider's host with it: nothing
    // detached, and every finalizer ran.
    expect(finalized).toEqual(["cell"]);
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
    expect(log.events.filter((event) => event === "destroy:0")).toEqual(["destroy:0"]);
  });

  it("TG22: releasing the resource early cancels and awaits cells, renderer and host", function* () {
    const log = terminalProviderLog();
    const finalized: string[] = [];
    const live = gate();

    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        yield* scoped(function* () {
          yield* useHost(
            controlledTerminalProvider({
              log,
              close: () => suspend(),
              ...heldShell(live),
              // deno-lint-ignore require-yield
              *onDestroy() {
                finalized.push("host");
              },
            }),
          );
          const grid = yield* terminalGrid(
            layoutOf(1, ["a"]),
            cellWork(["a"], () => holdingCell(finalized, "cell")),
            directJournal(),
          );
          // Deliberately not awaited: the row releases the resource by
          // cancelling the scope that holds it, which is the case the contract
          // is about.
          void grid;
          yield* suspend();
        });
      });
      yield* live.opened;
      yield* task.halt();
    });

    // The cell's finalizer ran, the host was destroyed once, and nothing the
    // provider handed out is still held.
    expect(finalized).toEqual(["cell", "host"]);
    expect(log.events.filter((event) => event === "destroy:0")).toEqual(["destroy:0"]);
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
  });

  it("TG22: a layout and its cell work must agree, and no provider is reached", function* () {
    const log = terminalProviderLog();
    let refusal: unknown;

    yield* scoped(function* () {
      yield* useHost(controlledTerminalProvider({ log }));
      try {
        const task = yield* terminalGrid(
          layoutOf(2, ["a", "b"]),
          cellWork(["a"], () => shellCell()),
          directJournal(),
        );
        yield* task;
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusalOf(refusal)).toContain("places 2 cells and was given 1 cell operations");
    expect(log.events).toEqual([]);
  });

  it("TG22: one live identity per authored position, and never the same one twice", function* () {
    const log = terminalProviderLog();
    let refusal: unknown;
    const shared = Symbol("shared");

    yield* scoped(function* () {
      yield* useHost(controlledTerminalProvider({ log }));
      try {
        const task = yield* terminalGrid(
          layoutOf(2, ["a", "b"]),
          [
            { cellId: shared, operation: shellCell() },
            { cellId: shared, operation: shellCell() },
          ],
          directJournal(),
        );
        yield* task;
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusalOf(refusal)).toContain("the same live cell identity twice");
    expect(log.events).toEqual([]);
  });

  it("TG23: the foreground lease admits one grid at a time", function* () {
    const log = terminalProviderLog();
    const finalized: string[] = [];
    const live = gate();
    let refusal: unknown;

    // Caught around the region rather than around the await. A grid that fails
    // raises into the scope that submitted it, which is how a document run
    // learns about it; a `catch` at the await would never see it.
    try {
      yield* scoped(function* () {
        yield* useHost(
          controlledTerminalProvider({ log, close: () => suspend(), ...heldShell(live) }),
        );
        yield* spawn(function* () {
          const task = yield* terminalGrid(
            layoutOf(1, ["first"]),
            cellWork(["first"], () => holdingCell(finalized, "first")),
            directJournal(),
          );
          yield* task;
        });
        yield* live.opened;

        // The foreground-terminal lease admits a single grid at a time, so a
        // second never reaches presentation at all.
        const second = yield* terminalGrid(
          layoutOf(1, ["second"]),
          cellWork(["second"], () => shellCell()),
          directJournal(),
        );
        yield* second;
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusalOf(refusal)).toContain("owns the terminal at a time");
    // Only one host was ever prepared.
    expect(log.events.filter((event) => event.startsWith("prepare:"))).toEqual(["prepare:0:1x1"]);
    expect(finalized).toEqual(["first"]);
  });

  it("TG23: a root native launch cannot take the lease a live grid holds", function* () {
    const log = terminalProviderLog();
    const finalized: string[] = [];
    const live = gate();
    let refusal: unknown;

    yield* scoped(function* () {
      yield* useHost(
        controlledTerminalProvider({ log, close: () => suspend(), ...heldShell(live) }),
      );
      yield* spawn(function* () {
        const task = yield* terminalGrid(
          layoutOf(1, ["grid"]),
          cellWork(["grid"], () => holdingCell(finalized, "grid")),
          directJournal(),
        );
        yield* task;
      });
      yield* live.opened;

      try {
        yield* scoped(function* () {
          yield* reserveTerminal();
        });
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusalOf(refusal)).toContain("owns the terminal at a time");
  });
});

/** Cell work that starts something interactive and stays until it is stopped. */
function holdingCell(finalized: string[], mark: string): Operation<void> {
  return (function* (): Operation<void> {
    const cell = yield* useTerminalCellUI();
    if (cell === undefined) {
      throw new Error("this cell work ran outside the scope that issued its handle");
    }
    yield* ensure(() => {
      finalized.push(mark);
    });
    yield* cell.shell();
  })();
}

/**
 * A shell that starts and never finishes, and a gate opened once it is running.
 *
 * `running` is committed after the activity has been acquired, so a row that
 * waits on this gate is waiting for the provider to be holding something.
 */
function heldShell(live: { open(): void }): Pick<ControlledProviderOptions, "shell" | "render"> {
  return {
    shell: () =>
      resource<Operation<TerminalShellOutcome>>(function* (provide) {
        yield* provide(
          (function* (): Operation<TerminalShellOutcome> {
            yield* suspend();
            // Unreachable: the shell is released rather than returning.
            return { exitCode: 0 };
          })(),
        );
      }),
    // deno-lint-ignore require-yield
    *render(state: TerminalGridState) {
      if (state.cells.some((cell) => cell.status === "running")) {
        live.open();
      }
    },
  };
}

/**
 * A render hook that opens its gate once `count` cells have settled.
 *
 * The gate is opened by a snapshot the renderer actually applied, so a row that
 * waits on it waits for an event rather than for a duration.
 */
function settledCells(count: number): {
  readonly opened: Operation<void>;
  render: (state: TerminalGridState) => Operation<void>;
} {
  const reached = gate();
  return {
    opened: reached.opened,
    // deno-lint-ignore require-yield
    *render(state: TerminalGridState) {
      const settled = state.cells.filter(
        (cell) =>
          cell.status === "succeeded" || cell.status === "failed" || cell.status === "closed",
      ).length;
      if (settled >= count) {
        reached.open();
      }
    },
  };
}

describe("Tier TG — the private aggregate", () => {
  const seed = () => ({
    columns: 2,
    rows: 1,
    cells: [
      { cellId: Symbol("a"), title: "Left", row: 0, column: 0 },
      { cellId: Symbol("b"), title: "Right", row: 0, column: 1 },
    ],
  });

  it("TG24: the first snapshot is revision zero", function* () {
    const store = yield* createTerminalGridStore(seed());
    const first = store.state();
    expect(first.revision).toBe(0);
    expect(first.phase).toBe("preparing");
    expect(first.cells.map((cell) => cell.status)).toEqual(["starting", "starting"]);
    expect(first.cells.map((cell) => cell.content)).toEqual(["", ""]);
  });

  it("TG24: a subscription starts from the snapshot in force, with no gap after it", function* () {
    const seen: number[] = [];
    yield* scoped(function* () {
      const store = yield* createTerminalGridStore(seed());
      // Something has already happened before anybody subscribes.
      yield* store.commit((state) => ({ ...state, phase: "visible" }));

      const states = yield* store.states;
      // Commits that land after the subscription exists.
      yield* store.commit((state) => withStatus(state, 0, "launching"));
      yield* store.commit((state) => withStatus(state, 1, "launching"));

      for (let read = 0; read < 3; read++) {
        const next = yield* states.next();
        if (next.done) {
          throw new Error("the state subscription ended");
        }
        seen.push(next.value.revision);
      }
    });

    // The revision in force when the subscription began, and then every later
    // one in order: nothing between the registration and the first snapshot.
    expect(seen).toEqual([1, 2, 3]);
  });

  it("TG24: no commit is lost between registering a subscription and its first snapshot", function* () {
    const seen: number[] = [];
    yield* scoped(function* () {
      const store = yield* createTerminalGridStore(seed());
      const subscribed = withResolvers<void>();
      const reading = yield* spawn(function* () {
        const states = yield* store.states;
        subscribed.resolve();
        for (let read = 0; read < 2; read++) {
          const next = yield* states.next();
          if (next.done) {
            throw new Error("the state subscription ended");
          }
          seen.push(next.value.revision);
        }
      });
      // Issued while the subscription is being acquired. Registration and the
      // first snapshot are one step, so this commit is either already in that
      // snapshot or is the next emission — it cannot fall between them.
      yield* store.commit((state) => withStatus(state, 0, "launching"));
      yield* subscribed.operation;
      yield* store.commit((state) => withStatus(state, 1, "launching"));
      yield* reading;
    });

    expect(seen).toHaveLength(2);
    // Contiguous: a gap here is a commit that happened while nobody was
    // listening and nobody ever heard about.
    expect(seen[1]).toBe(seen[0]! + 1);
    expect(seen[1]).toBe(2);
  });

  it("TG24: a commit that changes nothing creates no revision and no emission", function* () {
    const seen: number[] = [];
    yield* scoped(function* () {
      const store = yield* createTerminalGridStore(seed());
      const states = yield* store.states;
      const first = yield* states.next();
      expect(first.done).toBe(false);

      // Same phase, same statuses, same content: a no-op.
      const unchanged = yield* store.commit((state) => ({ ...state }));
      expect(unchanged.revision).toBe(0);
      const stillZero = yield* store.commit((state) => withStatus(state, 0, "starting"));
      expect(stillZero.revision).toBe(0);
      // Empty appended content is also a no-op.
      const stillZeroAgain = yield* store.commit((state) => withContent(state, 0, ""));
      expect(stillZeroAgain.revision).toBe(0);

      const changed = yield* store.commit((state) => withStatus(state, 0, "launching"));
      expect(changed.revision).toBe(1);

      const next = yield* states.next();
      if (next.done) {
        throw new Error("the state subscription ended");
      }
      seen.push(next.value.revision);
    });

    // One emission, for the one commit that changed the aggregate.
    expect(seen).toEqual([1]);
  });

  it("TG24: a snapshot read earlier never changes, and a title is fixed", function* () {
    const store = yield* createTerminalGridStore(seed());
    const before = store.state();
    yield* store.commit((state) => withContent(state, 0, "hello"));
    const after = store.state();

    expect(before.revision).toBe(0);
    expect(before.cells[0]!.content).toBe("");
    expect(after.cells[0]!.content).toBe("hello");
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.cells)).toBe(true);
    expect(Object.isFrozen(after.cells[0]!)).toBe(true);
    // Titles come from the authored layout and nothing moves them.
    expect(after.cells.map((cell) => cell.title)).toEqual(["Left", "Right"]);
    expect(after.cells.map((cell) => [cell.row, cell.column])).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });

  it("TG24: refuses before publishing past the safe-integer ceiling", function* () {
    const seen: number[] = [];
    let refusal: unknown;
    yield* scoped(function* () {
      const store = yield* createTerminalGridStore({
        ...seed(),
        startRevision: Number.MAX_SAFE_INTEGER,
      });
      const states = yield* store.states;
      const first = yield* states.next();
      if (!first.done) {
        seen.push(first.value.revision);
      }
      try {
        yield* store.commit((state) => withStatus(state, 0, "launching"));
      } catch (error) {
        refusal = error;
      }
      // Nothing was published: the aggregate in force is the one it was.
      expect(store.state().revision).toBe(Number.MAX_SAFE_INTEGER);
      expect(store.state().cells[0]!.status).toBe("starting");
    });

    expect(refusalOf(refusal)).toBe(revisionCeilingMessage(Number.MAX_SAFE_INTEGER));
    expect(seen).toEqual([Number.MAX_SAFE_INTEGER]);
  });
});

function withStatus(
  state: TerminalGridState,
  position: number,
  status: TerminalGridState["cells"][number]["status"],
): TerminalGridState {
  return {
    ...state,
    cells: state.cells.map((cell, index) => (index === position ? { ...cell, status } : cell)),
  };
}

function withContent(state: TerminalGridState, position: number, text: string): TerminalGridState {
  return {
    ...state,
    cells: state.cells.map((cell, index) =>
      index === position ? { ...cell, content: cell.content + text } : cell,
    ),
  };
}

/**
 * A provider that records every effect it could possibly have.
 *
 * Lazy on purpose: nothing in here runs until something acquires it. A refusal
 * that happens first therefore leaves the record empty, which is the only way
 * to tell "refused before the provider was touched" from "refused after".
 */
function watchedProvider(effects: string[], label: string): TerminalGridProvider {
  return {
    host(_request: TerminalGridRequest, view): Operation<TerminalGridHost> {
      return resource(function* (provide) {
        effects.push(`acquired:${label}`);
        yield* ensure(() => {
          effects.push(`released:${label}`);
        });
        const states = yield* view.states;
        const first = yield* states.next();
        if (first.done) {
          throw new Error("the state subscription ended");
        }
        const order = first.value.cells.map((cell) => cell.cellId);
        yield* provide({
          closed: { *[Symbol.iterator]() {} },
          failed: {
            *[Symbol.iterator]() {
              yield* suspend();
              throw new Error("unreachable");
            },
          },
          // deno-lint-ignore require-yield
          *converge() {},
          // deno-lint-ignore require-yield
          *show() {
            effects.push(`show:${label}`);
          },
          launch: () =>
            resource<Operation<NativeLaunchOutcomeShape>>(function* (provideOutcome) {
              effects.push(`launch:${label}`);
              yield* provideOutcome(settledOutcome({ exitCode: 0 }));
            }),
          shell: (cellId) =>
            resource<Operation<TerminalShellOutcome>>(function* (provideOutcome) {
              effects.push(`shell:${label}:${order.indexOf(cellId)}`);
              yield* provideOutcome(settledOutcome<TerminalShellOutcome>({ exitCode: 0 }));
            }),
        });
      });
    },
  };
}

interface NativeLaunchOutcomeShape {
  exitCode?: number;
  signal?: string;
}

function settledOutcome<T>(value: T): Operation<T> {
  // deno-lint-ignore require-yield
  return (function* (): Operation<T> {
    return value;
  })();
}

describe("Tier TG — refusing a presentation before the provider is touched", () => {
  /** Drive one grid, letting the row decide what the provider presents. */
  function underProvider(
    present: (present: PresentTerminalGrid, request: TerminalGridRequest) => Operation<void>,
    opened: string[],
  ): Operation<unknown> {
    return scoped(function* () {
      yield* installControlledLauncher();
      yield* registerTerminalProvider("controlled", function* (_options, presentGrid) {
        yield* TerminalGrids.around(
          {
            *open([request]) {
              yield* present(presentGrid, request);
              return undefined;
            },
          },
          { at: "min" },
        );
      });
      const installed = yield* useTerminalInstallation();
      yield* installTerminalProvider("controlled", { label: "controlled" }, installed);
      try {
        const task = yield* terminalGrid(
          layoutOf(1, ["a"]),
          cellWork(["a"], () => shellCell(opened, "a")),
          directJournal(),
        );
        return yield* task;
      } catch (error) {
        return error;
      }
    });
  }

  it("TR1: a copied request is refused, and the copy's host is never acquired", function* () {
    const effects: string[] = [];
    const opened: string[] = [];
    let refusal: unknown;

    try {
      yield* scoped(function* () {
        yield* underProvider(function* (present, request) {
          // Same members, a different object. Identity is what is read.
          const copy = {
            columns: request.columns,
            rows: request.rows,
            cells: request.cells.map((cell) => ({ ...cell })),
          };
          try {
            yield* present(copy, watchedProvider(effects, "copy"));
          } catch (error) {
            refusal = error;
          }
        }, opened);
      });
    } catch {
      // The grid refuses for want of a presentation; the refusal this row reads
      // is the one presentation itself produced.
    }

    expect(refusalOf(refusal)).toContain("is not live");
    expect(effects).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("TR2: a changed request is refused, and its host is never acquired", function* () {
    const effects: string[] = [];
    const opened: string[] = [];
    let refusal: unknown;

    try {
      yield* scoped(function* () {
        yield* underProvider(function* (present, request) {
          try {
            yield* present(
              { ...request, columns: request.columns + 1 },
              watchedProvider(effects, "changed"),
            );
          } catch (error) {
            refusal = error;
          }
        }, opened);
      });
    } catch {
      // As above.
    }

    expect(refusalOf(refusal)).toContain("is not live");
    expect(effects).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("TR3: the exact request is refused once it is stale", function* () {
    const effects: string[] = [];
    const opened: string[] = [];
    let kept: { present: PresentTerminalGrid; request: TerminalGridRequest } | undefined;

    yield* scoped(function* () {
      yield* underProvider(function* (present, request) {
        kept = { present, request };
        yield* present(request, watchedProvider(effects, "live"));
      }, opened);
    });

    // The grid ran and finished, so its submitting operation has unwound and
    // the request it issued is no longer anything to present for. This watched
    // host's reader leaves the moment it is asked, so the cell is closed while
    // its shell is still live and never records a departure of its own.
    expect(opened).toEqual(["enter:a"]);
    expect(effects).toEqual(["acquired:live", "shell:live:0", "show:live", "released:live"]);

    let refusal: unknown;
    yield* scoped(function* () {
      try {
        yield* kept!.present(kept!.request, watchedProvider(effects, "stale"));
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusalOf(refusal)).toContain("is not live");
    // Nothing new: the stale host was never acquired.
    expect(effects).toEqual(["acquired:live", "shell:live:0", "show:live", "released:live"]);
  });

  it("TR4: a second presentation of the exact live request is refused", function* () {
    const effects: string[] = [];
    const opened: string[] = [];
    let refusal: unknown;

    yield* scoped(function* () {
      yield* underProvider(function* (present, request) {
        yield* present(request, watchedProvider(effects, "first"));
        try {
          yield* present(request, watchedProvider(effects, "second"));
        } catch (error) {
          refusal = error;
        }
      }, opened);
    });

    expect(refusalOf(refusal)).toContain("already been presented");
    // One host acquired and released; the second was never touched.
    expect(effects.filter((effect) => effect.includes("second"))).toEqual([]);
  });

  it("TR5: the exact live request is refused under another installation generation", function* () {
    const effects: string[] = [];
    const opened: string[] = [];
    let refusal: unknown;

    yield* scoped(function* () {
      yield* installControlledLauncher();
      yield* registerTerminalProvider("controlled", function* (_options, presentGrid) {
        yield* TerminalGrids.around(
          {
            *open([request]) {
              // A second installation supersedes the one this grid was issued
              // under. It shares the lookup, so it *finds* this request — and
              // turns it away for belonging to another installation.
              const superseding = yield* useTerminalInstallation();
              try {
                yield* superseding(request, watchedProvider(effects, "wrong-generation"));
              } catch (error) {
                refusal = error;
              }
              // Then the right one presents, so the grid still settles.
              yield* presentGrid(request, watchedProvider(effects, "right-generation"));
              return undefined;
            },
          },
          { at: "min" },
        );
      });
      const installed = yield* useTerminalInstallation();
      yield* installTerminalProvider("controlled", { label: "controlled" }, installed);
      const task = yield* terminalGrid(
        layoutOf(1, ["a"]),
        cellWork(["a"], () => shellCell(opened, "a")),
        directJournal(),
      );
      yield* task;
    });

    expect(refusal).toBeInstanceOf(TerminalGridPresentationError);
    expect(refusalOf(refusal)).toContain("belongs to another terminal provider installation");
    // The refused generation's host was never acquired; only the admitted one.
    expect(effects.filter((effect) => effect.includes("wrong-generation"))).toEqual([]);
    expect(effects).toContain("acquired:right-generation");
    expect(effects).toContain("released:right-generation");
  });

  it("TR6: a presentation function kept past its execution presents nothing", function* () {
    const effects: string[] = [];
    const opened: string[] = [];
    let kept: PresentTerminalGrid | undefined;

    yield* scoped(function* () {
      yield* underProvider(function* (present, request) {
        kept = present;
        yield* present(request, watchedProvider(effects, "live"));
      }, opened);
    });

    let refusal: unknown;
    yield* scoped(function* () {
      const asked: TerminalGridRequest = {
        columns: 1,
        rows: 1,
        cells: [{ title: "x", row: 0, column: 0, form: "self-closing" }],
      };
      try {
        yield* kept!(asked, watchedProvider(effects, "unrouted"));
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(TerminalGridPresentationError);
    expect(refusalOf(refusal)).toContain("is not live");
    expect(effects.filter((effect) => effect.includes("unrouted"))).toEqual([]);
  });

  it("TR7: a provider that never acknowledges installs nothing", function* () {
    let refusal: unknown;
    yield* scoped(function* () {
      const present = yield* useTerminalInstallation();
      // A handler that answers the install request without delivering it to a
      // registered provider.
      yield* registerTerminalProvider("real", function* () {});
      yield* TerminalProviders.around({
        // deno-lint-ignore require-yield
        *install() {
          return undefined;
        },
      });
      try {
        yield* installTerminalProvider("real", { label: "real" }, present);
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(TerminalProviderInstallError);
    expect(refusalOf(refusal)).toContain("did not install");
  });
});

describe("Tier TG — convergence before transfer", () => {
  it("TG24: show stays blocked until the revision it committed is applied", function* () {
    const log = terminalProviderLog();
    const held = gate();
    const order: string[] = [];

    yield* scoped(function* () {
      yield* useHost(
        controlledTerminalProvider({
          log,
          close: () => suspend(),
          *render(state) {
            if (state.phase === "visible") {
              order.push(`blocked:${state.revision}`);
              // Every cell is already running, so nothing but the render is
              // keeping the grid hidden.
              order.push(`statuses:${state.cells.map((cell) => cell.status).join(",")}`);
              order.push(`shown-before:${log.events.some((event) => event.startsWith("show:"))}`);
              yield* held.opened;
            }
          },
        }),
      );
      const task = yield* spawn(function* () {
        const grid = yield* terminalGrid(
          layoutOf(1, ["a"]),
          cellWork(["a"], () => holdingCell([], "a")),
          directJournal(),
        );
        yield* grid;
      });
      // The renderer is blocked on the `visible` revision, so the grid cannot
      // have been shown yet however long this waits.
      yield* untilRecorded(order, 3);
      expect(log.events.some((event) => event.startsWith("show:"))).toBe(false);
      held.open();
      yield* untilEvent(log, (event) => event.startsWith("show:"));
      yield* task.halt();
    });

    expect(order[1]).toBe("statuses:running");
    expect(order[2]).toBe("shown-before:false");
    // The revision `show()` committed is the revision the host was asked for.
    const blocked = order[0]!.split(":")[1];
    expect(log.events).toContain(`show:0:${blocked}`);
  });

  it("TG24: a cell action waits for convergence, and a cancelled wait transfers nothing", function* () {
    const log = terminalProviderLog();
    const reached = gate();
    const observed: TerminalGridState[] = [];

    yield* scoped(function* () {
      yield* useHost(
        controlledTerminalProvider({
          log,
          close: () => suspend(),
          *render(state) {
            if (state.cells.some((cell) => cell.status === "launching")) {
              observed.push(state);
              reached.open();
              // Held forever: convergence never completes, so the action can
              // never reach the host.
              yield* suspend();
            }
          },
        }),
      );
      const task = yield* spawn(function* () {
        const grid = yield* terminalGrid(
          layoutOf(1, ["a"]),
          cellWork(["a"], () => outputThenShell("first line\n")),
          directJournal(),
        );
        yield* grid;
      });
      yield* reached.opened;
      // Cancelled while the action is waiting for the screen it asked for.
      yield* task.halt();
    });

    // The revision the action captured already contains the output written
    // before it, which is what makes convergence through it meaningful.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.cells[0]!.content).toBe("first line\n");
    expect(observed[0]!.cells[0]!.status).toBe("launching");
    // No child call, no readiness, and nothing was shown.
    expect(log.events.filter((event) => event.startsWith("shell:"))).toEqual([]);
    expect(log.events.filter((event) => event.startsWith("launch:"))).toEqual([]);
    expect(log.events.some((event) => event.startsWith("show:"))).toBe(false);
    expect(log.applied.some((state) => state.cells.some((cell) => cell.status === "running"))).toBe(
      false,
    );
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
  });

  it("TG24: the host is reached only after the revision the action captured is applied", function* () {
    const log = terminalProviderLog();
    const reached = gate();
    const release = gate();
    let launching = -1;

    yield* scoped(function* () {
      const settled = settledCells(1);
      yield* useHost(
        controlledTerminalProvider({
          log,
          close: () => settled.opened,
          *render(state) {
            yield* settled.render(state);
            if (state.cells.some((cell) => cell.status === "launching") && launching < 0) {
              launching = state.revision;
              reached.open();
              // The lane is held here, so this revision is not applied until
              // the row lets it be. An action that called the host without
              // waiting would have reached it while this was blocked, and its
              // record would sit before this render's.
              yield* release.opened;
            }
          },
        }),
      );
      const task = yield* spawn(function* () {
        const grid = yield* terminalGrid(
          layoutOf(1, ["a"]),
          cellWork(["a"], () => outputThenShell("first line\n")),
          directJournal(),
        );
        yield* grid;
      });
      yield* reached.opened;
      release.open();
      yield* task;
    });

    expect(launching).toBeGreaterThan(0);
    // The action asked for exactly the revision it committed, and asked before
    // it asked for a terminal.
    const asked = log.events.indexOf(`converge:0:${launching}`);
    const rendered = log.events.indexOf(`render:0:${launching}`);
    const started = log.events.indexOf("shell:0:0");
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(rendered).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(asked).toBeLessThan(started);
    // And the screen it asked for was applied before the provider was asked
    // for a terminal.
    expect(rendered).toBeLessThan(started);
  });
});

describe("Tier TG — concurrency across cells", () => {
  for (const count of [1, 2, 3, 8]) {
    it(`TG23: ${count} cell(s) run concurrently, in stable authored order`, function* () {
      const log = terminalProviderLog();
      const together = barrier(count);
      const titles = Array.from({ length: count }, (_unused, index) => `cell ${index}`);
      const identities: string[] = [];

      const retained = yield* scoped(function* (): Operation<RetainedGrid> {
        const settled = settledCells(count);
        yield* useHost(
          controlledTerminalProvider({
            log,
            close: () => settled.opened,
            render: settled.render,
            shell: () =>
              resource<Operation<TerminalShellOutcome>>(function* (provide) {
                // Acquired: this cell is holding its activity. Settlement waits
                // for every other cell to be holding one too, which cells that
                // contended could never all do.
                together.arrive();
                yield* provide(
                  (function* (): Operation<TerminalShellOutcome> {
                    yield* together.opened;
                    return { exitCode: 0 };
                  })(),
                );
              }),
          }),
        );
        const task = yield* terminalGrid(
          layoutOf(3, titles),
          titles.map((title, position) => ({
            cellId: Symbol(title),
            operation: (function* (): Operation<void> {
              const cell = yield* useTerminalCellUI();
              if (cell === undefined) {
                throw new Error("no cell handle");
              }
              // Each cell sees its own handle and nobody else's.
              identities.push(`${position}:${cell.state.title}`);
              yield* cell.shell();
            })(),
          })),
          directJournal(),
        );
        return yield* task;
      });

      expect(together.arrived).toBe(count);
      expect(identities.slice().sort()).toEqual(
        titles.map((title, position) => `${position}:${title}`).sort(),
      );
      // Authored order in the retained record, whatever order they ran in.
      expect(retained.layout.cells.map((cell) => cell.title)).toEqual(titles);
      expect(retained.cells).toHaveLength(count);
      expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
    });
  }

  it("TG23: one cell refuses overlap, and admits the next after complete cleanup", function* () {
    const log = terminalProviderLog();
    const refusals: string[] = [];
    const marks: string[] = [];
    const releaseFirst = gate();
    const refused = gate();
    let acquisitions = 0;
    const released: number[] = [];

    yield* scoped(function* () {
      const settled = settledCells(1);
      yield* useHost(
        controlledTerminalProvider({
          log,
          close: () => settled.opened,
          render: settled.render,
          shell: () =>
            resource<Operation<TerminalShellOutcome>>(function* (provide) {
              const mine = ++acquisitions;
              yield* ensure(() => {
                released.push(mine);
              });
              yield* provide(
                (function* (): Operation<TerminalShellOutcome> {
                  if (mine === 1) {
                    yield* releaseFirst.opened;
                  }
                  return { exitCode: 0 };
                })(),
              );
            }),
        }),
      );
      const task = yield* terminalGrid(
        layoutOf(1, ["a"]),
        [
          {
            cellId: Symbol("a"),
            operation: (function* (): Operation<void> {
              const cell = yield* useTerminalCellUI();
              if (cell === undefined) {
                throw new Error("no cell handle");
              }
              yield* spawn(function* () {
                try {
                  yield* cell.shell();
                  marks.push("overlapping admitted");
                } catch (error) {
                  refusals.push(refusalOf(error));
                  refused.open();
                }
              });
              yield* spawn(function* () {
                yield* refused.opened;
                releaseFirst.open();
              });
              yield* cell.shell();
              marks.push("first settled");
              // The cell is free again: one owner at a time is not one owner
              // ever, and the next one is admitted only after the prior
              // activity's own cleanup finished.
              marks.push(`released-before-second:${released.length}`);
              yield* cell.shell();
              marks.push("sequential");
            })(),
          },
        ],
        directJournal(),
      );
      yield* task;
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("one owns a cell terminal at a time");
    expect(marks).not.toContain("overlapping admitted");
    expect(marks).toContain("sequential");
    expect(marks).toContain("released-before-second:1");
    // Two activities acquired, two released, nothing stranded.
    expect(acquisitions).toBe(2);
    expect(released).toEqual([1, 2]);
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
  });
});

/** Cell work that writes output and then asks for its terminal. */
function outputThenShell(text: string): Operation<void> {
  return (function* (): Operation<void> {
    const cell = yield* useTerminalCellUI();
    if (cell === undefined) {
      throw new Error("no cell handle");
    }
    yield* appendTerminalCellOutput(text);
    yield* cell.shell();
  })();
}

/** Settles once `record` holds at least `count` entries. */
function untilRecorded(record: readonly string[], count: number): Operation<void> {
  return {
    *[Symbol.iterator]() {
      while (record.length < count) {
        yield* nextTurn();
      }
    },
  };
}

/** Settles once the provider's record holds an event this predicate accepts. */
function untilEvent(
  log: TerminalProviderLog,
  accepts: (event: string) => boolean,
): Operation<void> {
  return {
    *[Symbol.iterator]() {
      while (!log.events.some(accepts)) {
        yield* nextTurn();
      }
    },
  };
}

function nextTurn(): Operation<void> {
  return {
    *[Symbol.iterator]() {
      const settled = withResolvers<void>();
      queueMicrotask(() => settled.resolve());
      yield* settled.operation;
    },
  };
}
