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
import {
  useExecutableObserver,
  useSessionCoordinator,
  useSessionRouteStore,
} from "./session-coordinator.ts";
import { useDenoWorkflowHost } from "./deno-workflow.ts";
import {
  isCredentialHelperMode,
  runCredentialHelper,
} from "@executablemd/workflow/credential-helper";
import type { HelperAssembly } from "@executablemd/workflow/credential-helper";
import { useCompiledService } from "./compiled-service.ts";

/**
 * What this host is, stated rather than inferred.
 *
 * The binary carries its own entry module, so the executable *is* the command
 * and the helper mode is one of the things it can be asked to be.
 */
const HELPER: HelperAssembly = {
  runtime: "compiled",
  platform: process.platform === "win32" ? "windows" : "unix",
  execPath: process.execPath,
};

// Before anything public is parsed, and absent from every public surface.
if (isCredentialHelperMode(process.argv.slice(2))) {
  await main(() => runCredentialHelper(process.argv.slice(2)));
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
    // Session ownership, which only a host with a kernel-released advisory lock
    // and durable record replacement can offer. Passing it here is what lets an
    // advertised session be acted on at all: a host that
    // offers none refuses rather than risking two owners of one conversation.
    // Helper mode receives neither this nor the workflow host: it is not the
    // public CLI and assembles none of it.
    yield* runXmd(
      args,
      useCompiledService,
      () => useDenoWorkflowHost(HELPER),
      useSessionCoordinator(),
      {
        routeStore: useSessionRouteStore(),
        executableObserver: useExecutableObserver(),
      },
    );
  });
}
