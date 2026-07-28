import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";

describe("doubled wrappers", () => {
  it("wraps the body twice", function* () {
    yield* scoped(function* () {
      yield* scoped(function* () {
        expect(1).toBe(1);
      });
    });
  });
});
