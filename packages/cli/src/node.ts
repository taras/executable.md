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
import { API, useHostFiles } from "@executablemd/runtime";
import { compileTempFile } from "@executablemd/core";
import { runXmd, XMD_VERSION } from "./cli.ts";
import type { UpgradeAssembly } from "./upgrade.ts";
import { unassembledMachineSessions } from "./session-coordinator.ts";
import { unsupportedWorkflowHost } from "./workflow.ts";
import { unsupportedRepositories } from "./run-repositories.ts";
import { useNodeService } from "./node-service.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

/**
 * What `xmd upgrade` may do here: nothing but explain who owns this copy.
 *
 * This module is what the published `xmd` bin runs, so the files belong to npm
 * and replacing them behind npm's back would leave its record describing a
 * version that is no longer installed.
 */
const UPGRADE: UpgradeAssembly = {
  provenance: "npm-node",
  currentVersion: XMD_VERSION,
  executablePath: process.execPath,
  platform: process.platform,
  architecture: process.arch,
};

await main(function* (args) {
  // The base providers for this host. `at: "min"` puts them beneath ordinary
  // middleware, so middleware installed later can wrap either one.
  yield* API.Env.around(
    {
      *command([xmdArgs = []]) {
        const execArgv = process.execArgv.filter((option) => !option.startsWith("--inspect"));
        return [process.execPath, ...execArgv, ENTRYPOINT, ...xmdArgs];
      },

      *compile([source, options]) {
        return yield* compileTempFile(source, options);
      },
    },
    { at: "min" },
  );
  // Document filesystem access resolves in the caller's own filesystem here.
  // It is installed explicitly, and at the same depth, because `API.Files` has
  // no host default: a run with no provider must fail rather than reach the
  // host by accident.
  yield* useHostFiles();
  // The same advertised agents, and none of the answers an advertised session
  // needs. This runtime exposes no cross-process advisory lock, and V1 emulates
  // none — a pid, heartbeat or stale-file timeout calls a paused process dead
  // and admits two owners. It keeps no construction routes and observes no
  // build either. Advertising the same names is what makes the refusal say so:
  // every advertised operation stops before provider work, while ordinary ACP
  // work is unaffected.
  // The same thirteen repository components, and no provider that operates
  // any of them. This runtime has no kernel-released advisory lock to hold a
  // managed checkout with, so a Repository, Worktree, Git, Issue or PullRequest
  // operation reports an absent provider before a local or remote change could
  // happen. `xmd syntax` still describes one language everywhere.
  yield* runXmd(
    args,
    useNodeService,
    UPGRADE,
    unsupportedRepositories,
    unsupportedWorkflowHost,
    unassembledMachineSessions(),
  );
});
