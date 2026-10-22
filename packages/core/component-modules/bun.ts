import { allSettled, ensure, until } from "effection";
import type { Operation } from "effection";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ComponentModuleLoader } from "../src/component-module-loader.ts";

function* load(source: string, origin: string): Operation<unknown> {
  const { componentSource } = yield* until(import("./transform.ts"));
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (
    typeof bun !== "object" ||
    bun === null ||
    !("resolveSync" in bun) ||
    typeof bun.resolveSync !== "function"
  ) {
    throw new Error("The Bun component module loader requires Bun.resolveSync");
  }
  const resolveSync = bun.resolveSync.bind(bun);
  const emitted = componentSource(source, origin, (specifier) => {
    const resolved: unknown = resolveSync(specifier, dirname(fileURLToPath(origin)));
    if (typeof resolved !== "string") {
      throw new Error("Bun.resolveSync returned no module path");
    }
    return isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved;
  });
  let url: string | undefined;
  const pending: Operation<unknown>[] = [];
  yield* ensure(function* () {
    try {
      yield* allSettled(pending);
    } finally {
      if (url !== undefined) {
        URL.revokeObjectURL(url);
      }
    }
  });
  url = URL.createObjectURL(new Blob([emitted], { type: "text/javascript" }));
  const imported = until(import(url));
  pending.push(imported);
  return yield* imported;
}

/** Install the Bun host's in-memory TypeScript module loader. */
export function* useBunComponentModuleLoader(): Operation<void> {
  yield* ComponentModuleLoader.set({ load });
}
