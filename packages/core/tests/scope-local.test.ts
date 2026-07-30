/**
 * Tier SL — own-scope context updates.
 *
 * `updateOwn` is the one place core reaches past the strict Context operations
 * to `Scope.hasOwn`, because nothing else can tell a value this scope set from
 * one it inherited. These pin the properties that makes it safe: a scope starts
 * from empty rather than from what it inherited, an update that throws changes
 * nothing, and what a scope writes is invisible to its parent and its siblings.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, scoped, spawn } from "effection";
import type { Operation } from "effection";
import { readOwn, updateOwn } from "../src/scope-local.ts";

const Names = createContext<readonly string[]>("scope-local.test.names", []);

/** Append `name` to this scope's own list. */
function add(name: string): Operation<void> {
  return updateOwn(
    Names,
    () => [],
    (own) => [...own, name],
  );
}

/** This scope's own list, ignoring anything inherited. */
function own(): Operation<readonly string[]> {
  return readOwn(Names, () => []);
}

/** Everything visible here, inherited or not. */
function* visible(): Operation<readonly string[]> {
  return (yield* Names.get()) ?? [];
}

describe("Tier SL — own-scope updates", () => {
  it("SL1: the first write starts from empty, not from the default", function* () {
    expect(yield* own()).toEqual([]);
    yield* add("first");
    expect(yield* own()).toEqual(["first"]);
  });

  it("SL2: repeated writes at one scope accumulate", function* () {
    yield* add("one");
    yield* add("two");
    yield* add("three");
    expect(yield* own()).toEqual(["one", "two", "three"]);
  });

  it("SL3: an update that throws leaves the scope unchanged", function* () {
    yield* add("kept");

    let threw = false;
    try {
      yield* updateOwn(
        Names,
        () => [],
        () => {
          throw new Error("rejected");
        },
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(yield* own()).toEqual(["kept"]);

    // The scope is still usable, and the next write builds on what survived.
    yield* add("after");
    expect(yield* own()).toEqual(["kept", "after"]);
  });

  it("SL4: a child starts empty and never mutates what it inherited", function* () {
    yield* add("parent");

    yield* scoped(function* () {
      // The child inherits the value but owns nothing yet.
      expect(yield* visible()).toEqual(["parent"]);
      expect(yield* own()).toEqual([]);

      yield* add("child");
      expect(yield* own()).toEqual(["child"]);
    });

    // SL5: leaving the child restores the parent's own value untouched.
    expect(yield* own()).toEqual(["parent"]);
    expect(yield* visible()).toEqual(["parent"]);
  });

  it("SL6: siblings cannot see one another", function* () {
    const seen: string[][] = [];
    yield* scoped(function* () {
      yield* scoped(function* () {
        yield* add("left");
        seen.push([...(yield* own())]);
      });
      yield* scoped(function* () {
        yield* add("right");
        seen.push([...(yield* own())]);
      });
    });

    expect(seen).toEqual([["left"], ["right"]]);
  });

  it("SL7: concurrent scopes stay isolated", function* () {
    const seen: string[][] = [];
    yield* scoped(function* () {
      const left = yield* spawn(() =>
        scoped(function* () {
          yield* add("left");
          seen.push([...(yield* own())]);
        }),
      );
      const right = yield* spawn(() =>
        scoped(function* () {
          yield* add("right");
          seen.push([...(yield* own())]);
        }),
      );
      yield* left;
      yield* right;
    });

    expect(seen.map((names) => names.join())).toEqual(["left", "right"]);
  });

  it("SL8: what a scope wrote is gone once it exits", function* () {
    yield* scoped(function* () {
      yield* add("temporary");
      expect(yield* visible()).toEqual(["temporary"]);
    });

    expect(yield* visible()).toEqual([]);
  });
});
