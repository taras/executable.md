import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

function* scoped(body: () => Operation<void>): Operation<void> {
  yield* body();
}

describe("a local function named scoped", () => {
  it("is not the effection scope", function* () {
    yield* scoped(function* () {
      expect(1).toBe(1);
    });
  });
});
