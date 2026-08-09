/**
 * Bun source entrypoint.
 *
 * Bun runs TypeScript directly, so the invocation is the executable and
 * this module — no permission flags and no loader to carry across.
 */

import { main } from "effection";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { API, useHostFiles } from "@executablemd/runtime";
import { compileDataUri } from "@executablemd/core";
import { runXmd } from "./cli.ts";
import { useBunService } from "./bun-service.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

await main(function* (args) {
  // The base providers for this host. `at: "min"` puts them beneath ordinary
  // middleware, so middleware installed later can wrap either one.
  yield* API.Env.around(
    {
      *command([xmdArgs = []]) {
        return [process.execPath, ENTRYPOINT, ...xmdArgs];
      },

      *compile([source, options]) {
        return yield* compileDataUri(source, options);
      },
    },
    { at: "min" },
  );
  // Document filesystem access resolves in the caller's own filesystem here.
  // It is installed explicitly, and at the same depth, because `API.Files` has
  // no host default: a run with no provider must fail rather than reach the
  // host by accident.
  yield* useHostFiles();
  yield* runXmd(args, useBunService);
});
