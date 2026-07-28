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
import { compileTempFile } from "@executablemd/core";
import { runXmd } from "./cli.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

await main(function* (args) {
  // The base providers for this host. `at: "min"` puts them beneath ordinary
  // middleware, so a policy installed later can wrap either one.
  yield* API.Env.around(
    {
      *command([xmdArgs = []]) {
        // A worker inheriting the parent's --inspect would exit immediately on
        // the debug port the parent already holds. Every other execArgv entry
        // carries across: a loader the parent needs, the child needs too.
        const execArgv = process.execArgv.filter((option) => !option.startsWith("--inspect"));
        return [process.execPath, ...execArgv, ENTRYPOINT, ...xmdArgs];
      },

      *compile([source, options]) {
        return yield* compileTempFile(source, options);
      },
    },
    { at: "min" },
  );
  yield* runXmd(args);
});
