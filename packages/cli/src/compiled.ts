/**
 * Compiled-binary entrypoint — what `deno task build` compiles.
 *
 * The binary carries its own entry module, so it relaunches itself with no
 * script path: the executable *is* the command.
 */

import { main } from "effection";
import process from "node:process";
import { API } from "@executablemd/runtime";
import { useDataUriCompiler } from "@executablemd/core";
import { compiledCommand } from "./commands.ts";
import { runXmd } from "./cli.ts";

await main(function* (args) {
  yield* API.Env.around({
    *command([xmdArgs = []], next) {
      void next; // terminal middleware — does not delegate
      return compiledCommand(process.execPath, xmdArgs);
    },
  });
  yield* runXmd(args, { useCompiler: useDataUriCompiler });
});
