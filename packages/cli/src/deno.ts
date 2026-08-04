/**
 * Deno source entrypoint.
 *
 * `deno run` needs the module path and its permissions restated to launch a
 * second copy of this CLI, so the invocation is rebuilt from this module's
 * own URL rather than from `process.argv`, which reflects only how this
 * process happened to be started.
 */

import { main } from "effection";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { API } from "@executablemd/runtime";
import { compileDataUri } from "@executablemd/core";
import { runXmd } from "./cli.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

await main(function* (args) {
  // The base providers for this host. `at: "min"` puts them beneath ordinary
  // middleware, so middleware installed later can wrap either one.
  yield* API.Env.around(
    {
      *command([xmdArgs = []]) {
        return [process.execPath, "run", "--allow-all", ENTRYPOINT, ...xmdArgs];
      },

      *compile([source, options]) {
        return yield* compileDataUri(source, options);
      },
    },
    { at: "min" },
  );
  yield* runXmd(args);
});
