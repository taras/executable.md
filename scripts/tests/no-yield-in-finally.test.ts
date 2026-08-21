/**
 * Rule tests for `local/no-yield-in-finally` (scripts/oxlint-rules).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { violations } from "./oxlint.ts";

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, "no-yield-in-finally");
}

describe("local/no-yield-in-finally", () => {
  /**
   * In fixture order: a delegated cleanup, a plain `yield`, cleanup reached
   * through an `if` and a `for`, the three suspensions of a nested
   * try/catch/finally, and one guarded by a `catch` that swallows its failure
   * — each reported once, from its own enclosing finalizer.
   *
   * The last is the shape that reached `main` in PR #518's probe fixture.
   * Swallowing the failure hides the diagnostic, not the defect: a halt still
   * abandons the cleanup partway through.
   */
  it("reports every suspension the enclosing generator performs while unwinding", function* () {
    expect(yield* reported("yield-in-finally.ts")).toEqual([14, 22, 32, 36, 46, 48, 50, 73]);
  });

  it("accepts ensure(), synchronous unwinding, and a generator declared in finally", function* () {
    expect(yield* reported("finally-cleanup.ts")).toEqual([]);
  });
});
