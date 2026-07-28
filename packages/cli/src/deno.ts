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
import { useDataUriCompiler } from "@executablemd/core";
import { denoCommand } from "./commands.ts";
import { runXmd } from "./cli.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

await main(function* (args) {
  yield* API.Env.around({
    *command([xmdArgs = []], next) {
      void next; // terminal middleware — does not delegate
      return denoCommand(process.execPath, ENTRYPOINT, xmdArgs);
    },
  });
  yield* runXmd(args, { useCompiler: useDataUriCompiler });
});
