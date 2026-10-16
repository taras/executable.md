/**
 * The live repository behavior, assembled where it can be.
 *
 * Kept apart from `run-repositories.ts` because that module is on the shared
 * command path and this one names the Deno adapter, whose module graph reaches
 * `node:sqlite`. Bun has no such built-in, so a static import of this from
 * shared code would stop `xmd` loading there — not refuse a repository
 * operation, but fail to start at all. Only `deno.ts`, `compiled.ts` and the
 * two REPL hosts beside them import this file, and all of them are Deno.
 *
 * Managed checkouts live beneath `~/.xmd/repositories` and survive every
 * execution: what is in one is somebody's work, and nothing deletes one. There
 * is no environment variable naming a different root, because the only caller
 * that needs one is a test, and a test is handed the root directly.
 *
 * ## Configuration here, provider inside the execution
 *
 * What this module builds is a Plugin and a piece of middleware — inert values
 * holding this deployment's credential-helper assembly and managed root. The
 * provider itself is created by `Execution.init()`, inside the scope the
 * invocation already owns, so every execution has its own: its own ambient
 * discovery, its own leases, its own Push evidence, and teardown joined before
 * the invocation settles. Two concurrent executions share none of it, and a
 * child shares nothing with its parent.
 */

import { Execution } from "@executablemd/core/api";
import type { Plugin, PluginInstallRequest, PluginInstallation } from "@executablemd/core/api";
import type { Operation } from "effection";
import { cwd } from "@executablemd/runtime";
import { gitPlugin } from "@executablemd/git";
import { useReplRepositoryRecording, useRunComposition } from "@executablemd/git/deno";
import type { HelperAssembly } from "@executablemd/git/credential-helper";
import { DEFAULT_REPOSITORY_ROOT } from "./run-repositories.ts";

/**
 * The bundled Git Plugin, configured for this deployment.
 *
 * The same Plugin by name and vocabulary as the provider-neutral one — it
 * delegates the whole of that install, declarations and admissions included —
 * with one addition: for the command that runs an ordinary document, it
 * registers what that execution initializes. Node and Bun select the neutral
 * value instead and reach none of this.
 *
 * It reads no configuration of its own. The two GitHub variables belong to the
 * adapter inside `@executablemd/git`, which reads them when an invoked
 * GitHub-backed operation needs them — so a run that opens no pull request and
 * files no issue reads neither, and an operator who wrote something unusable
 * learns it from the operation that needed it rather than from a command that
 * was only starting up.
 */
export function denoRunRepositories(
  helper: HelperAssembly,
  root: string = DEFAULT_REPOSITORY_ROOT,
): Plugin {
  return {
    // The bundled name, because this *is* the bundled Plugin: an operator
    // selecting `--plugin git` is naming this value, and two values under one
    // name is the collision `admitPlugins()` refuses.
    name: gitPlugin.name,
    *install(request: PluginInstallRequest): Operation<PluginInstallation | undefined> {
      // The neutral value's own install, whole: this variant adds to the
      // bundled Plugin rather than reimplementing it, so the vocabulary, the
      // commands it declares for and the admissions it contributes are the ones
      // that package decides.
      const install = gitPlugin.install;
      const declared = install === undefined ? undefined : yield* install(request);
      if (declared === undefined) {
        return undefined;
      }
      // Only for the command whose documents are ordinary runs. `repl` records
      // its entries through the REPL host below, `plan` and `syntax` describe a
      // document without executing anybody's, and a workflow run's provider is
      // the one its Workspace attachment installs.
      if (request.command !== "run") {
        return declared;
      }
      yield* Execution.around({
        *init(_args, next): Operation<void> {
          yield* useRunComposition({
            root,
            // The directory this execution starts in, which is where the
            // ambient repository is discovered from. Read at initialization
            // through the contextual Api rather than from the process, so an
            // isolated child that composed its own working directory is
            // discovered from that one.
            cwd: yield* cwd(),
            helper,
          });
          yield* next();
        },
      });
      return declared;
    },
  };
}

/**
 * What a REPL entry's execution initializes: recording, and nothing else.
 *
 * Registered by the selected REPL host rather than by the bundled Plugin,
 * because an entry is not an ordinary run: it retains the file work it does in
 * the checkout the person is standing in, and installs no managed root,
 * credential helper or Git host. Each executing entry initializes its own, in
 * the scope below its Agent attachment, so a passive view — a settled history,
 * a frozen position — initializes nothing and takes no lease.
 */
export function* useDenoReplRepositories(): Operation<void> {
  yield* Execution.around({
    *init(_args, next): Operation<void> {
      yield* useReplRepositoryRecording();
      yield* next();
    },
  });
}
