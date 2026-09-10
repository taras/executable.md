/**
 * Tier TG — the grid routing surface and the composite contract
 * (architecture.md §Terminal authority, spec §6.21).
 *
 * Two things live here, and neither is an authority. The routing surface is
 * where middleware composes around a grid request, and its whole contract is
 * that it decides nothing: `open()` answers `unknown`, and core throws the
 * answer away. The composite is what a provider prepares, and its contract is
 * ordering — prepared hidden, attached once, destroyed exactly once.
 *
 * Who may present a grid, and what presenting one authorizes, is core's, and is
 * proved in `packages/core/tests/grid.test.ts`.
 *
 * Nothing here opens a terminal, looks for a multiplexer, or starts a process.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import {
  GRID_PROVIDER_UNAVAILABLE,
  Grids,
  GridProviderUnavailableError,
} from "../src/composite.ts";
import type { GridRequest } from "../src/composite.ts";
import { prepareControlledComposite, gridProviderLog } from "../src/controlled-composite.ts";

/** A two-by-one grid: the smallest request that still has two ordinals. */
function request(overrides: Partial<GridRequest> = {}): GridRequest {
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
        yield* Grids.operations.open(request());
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(GridProviderUnavailableError);
    expect(refusal instanceof Error ? refusal.message : "").toBe(GRID_PROVIDER_UNAVAILABLE);
  });

  it("TP2: middleware observes a delegated request without changing it", function* () {
    const seen: GridRequest[] = [];
    const reached: GridRequest[] = [];
    yield* scoped(function* () {
      yield* Grids.around(
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
      yield* Grids.around({
        *open([asked], next) {
          seen.push(asked);
          return yield* next(asked);
        },
      });
      yield* Grids.operations.open(request({ columns: 3, rows: 2 }));
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.columns).toBe(3);
    // Observation is not interference: the same object reached the far end.
    expect(reached[0]).toBe(seen[0]);
  });

  it("TP2: middleware narrows a request before anything below sees it", function* () {
    const reached: GridRequest[] = [];
    yield* scoped(function* () {
      yield* Grids.around(
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
      yield* Grids.around({
        *open([asked], next) {
          return yield* next({ ...asked, columns: 1, rows: asked.panes.length });
        },
      });
      yield* Grids.operations.open(request());
    });

    expect(reached[0]?.columns).toBe(1);
    expect(reached[0]?.rows).toBe(2);
  });

  it("TP2: middleware refuses a request, and nothing below is reached", function* () {
    const reached: GridRequest[] = [];
    let refusal: unknown;
    yield* scoped(function* () {
      yield* Grids.around(
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
      yield* Grids.around({
        // deno-lint-ignore require-yield
        *open(): Operation<unknown> {
          throw new Error("this host does not open grids");
        },
      });
      try {
        yield* Grids.operations.open(request());
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal instanceof Error ? refusal.message : "").toBe("this host does not open grids");
    expect(reached).toEqual([]);
  });
});

describe("Tier TG — the composite contract", () => {
  it("TP3: a prepared composite presents nothing until it is attached", function* () {
    const log = gridProviderLog();
    const events = yield* scoped(function* () {
      yield* prepareControlledComposite(request(), { log });
      return [...log.events];
    });

    // A composite the reader can see before every pane is ready is the one
    // thing atomic startup forbids.
    expect(events).toEqual(["prepare:0:2x1"]);
    expect(events.some((event) => event.startsWith("attach:"))).toBe(false);
  });

  it("TP3: attach, update, display, shell and destroy record in order", function* () {
    const log = gridProviderLog();
    const spawns: number[] = [];
    yield* scoped(function* () {
      const composite = yield* prepareControlledComposite(request(), { log });
      yield* composite.update(0, "starting");
      yield* composite.display(0, "pane text");
      yield* composite.update(0, "running");
      yield* composite.shell(1, () => spawns.push(1));
      yield* composite.attach();
      yield* composite.update(0, "succeeded");
      yield* composite.closed();
      yield* composite.destroy();
    });

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
    // The default shell starts, and says so through the latch it was handed:
    // readiness is reported by the shell rather than assumed by the grid.
    expect(spawns).toEqual([1]);
  });

  it("TP4: a shell that never starts never reports a spawn", function* () {
    const spawns: number[] = [];
    const outcome = yield* scoped(function* () {
      const composite = yield* prepareControlledComposite(request(), {
        // deno-lint-ignore require-yield
        *shell() {
          // No spawn event: nothing started, so nothing is acknowledged.
          return { exitCode: 127 };
        },
      });
      return yield* composite.shell(1, () => spawns.push(1));
    });

    expect(outcome).toEqual({ exitCode: 127 });
    expect(spawns).toEqual([]);
  });

  it("TP4: a preparation failure leaves no composite to tear down", function* () {
    const log = gridProviderLog();
    let refusal: unknown;
    yield* scoped(function* () {
      try {
        yield* prepareControlledComposite(request(), {
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
    // The failure happened before the composite existed, so nothing is owed a
    // destroy.
    expect(log.events).toEqual([]);
  });

  it("TP4: a composite refuses to be destroyed twice", function* () {
    let refusal: unknown;
    yield* scoped(function* () {
      const composite = yield* prepareControlledComposite(request());
      yield* composite.destroy();
      try {
        yield* composite.destroy();
      } catch (error) {
        refusal = error;
      }
    });

    // Teardown ordering is only readable if a double destroy is loud. A silent
    // second destroy would let a suite prove an ordering that never held.
    expect(refusal instanceof Error ? refusal.message : "").toContain("destroyed twice");
  });

  it("TP5: each preparation is its own composite", function* () {
    const log = gridProviderLog();
    yield* scoped(function* () {
      const first = yield* prepareControlledComposite(request(), { log }, 0);
      const second = yield* prepareControlledComposite(request(), { log }, 1);
      yield* first.destroy();
      yield* second.destroy();
    });

    // Two expansions are two grids. A provider that handed the same composite
    // back would have presented the second expansion's grid as the first's.
    expect(log.events).toEqual(["prepare:0:2x1", "prepare:1:2x1", "destroy:0", "destroy:1"]);
  });
});
