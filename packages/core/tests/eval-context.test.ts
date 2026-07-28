/**
 * Tier T2 — Eval block compilation tests (spec §11).
 *
 * Tests the module compilation system (compileBlock) and verifies that
 * compiled blocks can interact with Effection APIs, write to env, and
 * propagate errors correctly.
 *
 * A compiled block is applied to an environment and run with `yield*` — the
 * generator underneath it is an implementation detail, so these drive it as
 * an operation rather than stepping it by hand.
 *
 * These assertions are about compileBlock, not about a particular compiler,
 * so they install the temp-file one: it is the only implementation that
 * loads on all three runtimes.
 */
import { describe, it, beforeAll } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { compileBlock } from "../src/eval-context.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";

describe("Tier T2 — VM context and compiled blocks", () => {
  beforeAll(() => useTempFileCompiler());

  // T17: Compiled block can yield* Effection globals from imports
  it("T17: compiled block can use Effection globals from sandbox", function* () {
    const fn = yield* compileBlock("yield* sleep(0);\nenv.slept = true;", []);
    const env: Record<string, unknown> = {};
    yield* fn(env);
    // Reaching the assignment means the suspension resumed rather than hanging.
    expect(env["slept"]).toBe(true);
  });

  // T18: Value written to env.x inside block is readable by host
  it("T18: value written to env is readable by host", function* () {
    const fn = yield* compileBlock("env.x = 42;", []);
    const env: Record<string, unknown> = {};
    yield* fn(env);
    expect(env["x"]).toBe(42);
  });

  // T19: Live object reference survives in env without cloning
  it("T19: live object reference survives without cloning", function* () {
    const liveObj = { key: "value", nested: { deep: true } };
    const env: Record<string, unknown> = { liveObj };
    const fn = yield* compileBlock("env.ref = env.liveObj;", []);
    yield* fn(env);
    // Same reference, not a copy
    expect(env["ref"]).toBe(liveObj);
  });

  // T20: Block re-executed after code change — no error from re-declaration
  it("T20: re-execution without const re-declaration error", function* () {
    const fn1 = yield* compileBlock("env.x = 1;", []);
    const env1: Record<string, unknown> = {};
    yield* fn1(env1);

    // Second execution — different code
    const fn2 = yield* compileBlock("env.x = 2;", []);
    const env2: Record<string, unknown> = {};
    yield* fn2(env2);

    expect(env1["x"]).toBe(1);
    expect(env2["x"]).toBe(2);
  });

  // T21: Block that throws propagates error
  it("T21: block that throws propagates error", function* () {
    const fn = yield* compileBlock('throw new Error("test error");', []);
    let threw = false;
    try {
      yield* fn({});
    } catch (e: unknown) {
      threw = true;
      expect(String(e)).toContain("test error");
    }
    expect(threw).toBe(true);
  });

  // T22: Sync computation writes result to env
  it("T22: sync computation writes result to env", function* () {
    const fn = yield* compileBlock("const result = 40 + 2; env.result = result;", []);
    const env: Record<string, unknown> = {};
    yield* fn(env);
    expect(env["result"]).toBe(42);
  });

  // T23: A block's return value is what running it produces
  it("T23: return value surfaces from the operation", function* () {
    const fn = yield* compileBlock("return 7;", []);
    expect(yield* fn({})).toBe(7);
  });
});

describe("compileBlock edge cases", () => {
  beforeAll(() => useTempFileCompiler());

  it("throws on syntax error in code", function* () {
    let threw = false;
    try {
      yield* compileBlock("const x = ;", []);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("applies to each environment independently", function* () {
    const fn = yield* compileBlock("env.count = (env.count || 0) + 1;", []);

    const env1: Record<string, unknown> = {};
    yield* fn(env1);

    const env2: Record<string, unknown> = {};
    yield* fn(env2);

    expect(env1["count"]).toBe(1);
    expect(env2["count"]).toBe(1);
  });
});
