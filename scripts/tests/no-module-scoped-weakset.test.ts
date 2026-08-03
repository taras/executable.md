/**
 * Rule tests for `local/no-module-scoped-weakset` (scripts/oxlint-rules).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { violations } from "./oxlint.ts";

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, "no-module-scoped-weakset");
}

describe("local/no-module-scoped-weakset", () => {
  /**
   * In fixture order: a plain declaration, an exported one, an assignment made
   * after the declaration, and one held inside a module-scoped object.
   */
  it("reports every table whose lifetime is the module", function* () {
    expect(yield* reported("module-weakset.ts")).toEqual([8, 10, 13, 15]);
  });

  it("accepts a table created inside a function or a generator, a WeakMap, and a mark on the object", function* () {
    expect(yield* reported("scoped-weakset.ts")).toEqual([]);
  });
});
