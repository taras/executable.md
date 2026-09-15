/**
 * Loading the modules `--plugin` selected.
 *
 * Explicit only. Nothing here scans the current repository, `node_modules`, a
 * package manifest, the root document or the component search path for a
 * Plugin: a module is loaded because an operator named it or because this
 * distribution bundles it, and a package that happens to be installed does
 * nothing at all.
 *
 * Resolution happens from the invocation's own working directory, captured
 * before the first module is loaded. A relative path means what the caller
 * meant by it, and a bare package specifier resolves in the package environment
 * the caller is standing in — not in the CLI's, which would make a global
 * install, an npm install and a compiled binary disagree about what one name
 * means.
 *
 * ## Loading is running
 *
 * A selected module's top level executes before anything can look at what it
 * exported. That is what trusted means here: the admission below refuses a
 * module that exported no usable Plugin, and refuses it *after* its top level
 * has already run. There is no sandbox, and a refusal is not one.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parsePluginValue } from "@executablemd/core/api";
import type { Plugin } from "@executablemd/core/api";

/**
 * How this host loads one selected module.
 *
 * Supplied by the runtime entrypoint and called once per specifier, the way the
 * standard-input reader is: the shared command reaches no loader of its own.
 */
export type PluginModuleLoader = (specifier: string, directory: string) => Operation<unknown>;

/** Schemes this CLI will not load code from. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** What a remote specifier is refused with. */
function remote(specifier: string): Error {
  return new Error(
    `--plugin ${specifier} names a remote module, and xmd loads no code over the network. ` +
      "Install the package and name it, or name a path inside this checkout.",
  );
}

/**
 * The module URL one specifier names, resolved from the invocation directory.
 *
 * A path — relative, absolute, or already a `file:` URL — resolves against that
 * directory. Anything else is a package specifier and resolves through the
 * package environment rooted there.
 */
export function resolvePluginSpecifier(specifier: string, directory: string): URL {
  if (SCHEME.test(specifier)) {
    if (!specifier.startsWith("file:")) {
      throw remote(specifier);
    }
    return new URL(specifier);
  }
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return pathToFileURL(resolve(directory, specifier));
  }
  const from = createRequire(pathToFileURL(join(directory, "package.json")));
  return pathToFileURL(from.resolve(specifier));
}

/**
 * Import one selected module.
 *
 * A computed `import()` through `until`, so the load has this operation's
 * lifetime. Every runtime entrypoint supplies this same function: what differs
 * between the four hosts is the permission the process already holds, not how a
 * module is named.
 */
export function* importPluginModule(specifier: string, directory: string): Operation<unknown> {
  const url = resolvePluginSpecifier(specifier, directory);
  return yield* until(import(url.href));
}

/** What a module that exported no usable Plugin is refused with. */
function invalid(specifier: string, reason: string): Error {
  return new Error(`--plugin ${specifier}: ${reason}`);
}

/**
 * Load and admit every selected module, in the order the operator wrote them.
 *
 * Each module's namespace is read structurally: the default export is the
 * Plugin value, and a module that exports something else is refused naming the
 * specifier and the member that failed — never the module's own internals.
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
