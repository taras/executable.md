/**
 * Rule tests for `local/no-redundant-test-scope` (scripts/oxlint-rules).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { fixed, violations } from "./oxlint.ts";

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, "no-redundant-test-scope");
}

/** The rule is enabled for test files only, so the copy has to be named one. */
function rewritten(fixture: string): Operation<string> {
  return fixed(fixture, "fixture.test.ts");
}

describe("local/no-redundant-test-scope", () => {
  it("reports a whole-body scope in it() and it.only() callbacks", function* () {
    expect(yield* reported("whole-body.ts")).toEqual([7, 15, 21, 27]);
  });

  it("reports the outer wrapper of a doubled scope", function* () {
    expect(yield* reported("doubled.ts")).toEqual([7]);
  });

  it("resolves scoped through an aliased effection import", function* () {
    expect(yield* reported("aliased-import.ts")).toEqual([7]);
  });

  it("accepts a scope that covers part of a test", function* () {
    expect(yield* reported("partial-scope.ts")).toEqual([]);
  });

  it("accepts an unrelated function named scoped", function* () {
    expect(yield* reported("local-scoped.ts")).toEqual([]);
  });

  it("unwraps a redundant scope and keeps the body indentation", function* () {
    const source = yield* rewritten("whole-body.ts");

    expect(source).toContain(
      [
        `  it("wraps the body in a scope", function* () {`,
        `    const value = 1;`,
        `    yield* sleep(0);`,
        `    expect(value).toBe(1);`,
        `  });`,
      ].join("\n"),
    );
    expect(source).toContain(
      [
        `  it("returns the delegated scope", function* () {`,
        `    expect(1).toBe(1);`,
        `  });`,
      ].join("\n"),
    );
  });

  it("unwraps a doubled scope over repeated fixes", function* () {
    const source = yield* rewritten("doubled.ts");

    expect(source).toContain(
      [`  it("wraps the body twice", function* () {`, `    expect(1).toBe(1);`, `  });`].join("\n"),
    );
  });

  it("reports without fixing when unwrapping would change control flow", function* () {
    const source = yield* rewritten("whole-body.ts");

    expect(source).toContain(
      [
        `  it("returns the scope operation", function* () {`,
        `    return scoped(function* () {`,
        `      expect(1).toBe(1);`,
        `    });`,
        `  });`,
      ].join("\n"),
    );
  });
});
