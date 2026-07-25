import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped as inScope } from "effection";

describe("aliased import", () => {
  it("wraps the body in an aliased scope", function* () {
    yield* inScope(function* () {
      expect(1).toBe(1);
    });
  });
});
