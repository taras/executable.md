/**
 * Compiled-binary entrypoint — what `deno task build` compiles.
 *
 * The binary carries its own entry module, so it relaunches itself with no
 * script path: the executable *is* the command.
 */

import { main } from "effection";
import process from "node:process";
import { API } from "@executablemd/runtime";
import { compileDataUri } from "@executablemd/core";
import { runXmd } from "./cli.ts";
import { useCompiledService } from "./compiled-service.ts";

await main(function* (args) {
  // The base providers for this host. `at: "min"` puts them beneath ordinary
  // middleware, so middleware installed later can wrap either one.
  yield* API.Env.around(
    {
      *command([xmdArgs = []]) {
        return [process.execPath, ...xmdArgs];
      },

      *compile([source, options]) {
        return yield* compileDataUri(source, options);
      },
    },
    { at: "min" },
  );
  yield* runXmd(args, useCompiledService);
});
