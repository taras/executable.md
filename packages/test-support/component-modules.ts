import { until } from "effection";
import type { Operation } from "effection";
import { cliRuntime } from "./launch.ts";

/** Explicitly install this fixture host's shipped component module loader. */
export function* useComponentModuleLoader(): Operation<void> {
  switch (cliRuntime()) {
    case "deno": {
      const host = yield* until(import("@executablemd/core/component-modules/deno"));
      yield* host.useDenoComponentModuleLoader();
      break;
    }
    case "node": {
      const host = yield* until(import("@executablemd/core/component-modules/node"));
      yield* host.useNodeComponentModuleLoader();
      break;
    }
    case "bun": {
      const host = yield* until(import("@executablemd/core/component-modules/bun"));
      yield* host.useBunComponentModuleLoader();
      break;
    }
  }
}
