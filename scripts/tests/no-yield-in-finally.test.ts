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
   * through an `if` and a `for`, and the three suspensions of a nested
   * try/catch/finally — each reported once, from its own enclosing finalizer.
   */
  it("reports every suspension the enclosing generator performs while unwinding", function* () {
    expect(yield* reported("yield-in-finally.ts")).toEqual([14, 22, 32, 36, 46, 48, 50]);
  });

  it("accepts ensure(), synchronous unwinding, and a generator declared in finally", function* () {
    expect(yield* reported("finally-cleanup.ts")).toEqual([]);
  });
});
