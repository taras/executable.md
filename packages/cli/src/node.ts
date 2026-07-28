/**
 * Node source and npm-package entrypoint.
 *
 * This is the module the published `xmd` bin runs, so the invocation it
 * hands back names this file. `execArgv` carries across the relaunch —
 * a loader the parent needs, the child needs too — except `--inspect`,
 * which would make the worker exit immediately on the debug port the
 * parent already holds.
 *
 * Node's tsx loader rejects `data:` URI imports, so eval blocks compile
 * through temporary files here.
 */

import { main } from "effection";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { API } from "@executablemd/runtime";
import { useTempFileCompiler } from "@executablemd/core";
import { nodeCommand } from "./commands.ts";
import { runXmd } from "./cli.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

await main(function* (args) {
  yield* API.Env.around({
    *command([xmdArgs = []], next) {
      void next; // terminal middleware — does not delegate
      return nodeCommand(process.execPath, process.execArgv, ENTRYPOINT, xmdArgs);
    },
  });
  yield* runXmd(args, { useCompiler: useTempFileCompiler });
});
