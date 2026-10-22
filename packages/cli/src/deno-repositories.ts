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
import { useRunComposition } from "@executablemd/git/deno";
import { replRepositoryInstallation } from "./repl/repositories/deno/provider.ts";
import { replRepositoryPlugin } from "./repl/repositories/plugin.ts";
import type { HelperAssembly } from "@executablemd/git/credential-helper";
import { DEFAULT_REPOSITORY_ROOT } from "./run-repositories.ts";
import { ReplEntryHost } from "./repl-entry-installation.ts";
import type { ReplEntryInstallation } from "./repl-entry-installation.ts";

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
  // Copied here, at construction, rather than held as the caller's object.
  // What an execution initializes with has to be what this host selected: a
  // caller that kept a reference and changed a field afterwards would be
  // configuring every later execution, including a child's, from outside the
  // selection the command already made. The caller's own object is neither
  // mutated nor frozen — this is a copy, and the copy is what is used.
  const configured = snapshot(helper);
  // The same CLI assembly the default selection uses, constructed once here, so
  // a `repl` request reaches this command's entry-history admission through
  // this configured variant as well.
  const bundled = replRepositoryPlugin(gitPlugin);
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
      const install = bundled.install;
      const declared = install === undefined ? undefined : yield* install.call(bundled, request);
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
            helper: configured,
          });
          yield* next();
        },
      });
      return declared;
    },
  };
}

/**
 * What a REPL entry runs with on this host: its checkouts, its local Git, its
 * publications and its issues.
 *
 * Inert, and selected by the runtime entrypoint beside the bundled Plugin:
 * naming the native adapter and this runtime's own credential-helper assembly
 * is a runtime-named module's business, and this is the value the shared
 * command path carries without importing one. It reads no configuration and
 * holds no credential — what an entry's work is allowed to reach is read by the
 * invoked operation that needs it.
 *
 * The owner is supplied per entry by the session that derived it, which is why
 * this is a factory rather than an installation: one value per host, one
 * capability per entry. One factory, because an entry initializes its
 * repository state once; two registrations of it would be two providers.
 */
export function denoReplEntry(helper: HelperAssembly, root: string): ReplEntryInstallation {
  // Copied here, at selection, rather than held as the caller's object. What an
  // entry initializes with has to be what this host selected: a caller that
  // kept a reference and changed a field afterwards would be configuring every
  // later entry from outside the selection the command already made.
  const configured = snapshot(helper);
  return (owner, placement) =>
    replRepositoryInstallation(owner, {
      helper: configured,
      root,
      ...placement,
    });
}

/**
 * Select that value for the REPL command that is about to assemble itself.
 *
 * Called by the shared command path at the one moment it belongs — before the
 * profile that captures it — and reached from the entrypoints that may name
 * this adapter. Setting it establishes nothing: the value is inert code, and
 * what an entry does with it happens inside that entry.
 */
export function* selectReplEntryHost(
  helper: HelperAssembly,
  root: string = DEFAULT_REPOSITORY_ROOT,
): Operation<void> {
  yield* ReplEntryHost.set(denoReplEntry(helper, root));
}

/**
 * This deployment's helper configuration, copied by value.
 *
 * Scalars and the nested launcher environment both: the environment is the one
 * member whose contents a caller could change after handing it over, and
 * copying the object while sharing that record would copy nothing that matters.
 * Absent members stay absent, because `undefined` and "not stated" are
 * different answers to `helperCommand`.
 */
function snapshot(helper: HelperAssembly): HelperAssembly {
  return Object.freeze({
    runtime: helper.runtime,
    platform: helper.platform,
    execPath: helper.execPath,
    ...(helper.modulePath === undefined ? {} : { modulePath: helper.modulePath }),
    ...(helper.launcherEnvironment === undefined
      ? {}
      : { launcherEnvironment: Object.freeze({ ...helper.launcherEnvironment }) }),
  });
}
