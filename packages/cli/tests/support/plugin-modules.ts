/**
 * The Plugin module loader a suite driving `runXmd` in-process stands in for.
 *
 * A runtime entrypoint supplies the operation that reaches a module, and
 * `runXmd` requires one because reaching the host from the shared CLI is
 * exactly what the parameter exists to prevent. A suite about another command
 * says the honest thing: nothing it runs names a `--plugin`, so a loader that
 * was called at all is a defect rather than an unread value.
 */

import type { Operation } from "effection";
import type { PluginModuleLoader } from "../../src/plugin-loader.ts";

export const refusedPluginModules: PluginModuleLoader = function* (
  specifier: string,
): Operation<unknown> {
  throw new Error(`this run loaded a Plugin module: ${specifier}`);
};
