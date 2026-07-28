import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep } from "effection";

describe("whole-body wrappers", () => {
  it("wraps the body in a scope", function* () {
    yield* scoped(function* () {
      const value = 1;
      yield* sleep(0);
      expect(value).toBe(1);
    });
  });

  it("returns the delegated scope", function* () {
    return yield* scoped(function* () {
      expect(1).toBe(1);
    });
  });

  it("returns the scope operation", function* () {
    return scoped(function* () {
      expect(1).toBe(1);
    });
  });

  it.only("wraps the body of an only test", function* () {
    yield* scoped(function* () {
      expect(1).toBe(1);
    });
  });
});
