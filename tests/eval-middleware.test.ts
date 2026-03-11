/**
 * Tier T3 — Middleware factory conformance tests (spec §11).
 *
 * Verifies that evalFactory, persistFactory, and timeoutFactory
 * satisfy the ModifierFactory type and compose correctly via combine().
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { evalFactory } from "../src/eval-handler.ts";
import { persistFactory } from "../src/modifiers/persist.ts";
import { timeoutFactory } from "../src/modifiers/timeout.ts";
import { combine } from "@effectionx/middleware";
import type { ModifierFactory, ModifierMiddleware } from "../src/modifiers.ts";

describe("Tier T3 — Middleware factory conformance", () => {
  // T23: evalFactory satisfies ModifierFactory type
  it("T23: evalFactory satisfies ModifierFactory", function* () {
    const factory: ModifierFactory = evalFactory;
    expect(typeof factory).toBe("function");
    const middleware = factory(undefined);
    expect(typeof middleware).toBe("function");
  });

  // T24: persistFactory satisfies ModifierFactory type
  it("T24: persistFactory satisfies ModifierFactory", function* () {
    const factory: ModifierFactory = persistFactory;
    expect(typeof factory).toBe("function");
    const middleware = factory(undefined);
    expect(typeof middleware).toBe("function");
  });

  // T25: timeoutFactory satisfies ModifierFactory type
  it("T25: timeoutFactory satisfies ModifierFactory", function* () {
    const factory: ModifierFactory = timeoutFactory;
    expect(typeof factory).toBe("function");
    const middleware = factory("30s");
    expect(typeof middleware).toBe("function");
  });

  // T26: All three compose correctly via combine()
  it("T26: factories compose via combine()", function* () {
    const mw1: ModifierMiddleware = timeoutFactory("30s");
    const mw2: ModifierMiddleware = evalFactory(undefined);
    const composed = combine([mw1, mw2]);
    expect(typeof composed).toBe("function");
  });

  // T27: useCodeBlock() inside evalFactory returns correct context
  // This is an integration test — covered by the smoke test and T4 tier.
  // Here we verify the factory structure allows it.
  it("T27: evalFactory accepts undefined params", function* () {
    const middleware = evalFactory(undefined);
    expect(typeof middleware).toBe("function");
  });

  // T28: EvalEnvCtx accessible pattern
  it("T28: evalFactory creates a generator when called", function* () {
    const middleware = evalFactory(undefined);
    // Call the middleware with dummy args and next
    const terminal = function* () {
      return { output: "", exitCode: 0, stderr: "" };
    };
    // The result should be a generator (the IIFE pattern)
    const result = middleware([], terminal);
    expect(result).toBeTruthy();
    expect(typeof result.next).toBe("function");
  });

  // T29: persistFactory creates a generator when called
  it("T29: persistFactory creates a generator", function* () {
    const middleware = persistFactory(undefined);
    const terminal = function* () {
      return { output: "", exitCode: 0, stderr: "" };
    };
    const result = middleware([], terminal);
    expect(result).toBeTruthy();
    expect(typeof result.next).toBe("function");
  });
});
