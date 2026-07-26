/**
 * The assertion adapter, exercised on Deno, Node and Bun — the premise of
 * building on `node:assert/strict` is that all three agree.
 *
 * The document-level suites cannot join it under Bun: they reach
 * `@executablemd/runtime/test` through tests/helpers.ts, and Bun does not
 * resolve a workspace package's subpath export in CI, where `bun install` runs
 * without pnpm's node_modules links.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { AssertionError as NodeAssertionError } from "node:assert/strict";
import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertGreater,
  assertGreaterOrEqual,
  AssertionError,
  assertionError,
  assertLess,
  assertLessOrEqual,
  assertMatch,
  assertNotEquals,
  assertNotMatch,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
  fail,
} from "../src/assert.ts";

/** A value whose every formatting hook throws. */
function hostile(): Record<string, unknown> {
  return {
    get trap(): never {
      throw new Error("getter ran");
    },
    toJSON(): never {
      throw new Error("toJSON ran");
    },
    toString(): never {
      throw new Error("toString ran");
    },
    [Symbol.for("nodejs.util.inspect.custom")](): never {
      throw new Error("inspect ran");
    },
    [Symbol.for("Deno.customInspect")](): never {
      throw new Error("deno inspect ran");
    },
  };
}

describe("assertion adapter", () => {
  it("reports failures as the runtime's AssertionError", function* () {
    expect(() => fail("boom")).toThrow(NodeAssertionError);
    expect(AssertionError).toBe(NodeAssertionError);
    expect(assertionError("boom").message).toBe("boom");
  });

  it("passes truthy and falsy checks", function* () {
    expect(() => assert(1)).not.toThrow();
    expect(() => assert(0)).toThrow(NodeAssertionError);
    expect(() => assertFalse(0)).not.toThrow();
    expect(() => assertFalse(1)).toThrow(NodeAssertionError);
  });

  it("passes existence checks", function* () {
    expect(() => assertExists(0)).not.toThrow();
    expect(() => assertExists("")).not.toThrow();
    expect(() => assertExists(false)).not.toThrow();
    expect(() => assertExists(null)).toThrow(NodeAssertionError);
    expect(() => assertExists(undefined)).toThrow(NodeAssertionError);
  });

  it("compares deeply", function* () {
    expect(() => assertEquals({ deep: [1, 2, 3] }, { deep: [1, 2, 3] })).not.toThrow();
    expect(() => assertEquals({ a: 1 }, { a: 2 })).toThrow(NodeAssertionError);
    expect(() => assertEquals(NaN, NaN)).not.toThrow();
    expect(() => assertNotEquals({ a: 1 }, { a: 2 })).not.toThrow();
    expect(() => assertNotEquals({ a: 1 }, { a: 1 })).toThrow(NodeAssertionError);
  });

  it("compares strictly by reference", function* () {
    const shared = { a: 1 };
    expect(() => assertStrictEquals(shared, shared)).not.toThrow();
    expect(() => assertStrictEquals({ a: 1 }, { a: 1 })).toThrow(NodeAssertionError);
    expect(() => assertNotStrictEquals({ a: 1 }, { a: 1 })).not.toThrow();
    expect(() => assertNotStrictEquals(shared, shared)).toThrow(NodeAssertionError);
  });

  it("checks substrings", function* () {
    expect(() => assertStringIncludes("hello world", "o w")).not.toThrow();
    expect(() => assertStringIncludes("hello", "bye")).toThrow(NodeAssertionError);
  });

  it("checks regular expressions", function* () {
    expect(() => assertMatch("abc", /b/)).not.toThrow();
    expect(() => assertMatch("abc", /z/)).toThrow(NodeAssertionError);
    expect(() => assertNotMatch("abc", /z/)).not.toThrow();
    expect(() => assertNotMatch("abc", /b/)).toThrow(NodeAssertionError);
  });

  it("orders values", function* () {
    expect(() => assertGreater(2, 1)).not.toThrow();
    expect(() => assertGreater(1, 1)).toThrow(NodeAssertionError);
    expect(() => assertGreaterOrEqual(1, 1)).not.toThrow();
    expect(() => assertGreaterOrEqual(0, 1)).toThrow(NodeAssertionError);
    expect(() => assertLess(1, 2)).not.toThrow();
    expect(() => assertLess(1, 1)).toThrow(NodeAssertionError);
    expect(() => assertLessOrEqual(1, 1)).not.toThrow();
    expect(() => assertLessOrEqual(2, 1)).toThrow(NodeAssertionError);
  });

  it("uses msg as the failure message when supplied", function* () {
    expect(() => assertEquals(1, 2, "mine")).toThrow("mine");
    expect(() => assertFalse(1, "mine")).toThrow("mine");
    expect(() => assertExists(null, "mine")).toThrow("mine");
    expect(() => assertStringIncludes("a", "b", "mine")).toThrow("mine");
    expect(() => assertGreater(1, 2, "mine")).toThrow("mine");
  });

  it("never formats operands on a passing comparison", function* () {
    const cursed = hostile();
    expect(() => assert(cursed)).not.toThrow();
    expect(() => assertExists(cursed)).not.toThrow();
    expect(() => assertStrictEquals(cursed, cursed)).not.toThrow();
    expect(() => assertEquals(cursed, cursed)).not.toThrow();
    expect(() => assertNotStrictEquals(cursed, hostile())).not.toThrow();
  });

  it("still raises an AssertionError when a failing operand is unformattable", function* () {
    expect(() => assertStrictEquals(hostile(), {})).toThrow(NodeAssertionError);
    expect(() => assertEquals(hostile(), { a: 1 })).toThrow(NodeAssertionError);
  });

  it("lets a comparison-time coercion failure surface as itself", function* () {
    // `>` coerces its operand, so a throwing toString fails the comparison
    // itself rather than the assertion — not something to swallow.
    expect(() => assertGreater<unknown>(hostile(), 1)).toThrow("toString ran");
  });
});
