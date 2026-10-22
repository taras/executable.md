import { ensure, Err, Ok, scoped, suspend, useScope, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
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
      const ready = withResolvers<Result<unknown>>();
      let child: Task<void> | undefined;
      let transferred = false;
      yield* ensure(function* () {
        if (!transferred && child !== undefined) {
          yield* child.halt();
        }
      });
      child = owner.run(function* () {
        let value: unknown;
        try {
          value = yield* load(source, origin);
        } catch (error) {
          ready.resolve(Err(error));
          return;
        }
        ready.resolve(Ok(value));
        yield* suspend();
      });
      const result = yield* ready.operation;
      if (!result.ok) {
        yield* child;
        throw result.error;
      }
      transferred = true;
      return result.value;
    });
}
