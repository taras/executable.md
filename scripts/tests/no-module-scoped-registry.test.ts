/**
 * Rule tests for `local/no-module-scoped-registry` (scripts/oxlint-rules).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { violations } from "./oxlint.ts";

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, "no-module-scoped-registry");
}

describe("local/no-module-scoped-registry", () => {
  /**
   * In fixture order: a plain declaration, an exported one, an assignment made
   * after the declaration, one held inside a module-scoped object, a static
   * class field — a class body is not a lifetime of its own — and one of each
   * remaining kind, since all four are the same shape.
   */
  it("reports every table whose lifetime is the module", function* () {
    expect(yield* reported("module-registry.ts")).toEqual([8, 10, 13, 15, 18, 21, 23, 25]);
  });

  it("accepts tables an operation owns, and the metadata brand a definition carries", function* () {
    expect(yield* reported("scoped-registry.ts")).toEqual([]);
  });
});
