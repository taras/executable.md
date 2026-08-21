/**
 * Compiled-binary entrypoint — what `deno task build` compiles.
 *
 * The binary carries its own entry module, so it relaunches itself with no
 * script path: the executable *is* the command.
 */

import { main } from "effection";
import process from "node:process";
import { API, useHostFiles } from "@executablemd/runtime";
import { compileDataUri } from "@executablemd/core";
import { runXmd } from "./cli.ts";
import { useDenoWorkflowHost } from "./deno-workflow.ts";
import { useCompiledService } from "./compiled-service.ts";
import { runInternalMode } from "@executablemd/workflow/deno";

// The unadvertised internal modes run before anything else is parsed: they are
// not a command, they appear in no help and in no public grammar, and a caller
// who did not select one gets the ordinary command line unchanged.
if (runInternalMode(process.argv.slice(2))) {
  // The mode owns this process from here.
} else {
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
    // Document filesystem access resolves in the caller's own filesystem here.
    // It is installed explicitly, and at the same depth, because `API.Files` has
    // no host default: a run with no provider must fail rather than reach the
    // host by accident.
    yield* useHostFiles();
    yield* runXmd(args, useCompiledService, useDenoWorkflowHost);
  });
}
