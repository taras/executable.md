/**
 * `deno task test`: the local Deno suite, whole or focused.
 *
 * Usage:
 *   deno task test                     # every Deno test, then every Markdown suite
 *   deno task test <paths or flags>    # forwarded to `deno test` verbatim
 *   deno task test <suite>.test.md …   # Markdown suites by path, beside TypeScript paths
 *
 * Arguments keep `deno test`'s own meaning; see `localDenoTests`.
 */

import { exit, main } from "effection";
import { localDenoTests } from "./lib/runtime-tests.ts";

await main(function* (args) {
  yield* exit(yield* localDenoTests(args, new URL("../", import.meta.url)));
});
