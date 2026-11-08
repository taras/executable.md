import { exit, main } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { constructInventory } from "./lib/construct-inventory.ts";

main(function* () {
  const inventory = yield* constructInventory();
  if (!inventory.ok) {
    yield* exit(1, inventory.error.message);
    return;
  }
  yield* writeTextFile(
    new URL("../specs/construct-inventory.md", import.meta.url),
    inventory.value,
  );
});
