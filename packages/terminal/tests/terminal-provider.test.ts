/**
 * Tier TG — the routing surface and the provider host contract
 * (architecture.md §Terminal grid presentation).
 *
 * Two things live here, and neither decides anything. The routing surface is
 * where middleware composes around a grid request, and its whole contract is
 * that it decides nothing: `open()` answers `unknown`, and the lifecycle throws
 * the answer away. The host is what a provider supplies as a resource, and its
 * contract is ordering — prepared hidden, converged serially, shown once,
 * destroyed exactly once.
 *
 * Who may present a grid, and what presenting one authorizes, is proved in
 * `terminal-grid.test.ts`.
 *
 * Nothing here opens a terminal, looks for a multiplexer, or starts a process.
 * The state a host observes is scripted by the row, so every claim about what
 * the renderer did is read off a record rather than inferred from timing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createQueue, race, resource, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Queue } from "effection";

import {
  TERMINAL_PROVIDER_UNAVAILABLE,
  TerminalGrids,
  TerminalProviderUnavailableError,
} from "../mod.ts";
import type {
  TerminalCellId,
  TerminalCellState,
  TerminalGridHost,
  TerminalGridRequest,
  TerminalGridState,
  TerminalGridView,
  TerminalShellOutcome,
} from "../mod.ts";
import {
  controlledTerminalProvider,
  gate,
  rendererEndedMessage,
  subscriptionEndedMessage,
  terminalProviderLog,
} from "../test/mod.ts";
import type { ControlledProviderOptions, TerminalProviderLog } from "../test/mod.ts";

/** A two-by-one grid: the smallest request that still has two positions. */
function request(overrides: Partial<TerminalGridRequest> = {}): TerminalGridRequest {
  return {
    columns: 2,
    rows: 1,
    cells: [
      { title: "Agent", row: 0, column: 0, form: "paired" },
      { title: "Shell", row: 0, column: 1, form: "self-closing" },
    ],
    ...overrides,
  };
}

const IDENTITIES: TerminalCellId[] = [Symbol("agent"), Symbol("shell")];

/** One snapshot, at `revision`, with whatever this row wants to say. */
function snapshot(revision: number, overrides: Partial<TerminalGridState> = {}): TerminalGridState {
  const cells = IDENTITIES.map((cellId, index): TerminalCellState => {
    const cell: TerminalCellState = {
      cellId,
      title: index === 0 ? "Agent" : "Shell",
      row: 0,
      column: index,
      status: "starting",
      content: "",
    };
    return Object.freeze(cell);
  });
  const state: TerminalGridState = {
    revision,
    phase: "preparing",
    columns: 2,
    rows: 1,
    cells: Object.freeze(cells),
    ...overrides,
  };
  return Object.freeze(state);
}

/**
 * A view the row writes to.
 *
 * The provider is the thing under test here, so the state it observes is
 * scripted rather than produced by a running grid.
 */
interface ScriptedView {
  readonly view: TerminalGridView;
  push(state: TerminalGridState): void;
}

function scriptedView(initial: TerminalGridState): ScriptedView {
  const queue: Queue<TerminalGridState, never> = createQueue<TerminalGridState, never>();
  queue.add(initial);
  return {
    view: {
      states: {
        // deno-lint-ignore require-yield
        *[Symbol.iterator]() {
          return { next: () => queue.next() };
        },
      },
    },
    push: (state) => queue.add(state),
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
        { at: "min" },
      );
      yield* TerminalGrids.around({
        *open([asked], next) {
          return yield* next({ ...asked, columns: 1, rows: asked.cells.length });
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

/** Acquire one controlled host over a scripted view. */
function useScriptedHost(
  script: ScriptedView,
  options: ControlledProviderOptions,
): Operation<TerminalGridHost> {
  return controlledTerminalProvider(options).host(request(), script.view);
}

describe("Tier TG — the provider host contract", () => {
  it("TP3: an acquired host presents nothing until it is shown", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));
    const events = yield* scoped(function* () {
      yield* useScriptedHost(script, { log });
      yield* untilApplied(log, 0);
      return [...log.events];
    });

    // A grid the reader can see before every cell is ready is the one thing
    // atomic startup forbids.
    expect(events).toEqual([
      "prepare:0:2x1",
      "render:0:0",
      "status:0:0:starting",
      "status:0:1:starting",
    ]);
    expect(events.some((event) => event.startsWith("show:"))).toBe(false);
  });

  it("TP4: revision zero arrives with the subscription, and newer ones in order", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));

    yield* scoped(function* () {
      const host = yield* useScriptedHost(script, { log });
      yield* untilApplied(log, 0);
      script.push(snapshot(1, { phase: "visible" }));
      yield* host.converge(1);
      script.push(snapshot(2, { phase: "closing" }));
      yield* host.converge(2);
    });

    expect(log.applied.map((state) => state.revision)).toEqual([0, 1, 2]);
  });

  it("TP5: a blocked render coalesces forward, and its waiters are satisfied by the newer state", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));
    const held = gate();
    const reachedOne = gate();
    const waiters: string[] = [];

    yield* scoped(function* () {
      const host = yield* useScriptedHost(script, {
        log,
        *render(state) {
          if (state.revision === 1) {
            reachedOne.open();
            yield* held.opened;
          }
        },
      });
      yield* untilApplied(log, 0);

      script.push(snapshot(1, { phase: "visible" }));
      yield* reachedOne.opened;
      // Both arrive while revision 1 is still being applied.
      script.push(snapshot(2, { phase: "closing" }));
      script.push(snapshot(3, { phase: "closed" }));

      const two = yield* spawn(function* () {
        yield* host.converge(2);
        waiters.push(`two:${log.applied[log.applied.length - 1]!.revision}`);
      });
      const three = yield* spawn(function* () {
        yield* host.converge(3);
        waiters.push("three");
      });

      held.open();
      yield* two;
      yield* three;
    });

    // One then three: the intermediate snapshot is subsumed by the newest
    // pending one, and an older revision is never applied after a newer one.
    expect(log.applied.map((state) => state.revision)).toEqual([0, 1, 3]);
    // The waiter for two completed from three, because a complete aggregate at
    // three contains everything two described.
    expect(waiters).toContain("two:3");
    expect(waiters).toContain("three");
  });

  it("TP6: applied advances only after the whole render effect succeeds", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));
    let converged = false;
    let failure: Error | undefined;

    yield* scoped(function* () {
      const host = yield* useScriptedHost(script, {
        log,
        // deno-lint-ignore require-yield
        *render(state) {
          if (state.revision === 1) {
            throw new Error("this renderer could not draw revision 1");
          }
        },
      });
      yield* untilApplied(log, 0);
      script.push(snapshot(1, { phase: "visible" }));

      failure = yield* race([
        host.failed,
        (function* (): Operation<Error> {
          yield* host.converge(1);
          converged = true;
          return new Error("unreachable");
        })(),
      ]);
    });

    expect(failure?.message).toBe("this renderer could not draw revision 1");
    // Nothing was applied past the render that failed, and no waiter was told
    // the screen had caught up.
    expect(converged).toBe(false);
    expect(log.applied.map((state) => state.revision)).toEqual([0]);
  });

  it("TP7: a state subscription that stops while acquired is a provider failure", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));
    const stop = gate();
    let failure: Error | undefined;
    let closed = false;

    yield* scoped(function* () {
      const host = yield* useScriptedHost(script, {
        log,
        close: () => suspend(),
        stopSubscription: () => stop.opened,
      });
      yield* untilApplied(log, 0);
      yield* spawn(function* () {
        yield* host.closed;
        closed = true;
      });
      stop.open();
      failure = yield* host.failed;
    });

    expect(failure?.message).toBe(subscriptionEndedMessage());
    // Failure and reader close are independent observations.
    expect(closed).toBe(false);
  });

  it("TP8: a renderer that stops while acquired is a provider failure", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));
    const stop = gate();
    let failure: Error | undefined;
    let closed = false;

    yield* scoped(function* () {
      const host = yield* useScriptedHost(script, {
        log,
        close: () => suspend(),
        stopRenderer: () => stop.opened,
      });
      yield* untilApplied(log, 0);
      yield* spawn(function* () {
        yield* host.closed;
        closed = true;
      });
      stop.open();
      failure = yield* host.failed;
    });

    expect(failure?.message).toBe(rendererEndedMessage());
    expect(closed).toBe(false);
  });

  it("TP9: an ordinary release settles neither closed nor failed", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));
    let closed = false;
    let failed = false;

    yield* scoped(function* () {
      yield* scoped(function* () {
        const host = yield* useScriptedHost(script, { log, close: () => suspend() });
        yield* untilApplied(log, 0);
        yield* spawn(function* () {
          yield* host.closed;
          closed = true;
        });
        yield* spawn(function* () {
          yield* host.failed;
          failed = true;
        });
      });
    });

    expect(closed).toBe(false);
    expect(failed).toBe(false);
    // Released once, with nothing still held.
    expect(log.events.filter((event) => event === "destroy:0")).toEqual(["destroy:0"]);
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
  });

  it("TP10: a shell that never starts is never acquired, and leaves no record", function* () {
    const log = terminalProviderLog();
    const script = scriptedView(snapshot(0));
    let refusal: unknown;

    yield* scoped(function* () {
      const host = yield* useScriptedHost(script, {
        log,
        close: () => suspend(),
        shell: () =>
          resource<Operation<TerminalShellOutcome>>(function* () {
            // Fails before it provides: nothing started, so nothing is owed an
            // outcome and no cell could call this ready.
            throw new Error("no child could be spawned");
          }),
      });
      yield* untilApplied(log, 0);
      try {
        yield* yield* host.shell(IDENTITIES[1]!);
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal instanceof Error ? refusal.message : "").toBe("no child could be spawned");
    expect(log.events.some((event) => event.startsWith("shell:"))).toBe(false);
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
  });

  it("TP11: release happens once, whatever ended the host", function* () {
    const log = terminalProviderLog();
    // One provider, three hosts: the generation in the record is how a suite
    // tells a second host apart from the first.
    const provider = controlledTerminalProvider({ log, close: () => suspend() });

    // Settled normally.
    yield* scoped(function* () {
      const script = scriptedView(snapshot(0));
      yield* provider.host(request(), script.view);
      yield* untilApplied(log, 0);
    });
    // Cancelled while live.
    yield* scoped(function* () {
      const script = scriptedView(snapshot(0));
      const holding = withResolvers<void>();
      const task = yield* spawn(function* () {
        yield* scoped(function* () {
          yield* provider.host(request(), script.view);
          holding.resolve();
          yield* suspend();
        });
      });
      yield* holding.operation;
      yield* task.halt();
    });
    // Failed after acquisition.
    yield* scoped(function* () {
      const script = scriptedView(snapshot(0));
      try {
        yield* scoped(function* () {
          yield* provider.host(request(), script.view);
          throw new Error("the provider failed");
        });
      } catch {
        // The failure is the point; the release is what is being counted.
      }
    });

    // One destroy each, and nothing left holding anything. A resource cannot be
    // released twice, which is why there is no way to call one by hand.
    for (const generation of [0, 1, 2]) {
      expect(log.events.filter((event) => event === `destroy:${generation}`)).toEqual([
        `destroy:${generation}`,
      ]);
    }
    expect(log.live).toEqual({ grids: 0, shown: 0, activities: 0 });
  });
});

/** Settles once the renderer has applied a snapshot at least `revision`. */
function untilApplied(log: TerminalProviderLog, revision: number): Operation<void> {
  return {
    *[Symbol.iterator]() {
      while (!log.applied.some((state) => state.revision >= revision)) {
        const settled = withResolvers<void>();
        queueMicrotask(() => settled.resolve());
        yield* settled.operation;
      }
    },
  };
}
