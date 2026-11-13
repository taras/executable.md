import { exit, main } from "effection";
import { oneFileCommand, runOneFile } from "./lib/runtime-tests.ts";

const root = new URL("../", import.meta.url);
const suite = "examples/adversarial-implementation/tests/Delivery.test.md";
const { command, arguments: args } = oneFileCommand("node", suite, root);
console.log(JSON.stringify({ command, args }));

await main(function* () {
  const status = yield* runOneFile("node", suite, root);
  console.log(`Delivery runOneFile status ${status}`);
  yield* exit(status);
});
