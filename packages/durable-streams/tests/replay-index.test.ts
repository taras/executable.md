// deno-lint-ignore-file require-yield

/**
 * ReplayIndex unit tests.
 *
 * Tests the spec-compliant replay index (§4.1) in isolation.
 * No Effection dependency — pure data structure.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ReplayIndex } from "../replay-index.ts";
import type { DurableEvent, Json } from "../types.ts";

function yieldEvent<T extends Json>(
  coroutineId: string,
  type: string,
  name: string,
  value?: T,
): DurableEvent {
  const result = value === undefined ? { status: "ok" as const } : { status: "ok" as const, value };

  return {
    type: "yield",
    coroutineId,
    description: { type, name },
    result,
  };
}

function closeEvent<T extends Json>(
  coroutineId: string,
  status: "ok" | "err" | "cancelled" = "ok",
  value?: T,
): DurableEvent {
  if (status === "ok") {
    const result =
      value === undefined ? { status: "ok" as const } : { status: "ok" as const, value };

    return {
      type: "close",
      coroutineId,
      result,
    };
  }
  if (status === "err") {
    return {
      type: "close",
      coroutineId,
      result: { status: "err", error: { message: String(value ?? "error") } },
    };
  }
  return { type: "close", coroutineId, result: { status: "cancelled" } };
}

describe("ReplayIndex", () => {
  describe("empty index", () => {
    it("peekYield returns undefined", function* () {
      const idx = new ReplayIndex([]);
      expect(idx.peekYield("root")).toBeUndefined();
      expect(idx.peekYield("root.0")).toBeUndefined();
    });

    it("hasClose returns false", function* () {
      const idx = new ReplayIndex([]);
      expect(idx.hasClose("root")).toBe(false);
    });

    it("getClose returns undefined", function* () {
      const idx = new ReplayIndex([]);
      expect(idx.getClose("root")).toBeUndefined();
    });

    it("isFullyReplayed returns false", function* () {
      const idx = new ReplayIndex([]);
      expect(idx.isFullyReplayed("root")).toBe(false);
    });

    it("getCursor returns 0", function* () {
      const idx = new ReplayIndex([]);
      expect(idx.getCursor("root")).toBe(0);
    });

    it("yieldCount returns 0", function* () {
      const idx = new ReplayIndex([]);
      expect(idx.yieldCount("root")).toBe(0);
    });
  });

  describe("single yield", () => {
    it("peekYield returns the entry", function* () {
      const idx = new ReplayIndex([yieldEvent("root.0", "call", "fetchOrder", 42)]);
      const entry = idx.peekYield("root.0");
      expect(entry?.description).toEqual({ type: "call", name: "fetchOrder" });
      expect(entry?.result).toEqual({ status: "ok", value: 42 });
    });

    it("consumeYield advances cursor", function* () {
      const idx = new ReplayIndex([yieldEvent("root.0", "call", "fetchOrder", 42)]);
      expect(idx.getCursor("root.0")).toBe(0);
      idx.consumeYield("root.0");
      expect(idx.getCursor("root.0")).toBe(1);
      expect(idx.peekYield("root.0")).toBeUndefined();
    });

    it("yieldCount is 1", function* () {
      const idx = new ReplayIndex([yieldEvent("root.0", "call", "fetchOrder")]);
      expect(idx.yieldCount("root.0")).toBe(1);
    });
  });

  describe("multiple yields", () => {
    it("cursor advances through sequence", function* () {
      const idx = new ReplayIndex([
        yieldEvent("root.0", "sleep", "sleep"),
        yieldEvent("root.0", "call", "transform", "ALPHA"),
      ]);

      expect(idx.yieldCount("root.0")).toBe(2);

      // First peek
      expect(idx.peekYield("root.0")?.description).toEqual({
        type: "sleep",
        name: "sleep",
      });
      idx.consumeYield("root.0");

      // Second peek
      expect(idx.peekYield("root.0")?.description).toEqual({
        type: "call",
        name: "transform",
      });
      expect(idx.peekYield("root.0")?.result).toEqual({
        status: "ok",
        value: "ALPHA",
      });
      idx.consumeYield("root.0");

      // Exhausted
      expect(idx.peekYield("root.0")).toBeUndefined();
      expect(idx.getCursor("root.0")).toBe(2);
    });
  });

  describe("close events", () => {
    it("hasClose returns true", function* () {
      const idx = new ReplayIndex([closeEvent("root.0", "ok", "done")]);
      expect(idx.hasClose("root.0")).toBe(true);
    });

    it("getClose returns the event", function* () {
      const close = closeEvent("root.0", "ok", "done");
      const idx = new ReplayIndex([close]);
      expect(idx.getClose("root.0")).toEqual(close);
    });

    it("cancelled: getClose returns cancelled result", function* () {
      const close = closeEvent("root.0", "cancelled");
      const idx = new ReplayIndex([close]);
      expect(idx.getClose("root.0")?.result).toEqual({ status: "cancelled" });
    });

    it("error: getClose returns error result", function* () {
      const close = closeEvent("root.0", "err", "boom");
      const idx = new ReplayIndex([close]);
      expect(idx.getClose("root.0")?.result).toEqual({
        status: "err",
        error: { message: "boom" },
      });
    });

    it("getClose returns undefined when replay is disabled", function* () {
      const close = closeEvent("root.0", "ok", "done");
      const idx = new ReplayIndex([close]);
      idx.disableReplay("root.0");
      expect(idx.getClose("root.0")).toBeUndefined();
    });
  });

  describe("isFullyReplayed", () => {
    it("true when all yields consumed and close exists", function* () {
      const idx = new ReplayIndex([
        yieldEvent("root.0", "call", "fetch", 1),
        yieldEvent("root.0", "call", "transform", 2),
        closeEvent("root.0", "ok", "done"),
      ]);

      expect(idx.isFullyReplayed("root.0")).toBe(false); // yields not consumed
      idx.consumeYield("root.0");
      expect(idx.isFullyReplayed("root.0")).toBe(false); // 1 yield remaining
      idx.consumeYield("root.0");
      expect(idx.isFullyReplayed("root.0")).toBe(true); // all consumed + close exists
    });

    it("false when yields consumed but no close", function* () {
      const idx = new ReplayIndex([yieldEvent("root.0", "call", "fetch", 1)]);

      idx.consumeYield("root.0");
      expect(idx.isFullyReplayed("root.0")).toBe(false); // no close
    });

    it("false when close exists but yields not consumed", function* () {
      const idx = new ReplayIndex([yieldEvent("root.0", "call", "fetch", 1), closeEvent("root.0")]);

      expect(idx.isFullyReplayed("root.0")).toBe(false);
    });
  });

  describe("interleaved events", () => {
    it("per-coroutine cursors are independent", function* () {
      const idx = new ReplayIndex([
        yieldEvent("root.0.0", "call", "fetchUser", { name: "alice" }),
        yieldEvent("root.0.1", "call", "fetchUser", { name: "bob" }),
        closeEvent("root.0.0", "ok", { name: "alice" }),
        closeEvent("root.0.1", "ok", { name: "bob" }),
        yieldEvent("root.0", "call", "merge", "merged"),
        closeEvent("root.0", "ok", "done"),
      ]);

      // Each coroutine has its own cursor
      expect(idx.peekYield("root.0.0")?.description.name).toBe("fetchUser");
      expect(idx.peekYield("root.0.1")?.description.name).toBe("fetchUser");
      expect(idx.peekYield("root.0")?.description.name).toBe("merge");

      // Consuming one doesn't affect others
      idx.consumeYield("root.0.0");
      expect(idx.peekYield("root.0.0")).toBeUndefined();
      expect(idx.peekYield("root.0.1")?.description.name).toBe("fetchUser");
      expect(idx.peekYield("root.0")?.description.name).toBe("merge");

      // Full replay status
      expect(idx.isFullyReplayed("root.0.0")).toBe(true); // consumed + close
      expect(idx.isFullyReplayed("root.0.1")).toBe(false); // not consumed
      expect(idx.isFullyReplayed("root.0")).toBe(false); // not consumed
    });
  });

  describe("race scenario", () => {
    it("partial execution with cancellation", function* () {
      // From spec §10.1: race([op1, op2]) where op1 wins after op2 partially executed
      const idx = new ReplayIndex([
        yieldEvent("root.0.1", "call", "step1", null), // op2's first effect
        yieldEvent("root.0.0", "call", "fetch", "data"), // op1 completes
        closeEvent("root.0.0", "ok", "data"), // op1 done
        closeEvent("root.0.1", "cancelled"), // op2 cancelled
        closeEvent("root.0", "ok", "data"), // race returns op1's result
      ]);

      // op1 (root.0.0): one yield, then close(ok)
      expect(idx.yieldCount("root.0.0")).toBe(1);
      expect(idx.hasClose("root.0.0")).toBe(true);
      expect(idx.getClose("root.0.0")?.result.status).toBe("ok");

      // op2 (root.0.1): one yield, then close(cancelled)
      expect(idx.yieldCount("root.0.1")).toBe(1);
      expect(idx.hasClose("root.0.1")).toBe(true);
      expect(idx.getClose("root.0.1")?.result.status).toBe("cancelled");

      // race scope (root.0): no yields, just close
      expect(idx.yieldCount("root.0")).toBe(0);
      expect(idx.hasClose("root.0")).toBe(true);

      // After consuming op2's yield, it's fully replayed (close exists)
      idx.consumeYield("root.0.1");
      expect(idx.isFullyReplayed("root.0.1")).toBe(true);
    });
  });

  describe("unknown coroutine", () => {
    it("consuming yield advances cursor", function* () {
      const idx = new ReplayIndex([]);
      idx.consumeYield("nonexistent");
      expect(idx.getCursor("nonexistent")).toBe(1);
      expect(idx.peekYield("nonexistent")).toBeUndefined();
    });
  });

  describe("sequential workflow", () => {
    it("matches spec §11.4 example", function* () {
      const idx = new ReplayIndex([
        yieldEvent("root.0", "sleep", "sleep"),
        yieldEvent("root.0", "call", "transform", "ALPHA"),
        closeEvent("root.0", "ok", "ALPHA"),
        closeEvent("root", "ok", "ALPHA"),
      ]);

      // root.0 has 2 yields
      expect(idx.yieldCount("root.0")).toBe(2);

      // Consume both
      idx.consumeYield("root.0");
      idx.consumeYield("root.0");
      expect(idx.isFullyReplayed("root.0")).toBe(true);

      // root has 0 yields but has a close
      expect(idx.yieldCount("root")).toBe(0);
      expect(idx.isFullyReplayed("root")).toBe(true);
    });
  });
});

/**
 * Ordering — indexing reads identity, never a Yield's result.
 *
 * A replay guard's check phase runs after the index is built and before
 * anything is replayed, so a guard that would refuse an event has to get its
 * chance before the stream is asked what that event settled to. Reading
 * eagerly took that chance away: a backend that could not produce a result
 * failed inside construction, carrying its own error out past every guard.
 *
 * These are unit-level on purpose. The consequence for a document run is
 * covered in `@executablemd/core`'s Tier TX; what belongs here is the ordering
 * property itself.
 */
describe("ReplayIndex — result access ordering", () => {
  /** A Yield whose result refuses to be read, counting attempts. */
  function refusingYield(coroutineId: string, reads: { count: number }): DurableEvent {
    const event: Record<string, unknown> = {
      type: "yield",
      coroutineId,
      description: { type: "call", name: "work" },
    };
    Object.defineProperty(event, "result", {
      enumerable: true,
      get() {
        reads.count++;
        throw new Error("the backend will not produce this result");
      },
    });
    return event as unknown as DurableEvent;
  }

  it("builds an index over a Yield whose result cannot be read", function* () {
    const reads = { count: 0 };
    const index = new ReplayIndex([refusingYield("root", reads)]);

    // Construction completed, and it never asked.
    expect(reads.count).toBe(0);
    // Identity is indexed, because indexing is what identity is for.
    expect(index.yieldCount("root")).toBe(1);
    expect(index.peekYield("root")?.description).toEqual({ type: "call", name: "work" });
    expect(index.hasAnyUnconsumedYields()).toBe(true);
    // Still never asked: peeking is not consuming.
    expect(reads.count).toBe(0);
  });

  it("reads the result only when a consumer asks for it", function* () {
    const reads = { count: 0 };
    const index = new ReplayIndex([refusingYield("root", reads)]);
    const entry = index.peekYield("root");
    expect(entry).toBeDefined();

    let caught: unknown;
    try {
      void entry?.result;
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.message).toBe("the backend will not produce this result");
    expect(reads.count).toBe(1);
  });

  it("reads a result once, so a changing source cannot change replay", function* () {
    let answers = 0;
    const event: Record<string, unknown> = {
      type: "yield",
      coroutineId: "root",
      description: { type: "call", name: "work" },
    };
    Object.defineProperty(event, "result", {
      enumerable: true,
      get() {
        answers++;
        return { status: "ok", value: answers };
      },
    });

    const index = new ReplayIndex([event as unknown as DurableEvent]);
    const entry = index.peekYield("root");
    expect(entry?.result).toEqual({ status: "ok", value: 1 });
    expect(entry?.result).toEqual({ status: "ok", value: 1 });
    expect(index.peekYield("root")?.result).toEqual({ status: "ok", value: 1 });
    expect(answers).toBe(1);
  });
});
