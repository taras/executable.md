import type { Operation } from "effection";
import { serializeError } from "./serialize.ts";
import type { Json, Result } from "./types.ts";

/** Coordinates one live structured durable operation with its publication. */
export interface LiveDurableOperationCoordinator {
  run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: Result) => Operation<void>,
  ): Operation<Result>;
}

/** The ordinary live path: execute once, publish once, then return the same result. */
export const defaultLiveDurableOperationCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: Result) => Operation<void>,
  ): Operation<Result> {
    let result: Result;
    try {
      result = { status: "ok", value: yield* execute() };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      result = { status: "err", error: serializeError(failure) };
    }

    yield* publish(result);
    return result;
  },
};
