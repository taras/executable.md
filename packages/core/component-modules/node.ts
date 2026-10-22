import * as moduleApi from "node:module";
import type { Operation } from "effection";
import { ComponentModuleLoader } from "../src/component-module-loader.ts";
import { loadHookModule } from "./hooks.ts";

/** Install the Node host's in-memory TypeScript module loader. */
export function* useNodeComponentModuleLoader(): Operation<void> {
  yield* ComponentModuleLoader.set({
    load: (source, origin) => loadHookModule(source, origin, moduleApi.registerHooks),
  });
}
