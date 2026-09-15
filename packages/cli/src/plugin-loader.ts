/**
 * Admitting the modules `--plugin` selected.
 *
 * Explicit only. Nothing here scans the current repository, `node_modules`, a
 * package manifest, the root document or the component search path for a
 * Plugin: a module is loaded because an operator named it, and a package that
 * happens to be installed does nothing at all.
 *
 * How a module is *reached* is the host's — see `host-plugin-modules.ts`. This
 * module holds the loader contract and what a loaded namespace has to be, which
 * is the same question under every runtime.
 *
 * ## Loading is running
 *
 * A selected module's top level executes before anything can look at what it
 * exported. That is what trusted means here: the admission below refuses a
 * module that exported no usable Plugin, and refuses it *after* its top level
 * has already run. Selected Plugin code can execute whatever the surrounding
 * runtime permits, and a refusal is not a sandbox.
 */

import type { Operation } from "effection";

import { parsePluginValue } from "@executablemd/core/host";
import type { Plugin } from "@executablemd/core/api";

/**
 * How this host loads one selected module.
 *
 * Supplied by the runtime entrypoint and called once per specifier, the way the
 * standard-input reader is: the shared command reaches no loader of its own,
 * and nothing a document can write reaches this.
 */
export type PluginModuleLoader = (specifier: string, directory: string) => Operation<unknown>;

/** What a module that exported no usable Plugin is refused with. */
function invalid(specifier: string, reason: string): Error {
  return new Error(`--plugin ${specifier}: ${reason}`);
}

/**
 * Load and admit every selected module, in the order the operator wrote them.
 *
 * Each module's namespace is read structurally: the default export is the
 * Plugin value, and a module that exports something else is refused naming the
 * specifier and the member that failed — never the module's own internals. What
 * admission returns is the value the module exported, so a Plugin carrying more
 * than the contract keeps it.
 */
export function* loadPlugins(
  specifiers: readonly string[],
  directory: string,
  load: PluginModuleLoader,
): Operation<readonly Plugin[]> {
  const loaded: Plugin[] = [];
  for (const specifier of specifiers) {
    let module: unknown;
    try {
      module = yield* load(specifier, directory);
    } catch (error) {
      throw new Error(
        `--plugin ${specifier} could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (typeof module !== "object" || module === null) {
      throw invalid(specifier, "the module exports nothing");
    }
    const exported = "default" in module ? module.default : undefined;
    const plugin = parsePluginValue(exported);
    if (!plugin.ok) {
      throw invalid(specifier, plugin.error.message);
    }
    loaded.push(plugin.value);
  }
  return loaded;
}
