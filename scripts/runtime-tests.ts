/**
 * Run the repository's test corpus under Node or Bun.
 *
 * Usage:
 *   tsx scripts/runtime-tests.ts node
 *   bun scripts/runtime-tests.ts bun
 *
 * Scope is derived: every `*.test.ts` discovery finds, minus the entries
 * `runtime-test-exclusions.ts` records for that runtime. Adding a test file
 * puts it in all three runtime jobs without editing anything here.
 */

import { main } from "effection";
import { runtimeTests } from "./lib/runtime-tests.ts";

await main(function* (args) {
  yield* runtimeTests(args[0] ?? "", new URL("../", import.meta.url));
});
