import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { serializeError } from "./serialize.ts";
import type { Json, Result } from "./types.ts";

export interface LiveDurableEffect<T extends Json> {
  execute(): Operation<T>;
  publish(result: Result): Operation<void>;
}

export interface LiveDurableEffectCoordinatorApi {
  coordinate(effect: LiveDurableEffect<Json>): Operation<Result>;
}

export type LiveDurableEffectCoordinate = <T extends Json>(
  effect: LiveDurableEffect<T>,
) => Operation<Result>;

export const LiveDurableEffectCoordinator: Api<LiveDurableEffectCoordinatorApi> =
  createApi<LiveDurableEffectCoordinatorApi>("executablemd.durable-streams.live-coordinator", {
    *coordinate(effect: LiveDurableEffect<Json>): Operation<Result> {
      let result: Result;
      try {
        result = { status: "ok", value: yield* effect.execute() };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        result = { status: "err", error: serializeError(failure) };
      }
      yield* effect.publish(result);
      return result;
    },
  });

export const coordinateLiveDurableEffect = LiveDurableEffectCoordinator.operations.coordinate;
