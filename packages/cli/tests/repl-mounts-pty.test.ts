import { describe, it } from "@executablemd/test-support/bdd";
import { cliShellCommand } from "@executablemd/test-support/launch";
import { replMountsJourney } from "./support/repl-mounts-journey.ts";

describe("workspace mounts through the production terminal", () => {
  it("retains historical reads while current placement controls new work", function* () {
    yield* replMountsJourney((args) => cliShellCommand([...args]));
  });
});
