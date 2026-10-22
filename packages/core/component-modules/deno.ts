import * as moduleApi from "node:module";
import type { Operation } from "effection";
import { ComponentModuleLoader } from "../src/component-module-loader.ts";
import { loadHookModule } from "./hooks.ts";

/** Install the Deno and compiled host's in-memory TypeScript module loader. */
export function* useDenoComponentModuleLoader(): Operation<void> {
  yield* ComponentModuleLoader.set({
    load: (source, origin) =>
      loadHookModule(source, origin, (options) =>
        moduleApi.registerHooks({
          ...options,
          load(url, context, next) {
            const delegate: typeof next = (url, context) => {
              const loaded = next(url, context);
              // Deno's delegated CommonJS JSON load omits its native format hint.
              return loaded.format == null &&
                url.startsWith("file:") &&
                new URL(url).pathname.endsWith(".json")
                ? { ...loaded, format: "json" }
                : loaded;
            };
            return options.load === undefined
              ? delegate(url, context)
              : options.load(url, context, delegate);
          },
        }),
      ),
  });
}
