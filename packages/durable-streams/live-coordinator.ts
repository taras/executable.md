import type { Operation } from "effection";
import type { JournalProvenance } from "./guard.ts";
import { serializeError } from "./serialize.ts";
import type { EffectDescription, Json, Result } from "./types.ts";

/** Activates the first infrastructure failure for the enclosing durable run. */
export type ActivateDurabilityFailure = (failure: unknown) => Error;

/**
 * What replay left behind at this position, when it left anything.
 *
 * Present only when a retained entry was there and divergence policy chose to
 * run live rather than refuse. It is the engine's own account of the position,
 * so an effect whose live work reaches outside this journal can decide whether
 * running live here is something it may do — without asking anything a document
 * supplies.
 */
export interface AbandonedRetainedEntry {
  readonly description: EffectDescription;
  readonly result: Result;
}

/** Coordinates one live structured durable operation with its publication. */
export interface LiveDurableOperationCoordinator {
  run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: Result) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
    journalProvenance: JournalProvenance | undefined,
    abandoned: AbandonedRetainedEntry | undefined,
  ): Operation<Result>;
}

/** The ordinary live path: execute once, publish once, then return the same result. */
export const defaultLiveDurableOperationCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: Result) => Operation<void>,
    _activateFailure: ActivateDurabilityFailure,
    _journalProvenance: JournalProvenance | undefined,
    _abandoned: AbandonedRetainedEntry | undefined,
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
