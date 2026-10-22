import { ensure, scoped, suspend, useScope, withResolvers } from "effection";
import type { Operation, Task } from "effection";
import { unbox, useEvalScope } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";
import { ComponentModuleLoader } from "./component-module-loader.ts";

export type LoadComponentModule = (source: string, origin: string) => Operation<unknown>;

/** Keep native module resources on the canonical invocation, beyond ephemeral imports. */
export function* useComponentModules(): Operation<LoadComponentModule> {
  const selected = yield* ComponentModuleLoader.get();
  const load = selected?.load.bind(selected);
  const owner = yield* useScope();

  return (source, origin) =>
    scoped(function* () {
      if (load === undefined) {
        throw new Error(
          "TypeScript component module loader is not installed — bind ComponentModuleLoader for this host before loading TypeScript components.",
        );
      }
      const ready = withResolvers<EvalScope>();
      let child: Task<void> | undefined;
      let transferred = false;
      yield* ensure(function* () {
        if (!transferred && child !== undefined) {
          yield* child.halt();
        }
      });
      child = owner.run(function* () {
        try {
          ready.resolve(yield* useEvalScope());
        } catch (error) {
          ready.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        yield* suspend();
      });
      const evaluation = yield* ready.operation;
      const namespace = unbox(yield* evaluation.eval(() => load(source, origin)));
      transferred = true;
      return namespace;
    });
}
