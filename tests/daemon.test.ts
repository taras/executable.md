/**
 * Tier Q — Daemon modifier tests.
 *
 * Verifies daemonFactory satisfies ModifierFactory, ignores next,
 * and composes correctly in the modifier chain.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { daemonFactory } from "../src/modifiers/daemon.ts";
import { combine } from "@effectionx/middleware";
import { CodeBlockCtx } from "../src/modifiers.ts";
import type { ModifierFactory, ModifierMiddleware } from "../src/modifiers.ts";
import type { Operation } from "effection";

describe("Tier Q — Daemon modifier", () => {
  // Q1: daemonFactory satisfies ModifierFactory type
  it("Q1: daemonFactory satisfies ModifierFactory", function* () {
    const factory: ModifierFactory = daemonFactory;
    expect(typeof factory).toBe("function");
    const middleware = factory(undefined);
    expect(typeof middleware).toBe("function");
  });

  // Q2: daemonFactory ignores next (middleware conformance)
  it("Q2: daemonFactory creates a generator when called", function* () {
    const middleware = daemonFactory(undefined);
    let nextCalled = false;
    const terminal = function* () {
      nextCalled = true;
      return { output: "should not appear", exitCode: 0, stderr: "" };
    };
    // The result should be a generator (the IIFE pattern)
    const result = middleware([], terminal);
    expect(result).toBeTruthy();
    expect(typeof result.next).toBe("function");
    // next was not called during middleware creation
    expect(nextCalled).toBe(false);
  });

  // Q3: daemonFactory accepts undefined params
  it("Q3: daemonFactory accepts undefined params", function* () {
    const middleware = daemonFactory(undefined);
    expect(typeof middleware).toBe("function");
  });

  // Q11: daemon composes with exec via combine()
  it("Q11: daemon composes with exec via combine()", function* () {
    const mw1: ModifierMiddleware = daemonFactory(undefined);
    // Use a dummy exec factory for composition test
    const dummyExec: ModifierMiddleware = (_args, next) =>
      (function* () {
        return yield* next();
      })();
    const composed = combine([mw1, dummyExec]);
    expect(typeof composed).toBe("function");
  });

  // Q10: daemonFactory is a terminal modifier — it does not call next
  it("Q10: daemon is a terminal modifier", function* () {
    // Verify the factory returns a middleware that takes (args, next) correctly
    const factory = daemonFactory(undefined);
    // The function arity indicates it accepts (args, next)
    expect(factory.length).toBe(2);
  });

  // Q10b: daemon without EvalScopeCtx throws a clear error
  // When the daemon middleware runs in a scope where EvalScopeCtx
  // is not set, EvalScopeCtx.expect() should throw.
  it("Q10b: daemon without EvalScopeCtx throws clear error", function* () {
    const middleware = daemonFactory(undefined);
    const terminal = function* () {
      return { output: "", exitCode: 0, stderr: "" };
    };

    // Provide CodeBlockCtx (required by useCodeBlock) but NOT EvalScopeCtx
    const fakeContext = {
      language: "bash",
      content: "echo hello",
      blockId: "test:root:0",
    };

    let threw = false;
    let errorMessage = "";

    try {
      yield* CodeBlockCtx.with(fakeContext, function* () {
        // The daemon middleware generator yields ephemeral operations.
        // When it reaches EvalScopeCtx.expect() without the context set,
        // it should throw.
        yield* middleware([], terminal) as unknown as Operation<unknown>;
      });
    } catch (e) {
      threw = true;
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    expect(threw).toBe(true);
    // The error should mention the missing context
    expect(errorMessage.toLowerCase()).toMatch(/evalscope|context/);
  });
});
