import type { Operation } from "effection";
import type { DurablePublicationIdentity } from "./guard.ts";
import { serializeError } from "./serialize.ts";
import type { Json, Result } from "./types.ts";

/** Activates the first infrastructure failure for the enclosing durable run. */
export type ActivateDurabilityFailure = (failure: unknown) => Error;

/** Coordinates one live structured durable operation with its publication. */
export interface LiveDurableOperationCoordinator {
  run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: Result) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
    publicationIdentity: DurablePublicationIdentity | undefined,
  ): Operation<Result>;
}

/** The ordinary live path: execute once, publish once, then return the same result. */
export const defaultLiveDurableOperationCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: Result) => Operation<void>,
    _activateFailure: ActivateDurabilityFailure,
    _publicationIdentity: DurablePublicationIdentity | undefined,
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
