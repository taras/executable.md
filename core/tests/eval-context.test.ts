/**
 * Tier T2 — Eval block compilation tests (spec §11).
 *
 * Tests the data: URI module compilation system (compileBlock) and
 * verifies that compiled generators can interact with Effection APIs,
 * write to env, and propagate errors correctly.
 *
 * After the Deno migration, compileBlock is async (returns Operation)
 * and generates data: URI modules instead of using node:vm.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { compileBlock } from "../src/eval-context.ts";

describe("Tier T2 — VM context and compiled generator", () => {
  // T17: Compiled generator can yield* Effection globals from imports
  it("T17: compiled generator can use Effection globals from sandbox", function* () {
    const fn = yield* compileBlock("yield* sleep(0);", []);
    const gen = fn({});
    // The generator should produce a value — it yields sleep(0)
    const first = gen.next();
    expect(first.done).not.toBe(true);
  });

  // T18: Value written to env.x inside block is readable by host
  it("T18: value written to env is readable by host", function* () {
    const fn = yield* compileBlock("env.x = 42;", []);
    const env: Record<string, unknown> = {};
    const gen = fn(env);
    let result = gen.next();
    while (!result.done) {
      result = gen.next();
    }
    expect(env["x"]).toBe(42);
  });

  // T19: Live object reference survives in env without cloning
  it("T19: live object reference survives without cloning", function* () {
    const liveObj = { key: "value", nested: { deep: true } };
    const env: Record<string, unknown> = { liveObj };
    const fn = yield* compileBlock("env.ref = env.liveObj;", []);
    const gen = fn(env);
    let result = gen.next();
    while (!result.done) {
      result = gen.next();
    }
    // Same reference, not a copy
    expect(env["ref"]).toBe(liveObj);
  });

  // T20: Block re-executed after code change — no error from re-declaration
  it("T20: re-execution without const re-declaration error", function* () {
    // First execution
    const fn1 = yield* compileBlock("env.x = 1;", []);
    const env1: Record<string, unknown> = {};
    const gen1 = fn1(env1);
    let r1 = gen1.next();
    while (!r1.done) r1 = gen1.next();

    // Second execution — different code
    const fn2 = yield* compileBlock("env.x = 2;", []);
    const env2: Record<string, unknown> = {};
    const gen2 = fn2(env2);
    let r2 = gen2.next();
    while (!r2.done) r2 = gen2.next();

    expect(env1["x"]).toBe(1);
    expect(env2["x"]).toBe(2);
  });

  // T21: Block that throws propagates error
  it("T21: block that throws propagates error", function* () {
    const fn = yield* compileBlock('throw new Error("test error");', []);
    const gen = fn({});
    let threw = false;
    try {
      gen.next();
    } catch (e: unknown) {
      threw = true;
      expect(String(e)).toContain("test error");
    }
    expect(threw).toBe(true);
  });

  // T22: Sync computation writes result to env
  it("T22: sync computation writes result to env", function* () {
    const fn = yield* compileBlock(
      "const result = 40 + 2; env.result = result;",
      [],
    );
    const env: Record<string, unknown> = {};
    const gen = fn(env);
    let r = gen.next();
    while (!r.done) r = gen.next();
    expect(env["result"]).toBe(42);
  });
});

describe("compileBlock edge cases", () => {
  it("throws on syntax error in code", function* () {
    let threw = false;
    try {
      yield* compileBlock("const x = ;", []);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("creates distinct generator instances per call", function* () {
    const fn = yield* compileBlock("env.count = (env.count || 0) + 1;", []);

    const env1: Record<string, unknown> = {};
    const gen1 = fn(env1);
    let r1 = gen1.next();
    while (!r1.done) r1 = gen1.next();

    const env2: Record<string, unknown> = {};
    const gen2 = fn(env2);
    let r2 = gen2.next();
    while (!r2.done) r2 = gen2.next();

    expect(env1["count"]).toBe(1);
    expect(env2["count"]).toBe(1);
  });
});
