import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped as inScope } from "effection";

describe("aliased import", () => {
  it("wraps the body in an aliased scope", function* () {
    yield* inScope(function* () {
      expect(1).toBe(1);
    });
  });
});
