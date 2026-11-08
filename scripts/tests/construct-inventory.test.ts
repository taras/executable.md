import { describe, it } from "@executablemd/test-support/bdd";
import { readTextFile } from "@effectionx/fs";
import { constructInventory } from "../lib/construct-inventory.ts";

describe("construct inventory", () => {
  it("matches the committed artifact byte for byte; regenerate with deno task docs:inventory", function* () {
    const inventory = yield* constructInventory();
    if (!inventory.ok) {
      throw inventory.error;
    }
    const committed = yield* readTextFile(
      new URL("../../specs/construct-inventory.md", import.meta.url),
    );
    if (inventory.value !== committed) {
      throw new Error("specs/construct-inventory.md is out of date; run deno task docs:inventory");
    }
  });
});
