/**
 * Tier TG — the terminal grid routing surface and the provider grid contract
 * (architecture.md §Terminal grid presentation, spec §6.21).
 *
 * Two things live here, and neither decides anything. The routing surface is
 * where middleware composes around a grid request, and its whole contract is
 * that it decides nothing: `open()` answers `unknown`, and core throws the
 * answer away. The grid is what a provider supplies as a resource, and its contract is
 * ordering — prepared hidden, attached once, destroyed exactly once.
 *
 * Who may present a grid, and what presenting one authorizes, is core's, and is
 * proved in `packages/core/tests/terminal-grid.test.ts`.
 *
 * Nothing here opens a terminal, looks for a multiplexer, or starts a process.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { resource, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";

import {
  controlledTerminalGrid,
  TERMINAL_PROVIDER_UNAVAILABLE,
  TerminalGrids,
  terminalProviderLog,
  TerminalProviderUnavailableError,
} from "../terminal.ts";
import type { TerminalGridRequest, TerminalShellOutcome } from "../terminal.ts";

/** A two-by-one grid: the smallest request that still has two ordinals. */
function request(overrides: Partial<TerminalGridRequest> = {}): TerminalGridRequest {
  return {
    columns: 2,
    rows: 1,
    panes: [
      { ordinal: 0, title: "Agent", row: 0, column: 0, form: "paired" },
      { ordinal: 1, title: "Shell", row: 0, column: 1, form: "self-closing" },
    ],
    ...overrides,
  };
}

describe("Tier TG — the routing surface", () => {
  it("TP1: refuses when no host has installed a provider", function* () {
    let refusal: unknown;
    yield* scoped(function* () {
      try {
        yield* TerminalGrids.operations.open(request());
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(TerminalProviderUnavailableError);
    expect(refusal instanceof Error ? refusal.message : "").toBe(TERMINAL_PROVIDER_UNAVAILABLE);
  });

  it("TP2: middleware observes a delegated request without changing it", function* () {
    const seen: TerminalGridRequest[] = [];
    const reached: TerminalGridRequest[] = [];
    yield* scoped(function* () {
      yield* TerminalGrids.around(
        {
          // deno-lint-ignore require-yield
          *open([asked]) {
            reached.push(asked);
            return undefined;
          },
        },
        // The terminal end of the chain, where a registered provider sits.
        { at: "min" },
      );
      yield* TerminalGrids.around({
        *open([asked], next) {
          seen.push(asked);
          return yield* next(asked);
        },
      });
      yield* TerminalGrids.operations.open(request({ columns: 3, rows: 2 }));
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.columns).toBe(3);
    // Observation is not interference: the same object reached the far end.
    expect(reached[0]).toBe(seen[0]);
  });

  it("TP2: middleware narrows a request before anything below sees it", function* () {
    const reached: TerminalGridRequest[] = [];
    yield* scoped(function* () {
      yield* TerminalGrids.around(
        {
          // deno-lint-ignore require-yield
          *open([asked]) {
            reached.push(asked);
            return undefined;
          },
        },
        // The terminal end of the chain, where a registered provider sits.
        { at: "min" },
      );
      yield* TerminalGrids.around({
        *open([asked], next) {
          return yield* next({ ...asked, columns: 1, rows: asked.panes.length });
        },
      });
      yield* TerminalGrids.operations.open(request());
    });

    expect(reached[0]?.columns).toBe(1);
    expect(reached[0]?.rows).toBe(2);
  });

  it("TP2: middleware refuses a request, and nothing below is reached", function* () {
    const reached: TerminalGridRequest[] = [];
    let refusal: unknown;
    yield* scoped(function* () {
      yield* TerminalGrids.around(
        {
          // deno-lint-ignore require-yield
          *open([asked]) {
            reached.push(asked);
            return undefined;
          },
        },
        // The terminal end of the chain, where a registered provider sits.
        { at: "min" },
      );
      yield* TerminalGrids.around({
        // deno-lint-ignore require-yield
        *open(): Operation<unknown> {
          throw new Error("this host does not open terminal grids");
        },
      });
      try {
        yield* TerminalGrids.operations.open(request());
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal instanceof Error ? refusal.message : "").toBe(
      "this host does not open terminal grids",
    );
    expect(reached).toEqual([]);
  });
});

describe("Tier TG — the provider grid contract", () => {
  it("TP3: an acquired grid presents nothing until it is attached", function* () {
    const log = terminalProviderLog();
    const events = yield* scoped(function* () {
      yield* controlledTerminalGrid(request(), { log });
      return [...log.events];
    });

    // A grid the reader can see before every pane is ready is the one thing
    // atomic startup forbids.
    expect(events).toEqual(["prepare:0:2x1"]);
    expect(events.some((event) => event.startsWith("attach:"))).toBe(false);
  });

  it("TP3: attach, update, display, shell and release record in order", function* () {
    const log = terminalProviderLog();
    let outcome: TerminalShellOutcome | undefined;
    yield* scoped(function* () {
      const grid = yield* controlledTerminalGrid(request(), { log });
      yield* grid.update(0, "starting");
      yield* grid.display(0, "pane text");
      yield* grid.update(0, "running");
      yield* scoped(function* () {
        // Acquiring the activity is the shell starting.
        outcome = yield* yield* grid.shell(1);
      });
      yield* grid.attach();
      yield* grid.update(0, "succeeded");
      yield* grid.closed();
    });

    // The destroy is the resource's own release, recorded without anyone
    // calling one.
    expect(log.events).toEqual([
      "prepare:0:2x1",
      "state:0:0:starting",
      "state:0:0:running",
      "shell:0:1",
      "attach:0",
      "state:0:0:succeeded",
      "closed:0",
      "destroy:0",
    ]);
    expect(log.shown.get(0)).toBe("pane text");
    expect(outcome).toEqual({ exitCode: 0 });
    expect(log.live).toEqual({ grids: 0, attached: 0, shells: 0 });
  });

  it("TP4: a shell that never starts is never acquired", function* () {
    const log = terminalProviderLog();
    let refusal: unknown;
    yield* scoped(function* () {
      const grid = yield* controlledTerminalGrid(request(), {
        log,
        shell: () =>
          resource<Operation<TerminalShellOutcome>>(function* () {
            // Fails before it provides: nothing started, so nothing is owed an
            // outcome and no pane could call this ready.
            throw new Error("no child could be spawned");
          }),
      });
      try {
        yield* yield* grid.shell(1);
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal instanceof Error ? refusal.message : "").toBe("no child could be spawned");
    // An activity that never came up was never counted as held, and left no
    // shell record behind.
    expect(log.events.some((event) => event.startsWith("shell:"))).toBe(false);
    expect(log.live).toEqual({ grids: 0, attached: 0, shells: 0 });
  });

  it("TP4: a preparation failure leaves no grid to release", function* () {
    const log = terminalProviderLog();
    let refusal: unknown;
    yield* scoped(function* () {
      try {
        yield* controlledTerminalGrid(request(), {
          log,
          // deno-lint-ignore require-yield
          *onPrepare() {
            throw new Error("no pane endpoint could be created");
          },
        });
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal instanceof Error ? refusal.message : "").toBe(
      "no pane endpoint could be created",
    );
    // The failure happened before the grid existed, so nothing is owed a
    // release.
    expect(log.events).toEqual([]);
  });

  it("TP4: release happens once, whatever ended the grid", function* () {
    const log = terminalProviderLog();

    // Settled normally.
    yield* scoped(function* () {
      yield* controlledTerminalGrid(request(), { log }, 0);
    });
    // Cancelled while live. The child says when it is actually holding a grid,
    // so the halt lands on a live one rather than on a task that never began.
    yield* scoped(function* () {
      const holding = withResolvers<void>();
      const task = yield* spawn(function* () {
        yield* scoped(function* () {
          yield* controlledTerminalGrid(request(), { log }, 1);
          holding.resolve();
          yield* suspend();
        });
      });
      yield* holding.operation;
      yield* task.halt();
    });
    // Failed after acquisition.
    yield* scoped(function* () {
      try {
        yield* scoped(function* () {
          yield* controlledTerminalGrid(request(), { log }, 2);
          throw new Error("the provider failed");
        });
      } catch {
        // The failure is the point; the release is what is being counted.
      }
    });

    // One destroy each, and nothing left holding anything. A resource cannot be
    // released twice, which is why there is no way to call one by hand.
    expect(log.events.filter((event) => event === "destroy:0")).toEqual(["destroy:0"]);
    expect(log.events.filter((event) => event === "destroy:1")).toEqual(["destroy:1"]);
    expect(log.events.filter((event) => event === "destroy:2")).toEqual(["destroy:2"]);
    expect(log.live).toEqual({ grids: 0, attached: 0, shells: 0 });
  });

  it("TP5: each acquisition is its own grid", function* () {
    const log = terminalProviderLog();
    yield* scoped(function* () {
      yield* scoped(function* () {
        yield* controlledTerminalGrid(request(), { log }, 0);
      });
      yield* scoped(function* () {
        yield* controlledTerminalGrid(request(), { log }, 1);
      });
    });

    // Two expansions are two grids. A provider that handed the same grid back
    // would have presented the second expansion's grid as the first's.
    expect(log.events).toEqual(["prepare:0:2x1", "destroy:0", "prepare:1:2x1", "destroy:1"]);
  });
});
