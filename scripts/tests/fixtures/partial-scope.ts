import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure, scoped, spawn } from "effection";
import type { Operation } from "effection";

function* useFixture(): Operation<number> {
  return yield* scoped(function* () {
    return 1;
  });
}

describe("partial scopes", () => {
  it("observes teardown before the test completes", function* () {
    let cleaned = false;

    yield* scoped(function* () {
      yield* ensure(() => {
        cleaned = true;
      });
    });

    expect(cleaned).toBe(true);
  });

  it("keeps the scope result", function* () {
    const value = yield* scoped(function* () {
      return 1;
    });

    expect(value).toBe(1);
  });

  it("scopes a spawned task", function* () {
    yield* spawn(function* () {
      yield* scoped(function* () {
        expect(1).toBe(1);
      });
    });

    expect(yield* useFixture()).toBe(1);
  });
});
