import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
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
