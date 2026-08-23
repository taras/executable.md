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
import { useMachineSessions } from "./session-coordinator.ts";
import { useDenoWorkflowHost } from "./deno-workflow.ts";
import {
  isCredentialHelperMode,
  runCredentialHelper,
} from "@executablemd/workflow/credential-helper";
import type { HelperAssembly } from "@executablemd/workflow/credential-helper";
import { useDenoService } from "./deno-service.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

/**
 * What this host is, stated rather than inferred.
 *
 * Running from source the executable is Deno, so the helper's module has to be
 * named to it. The platform is read here, at the entrypoint, because that is
 * where the program that is running knows what it is standing on.
 */
const HELPER: HelperAssembly = {
  runtime: "source",
  platform: process.platform === "win32" ? "windows" : "unix",
  execPath: process.execPath,
  modulePath: fileURLToPath(new URL("./credential-helper-entry.ts", import.meta.url)),
  launcherEnvironment: Object.fromEntries(
    ["HOME", "DENO_DIR", "XDG_CACHE_HOME", "PATH"]
      .map((name) => [name, process.env[name]])
      .filter(([, value]) => value !== undefined && value !== ""),
  ) as Record<string, string>,
};

// The internal helper mode runs before anything public is parsed. It is not a
// command: it appears in no help and in no public grammar, and a caller who did
// not select it gets the ordinary command line unchanged.
if (isCredentialHelperMode(process.argv.slice(2))) {
  await main(() => runCredentialHelper(process.argv.slice(2)));
} else {
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
    // Machine-wide agent sessions: who owns one, how it was constructed, which
    // build it belongs to, and which adapters this host has proven for native
    // launch and for ACP attachment. Only a host with a kernel-released
    // advisory lock, durable record replacement and real executable observation
    // can offer them, and passing them here is what lets an advertised session
    // be acted on at all — a host that offers none refuses rather than risking
    // two owners of one conversation.
    // Helper mode receives neither this nor the workflow host: it is not the
    // public CLI and assembles none of it.
    yield* runXmd(args, useDenoService, () => useDenoWorkflowHost(HELPER), useMachineSessions());
  });
}
