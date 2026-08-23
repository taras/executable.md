/**
 * Run the repository's test corpus, or one shard of it, under one runtime.
 *
 * Usage:
 *   deno run --allow-all --frozen scripts/runtime-tests.ts deno [<index>/<count>]
 *   tsx scripts/runtime-tests.ts node [<index>/<count>]
 *   bun scripts/runtime-tests.ts bun [<index>/<count>]
 *
 * Scope is derived: every `*.test.ts` discovery finds, minus the entries
 * `runtime-test-exclusions.ts` records for that runtime. Adding a test file
 * puts it in all three runtime jobs without editing anything here, and the
 * partition places it in exactly one shard of each.
 *
 * CI passes a shard selection; a human debugging the suite leaves it off and
 * gets the whole corpus in one invocation.
 */

import { main } from "effection";
import { runtimeTests } from "./lib/runtime-tests.ts";

await main(function* (args) {
  yield* runtimeTests(args[0] ?? "", args[1], new URL("../", import.meta.url));
});
