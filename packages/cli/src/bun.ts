/**
 * Bun source entrypoint.
 *
 * Bun runs TypeScript directly, so the invocation is the executable and
 * this module — no permission flags and no loader to carry across.
 */

import { main } from "effection";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { API } from "@executablemd/runtime";
import { useDataUriCompiler } from "@executablemd/core";
import { bunCommand } from "./commands.ts";
import { runXmd } from "./cli.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

await main(function* (args) {
  yield* API.Env.around({
    *command([xmdArgs = []], next) {
      void next; // terminal middleware — does not delegate
      return bunCommand(process.execPath, ENTRYPOINT, xmdArgs);
    },
  });
  yield* runXmd(args, { useCompiler: useDataUriCompiler });
});
