import { NestedRunCompiler } from "./testing-host.ts";
import { usePosixSidekickTransport } from "./sidekick-acp/posix.ts";
/**
 * Bun source entrypoint.
 *
 * Bun runs TypeScript directly, so the invocation is the executable and
 * this module — no permission flags and no loader to carry across.
 */

import { action, createSignal, main, run, spawn, withResolvers } from "effection";
import { isReplSubmit, runReplSubmit } from "./sidekick-acp/submit.ts";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { API, useHostFiles } from "@executablemd/runtime";
import { compileTempFile } from "@executablemd/core";
import { runXmd, XMD_VERSION } from "./cli.ts";
import { useBunComponentModuleLoader } from "@executablemd/core/host/bun";
import { useBunRepl } from "./bun-repl.ts";
import { readInputStream } from "./standard-input.ts";
import { importPluginModule } from "./host-plugin-modules.ts";
import type { UpgradeAssembly } from "./upgrade.ts";
import { unassembledMachineSessions } from "./session-coordinator.ts";
import { unsupportedWorkflowHost } from "./workflow.ts";
import { useBunService } from "./bun-service.ts";

const ENTRYPOINT = fileURLToPath(import.meta.url);

/**
 * What `xmd upgrade` may do here: nothing but explain who owns this copy.
 *
 * Bun installed these files and keeps its own record of which version they are,
 * so the answer names the tool that can change both together.
 */
const UPGRADE: UpgradeAssembly = {
  provenance: "bun-source",
  currentVersion: XMD_VERSION,
  executablePath: process.execPath,
  platform: process.platform,
  architecture: process.arch,
};

if (isReplSubmit(process.argv.slice(2))) {
  try {
    process.exitCode = await run(function* () {
      const signals = createSignal<void, never>();
      const incoming = yield* signals;
      const interrupted = withResolvers<void>();
      yield* spawn(function* () {
        yield* incoming.next();
        interrupted.resolve();
      });
      const onInterrupt = () => signals.send();
      try {
        process.on("SIGINT", onInterrupt);
        yield* usePosixSidekickTransport(process.platform);
        yield* useBunRepl();
        return yield* runReplSubmit(
          process.argv.slice(2),
          () => readInputStream(process.stdin),
          interrupted.operation,
          (record) =>
            action<void>((resolve, reject) => {
              process.stdout.write(`${JSON.stringify(record)}\n`, (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
              return () => {};
            }),
          (message) => console.error(message),
        );
      } finally {
        process.off("SIGINT", onInterrupt);
      }
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Direct submission failed.");
    process.exitCode = 1;
  }
} else {
  await main(function* (args) {
    yield* usePosixSidekickTransport(process.platform);
    yield* useBunComponentModuleLoader();
    // The base providers for this host. `at: "min"` puts them beneath ordinary
    // middleware, so middleware installed later can wrap either one.
    yield* API.Env.around(
      {
        *command([xmdArgs = []]) {
          return [process.execPath, ENTRYPOINT, ...xmdArgs];
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
    yield* NestedRunCompiler.set(compileTempFile);
    yield* runXmd(
      args,
      useBunService,
      UPGRADE,
      () => readInputStream(process.stdin),
      importPluginModule,
      unsupportedWorkflowHost,
      unassembledMachineSessions(),
      // A terminal and a history, and no entry capability: this runtime names
      // no native adapter, so `<Issue>` in an entry reaches its ordinary
      // missing-provider refusal.
      { install: useBunRepl },
    );
  });
}
