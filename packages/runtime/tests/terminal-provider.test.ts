/**
 * Tier TG — the terminal provider boundary (architecture.md §Terminal
 * authority, spec §6.21).
 *
 * What a host installs to present a grid, and what composing middleware around
 * it may and may not do. Nothing here opens a terminal, looks for a
 * multiplexer, or starts a process: the whole point of the boundary is that the
 * language does not depend on any of that, so a suite that needed one would be
 * testing the wrong thing.
 *
 * The controlled provider records what it was asked to do, in order. Ordering
 * claims are read off that record rather than inferred from timing, because a
 * grid that attached too early and a grid that attached on time can take the
 * same wall clock.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import {
  installControlledTerminalProvider,
  prepareTerminalGrid,
  TERMINAL_PROVIDER_UNAVAILABLE,
  TerminalProvider,
  TerminalProviderUnavailableError,
} from "../terminal.ts";
import type { TerminalComposite, TerminalGridRequest, TerminalProviderLog } from "../terminal.ts";

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

function log(): TerminalProviderLog {
  return { events: [] };
}

describe("Tier TG — the provider boundary", () => {
  it("TP1: refuses when no host has installed a provider", function* () {
    let refusal: unknown;
    yield* scoped(function* () {
      try {
        yield* prepareTerminalGrid(request());
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(TerminalProviderUnavailableError);
    expect(refusal instanceof Error ? refusal.message : "").toBe(TERMINAL_PROVIDER_UNAVAILABLE);
  });

  it("TP2: an installed provider prepares without presenting anything", function* () {
    const record = log();
    const events = yield* scoped(function* () {
      yield* installControlledTerminalProvider({ log: record });
      yield* prepareTerminalGrid(request());
      return [...record.events];
    });

    // Preparation happened; nothing was shown. A composite the reader can see
    // before every pane is ready is the one thing atomic startup forbids.
    expect(events).toEqual(["prepare:0:2x1"]);
    expect(events.some((event) => event.startsWith("attach:"))).toBe(false);
  });

  it("TP2: attach, update, shell and destroy are recorded in the order they happen", function* () {
    const record = log();
    const spawns: number[] = [];
    yield* scoped(function* () {
      yield* installControlledTerminalProvider({ log: record });
      const composite = yield* prepareTerminalGrid(request());
      yield* composite.update(0, "starting");
      yield* composite.update(0, "running");
      yield* composite.shell(1, () => spawns.push(1));
      yield* composite.attach();
      yield* composite.update(0, "succeeded");
      yield* composite.closed();
      yield* composite.destroy();
    });

    expect(record.events).toEqual([
      "prepare:0:2x1",
      "state:0:0:starting",
      "state:0:0:running",
      "shell:0:1",
      "attach:0",
      "state:0:0:succeeded",
      "closed:0",
      "destroy:0",
    ]);
    // The default shell starts, and says so through the latch it was handed:
    // readiness is reported by the shell rather than assumed by the grid.
    expect(spawns).toEqual([1]);
  });

  it("TP5: a shell that never starts never reports a spawn", function* () {
    const spawns: number[] = [];
    const outcome = yield* scoped(function* () {
      yield* installControlledTerminalProvider({
        // deno-lint-ignore require-yield
        *shell(_ordinal, _spawned) {
          // No spawn event: nothing started, so nothing is acknowledged.
          return { exitCode: 127 };
        },
      });
      const composite = yield* prepareTerminalGrid(request());
      return yield* composite.shell(1, () => spawns.push(1));
    });

    expect(outcome).toEqual({ exitCode: 127 });
    expect(spawns).toEqual([]);
  });

  it("TP3: middleware observes a delegated request without changing it", function* () {
    const record = log();
    const seen: TerminalGridRequest[] = [];
    yield* scoped(function* () {
      yield* installControlledTerminalProvider({ log: record });
      yield* TerminalProvider.around({
        *prepare([asked], next) {
          seen.push(asked);
          return yield* next(asked);
        },
      });
      yield* prepareTerminalGrid(request({ columns: 3, rows: 2 }));
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.columns).toBe(3);
    // Observation is not interference: the provider still saw the same grid.
    expect(record.events).toEqual(["prepare:0:3x2"]);
  });

  it("TP3: middleware refuses a request, and no composite is ever built", function* () {
    const record = log();
    let refusal: unknown;
    yield* scoped(function* () {
      yield* installControlledTerminalProvider({ log: record });
      yield* TerminalProvider.around({
        // deno-lint-ignore require-yield
        *prepare(): Operation<TerminalComposite> {
          throw new Error("this host does not open terminal grids");
        },
      });
      try {
        yield* prepareTerminalGrid(request());
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal instanceof Error ? refusal.message : "").toBe(
      "this host does not open terminal grids",
    );
    // Refusing means refusing: the provider below was never reached, so there
    // is no hidden composite left needing teardown.
    expect(record.events).toEqual([]);
  });

  it("TP3: middleware narrows a request before the provider sees it", function* () {
    const record = log();
    yield* scoped(function* () {
      yield* installControlledTerminalProvider({ log: record });
      yield* TerminalProvider.around({
        *prepare([asked], next) {
          return yield* next({ ...asked, columns: 1, rows: asked.panes.length });
        },
      });
      yield* prepareTerminalGrid(request());
    });

    expect(record.events).toEqual(["prepare:0:1x2"]);
  });

  it("TP4: middleware wraps the composite it delegated for", function* () {
    const record = log();
    const wrapped: string[] = [];
    yield* scoped(function* () {
      yield* installControlledTerminalProvider({ log: record });
      yield* TerminalProvider.around({
        *prepare([asked], next) {
          const composite = yield* next(asked);
          return {
            ...composite,
            *attach() {
              wrapped.push("before");
              yield* composite.attach();
              wrapped.push("after");
            },
          };
        },
      });
      const composite = yield* prepareTerminalGrid(request());
      yield* composite.attach();
      yield* composite.destroy();
    });

    expect(wrapped).toEqual(["before", "after"]);
    expect(record.events).toEqual(["prepare:0:2x1", "attach:0", "destroy:0"]);
  });

  it("TP5: a preparation failure leaves nothing to tear down", function* () {
    const record = log();
    let refusal: unknown;
    yield* scoped(function* () {
      yield* installControlledTerminalProvider({
        log: record,
        // deno-lint-ignore require-yield
        *onPrepare() {
          throw new Error("no pane endpoint could be created");
        },
      });
      try {
        yield* prepareTerminalGrid(request());
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal instanceof Error ? refusal.message : "").toBe(
      "no pane endpoint could be created",
    );
    // The failure happened before the composite existed, so the record shows
    // no composite was built and none is owed a destroy.
    expect(record.events).toEqual([]);
  });

  it("TP5: a composite refuses to be destroyed twice", function* () {
    let refusal: unknown;
    yield* scoped(function* () {
      yield* installControlledTerminalProvider();
      const composite = yield* prepareTerminalGrid(request());
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

  it("TP6: each preparation is its own composite", function* () {
    const record = log();
    yield* scoped(function* () {
      yield* installControlledTerminalProvider({ log: record });
      const first = yield* prepareTerminalGrid(request());
      const second = yield* prepareTerminalGrid(request());
      yield* first.destroy();
      yield* second.destroy();
    });

    // Two expansions are two grids. A provider that handed the same composite
    // back would have presented the second expansion's grid as the first's.
    expect(record.events).toEqual(["prepare:0:2x1", "prepare:1:2x1", "destroy:0", "destroy:1"]);
  });
});
