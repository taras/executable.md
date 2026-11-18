import { useQuietProcessOutput } from "@executablemd/runtime";
import { main } from "effection";
import { proofBoundary } from "../../support/joined-response-boundaries.ts";

await main(function* (args) {
  yield* useQuietProcessOutput();
  console.log("\n" + JSON.stringify(yield* proofBoundary(args[0])));
});
