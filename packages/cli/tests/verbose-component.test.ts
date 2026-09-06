import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { syntaxSymbols } from "../src/syntax.ts";

describe("Tier VB — <Verbose>", () => {
  // Inspection reads the declaration's metadata. It invokes nothing, so no
  // verbosity — the command line's or a component's — takes part in it.
  it("VB5: the run syntax catalog describes it", function* () {
    const catalog = yield* syntaxSymbols([]);
    const verbose = catalog.categories[1].entries.find((entry) => entry.name === "Verbose");

    expect(verbose?.origin).toEqual({
      kind: "registered",
      origin: "@executablemd/cli",
      reserved: false,
    });
    expect(verbose?.description).toEqual(
      "Expand content when run verbosity is enabled. `--verbose` enables it for the run; a component may override verbosity for its content.",
    );
    expect(verbose?.props.properties).toEqual({});
  });
});
