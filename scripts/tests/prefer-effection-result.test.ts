/**
 * Rule tests for `local/prefer-effection-result` (scripts/oxlint-rules).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { fixed, violations } from "./oxlint.ts";

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, "prefer-effection-result");
}

describe("local/prefer-effection-result", () => {
  /**
   * In fixture order: a narrowed identifier, the same rebuild reached through
   * a nested `if`, and a narrowed property path.
   */
  it("reports a failure rebuilt from the value its guard already narrowed", function* () {
    expect(yield* reported("rebuilt-failure.ts")).toEqual([6, 16, 24]);
  });

  it("resolves Err through an aliased and a namespaced effection import", function* () {
    expect(yield* reported("aliased-err.ts")).toEqual([7, 14]);
  });

  /**
   * A local `Err`, a failure already returned intact, a different error, a
   * rebuild from another value, and a return that belongs to a nested
   * generator.
   */
  it("accepts every failure that is not the narrowed value rebuilt", function* () {
    expect(yield* reported("kept-failure.ts")).toEqual([]);
  });

  /**
   * In fixture order: a generic alias with its own payload names, a named
   * alias, a multi-line alias, an inline return type, and an interface method
   * signature.
   */
  it("reports a declared result union whatever it is named", function* () {
    expect(yield* reported("declared-result-union.ts")).toEqual([7, 9, 12, 15, 24]);
  });

  it("accepts Result<T> and unions discriminated on anything else", function* () {
    expect(yield* reported("canonical-result.ts")).toEqual([]);
  });

  it("rewrites a narrowed identifier to the failure itself", function* () {
    const source = yield* fixed("rebuilt-failure.ts", "fixture.ts");

    expect(source).toContain([`  if (!result.ok) {`, `    return result;`, `  }`].join("\n"));
    expect(source).toContain(
      [
        `    if (verbose) {`,
        `      console.error(result.error.message);`,
        `    }`,
        `    return result;`,
      ].join("\n"),
    );
  });

  it("reports without fixing when the narrowed value is a property path", function* () {
    const source = yield* fixed("rebuilt-failure.ts", "fixture.ts");

    expect(source).toContain(
      [`  if (!state.last.ok) {`, `    return Err(state.last.error);`, `  }`].join("\n"),
    );
  });

  it("never rewrites a declared union", function* () {
    const source = yield* fixed("declared-result-union.ts", "fixture.ts");

    expect(source).toContain(
      `export type ParseResult = { ok: true; value: Route } | { ok: false; error: string };`,
    );
  });
});
