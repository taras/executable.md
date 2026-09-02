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
import { runXmd, XMD_VERSION } from "./cli.ts";
import { compiledUpgradeAssembly } from "./compiled-upgrade.ts";
import { useMachineSessions } from "./session-coordinator.ts";
import { useDenoWorkflowHost } from "./deno-workflow.ts";
import { denoRunRepositories } from "./deno-repositories.ts";
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

/**
 * What `xmd upgrade` may do here, from what this process can observe.
 *
 * `process.execPath` is the spelling this binary was invoked as, and it is the
 * exact file an upgrade replaces — never a resolved one. A compiled binary
 * reached through a symbolic link reports the link, and the command refuses it
 * rather than following it to choose what to overwrite.
 */
const UPGRADE = compiledUpgradeAssembly({
  executablePath: process.execPath,
  platform: process.platform,
  architecture: process.arch,
  currentVersion: XMD_VERSION,
});

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
    // Machine-wide agent sessions: who owns one, how it was constructed, which
    // build it belongs to, and which adapters this host has proven for native
    // launch and for ACP attachment. Only a host with a kernel-released
    // advisory lock, durable record replacement and real executable observation
    // can offer them, and passing them here is what lets an advertised session
    // be acted on at all — a host that offers none refuses rather than risking
    // two owners of one conversation.
    // Helper mode receives neither this nor the workflow host: it is not the
    // public CLI and assembles none of it.
    // The ordinary repository provider, on the same terms the Deno entrypoint
    // installs it: the binary is Deno, and the helper assembly it hands over is
    // the one that names this executable rather than a module path.
    yield* runXmd(
      args,
      useCompiledService,
      UPGRADE,
      denoRunRepositories(HELPER),
      () => useDenoWorkflowHost(HELPER),
      useMachineSessions(),
    );
  });
}
