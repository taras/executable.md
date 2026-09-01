import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { syntaxCatalog } from "../src/syntax.ts";

describe("Tier VB — <Verbose>", () => {
  it("VB5: the run syntax catalog describes it", function* () {
    const catalog = yield* syntaxCatalog([]);
    const verbose = catalog.categories[1].entries.find((entry) => entry.name === "Verbose");

    expect(verbose?.origin).toEqual({
      kind: "registered",
      origin: "@executablemd/cli",
      reserved: false,
    });
    expect(verbose?.description).toEqual(
      "Expand content only with --verbose. `<Verbose>Checking setup.</Verbose>` renders nothing otherwise.",
    );
    expect(verbose?.props.properties).toEqual({});
  });
});
