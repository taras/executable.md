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
import { API, useHostFiles } from "@executablemd/runtime";
import { compileDataUri } from "@executablemd/core";
import { runXmd } from "./cli.ts";
import { useSessionCoordination } from "./session-coordinator.ts";
import { useDenoWorkflowHost } from "./deno-workflow.ts";
import { useDenoService } from "./deno-service.ts";

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
  // Document filesystem access resolves in the caller's own filesystem here.
  // It is installed explicitly, and at the same depth, because `API.Files` has
  // no host default: a run with no provider must fail rather than reach the
  // host by accident.
  yield* useHostFiles();
  // Exclusive live ownership of a logical agent session, which only a host with
  // a kernel-released advisory lock can offer. Installing it here is what lets
  // a client-native launch run at all: a host that installs nothing refuses
  // rather than risking two owners of one conversation.
  yield* useSessionCoordination();
  yield* runXmd(args, useDenoService, useDenoWorkflowHost);
});
