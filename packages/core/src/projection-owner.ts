import { all, scoped, useScope } from "effection";
import type { Operation } from "effection";
import {
  createDurableOperation,
  DurableContext,
  runDurableChild,
} from "@executablemd/durable-streams";
import { EvaluationInfrastructureError, EvaluationStaleError } from "./evaluation-errors.ts";
import {
  liveProjectionFailure,
  projectionFailure,
  retainedProjectionFailure,
} from "./projection-failure.ts";
import { PROJECTION_ENTER, projectionId } from "./projection-history.ts";
import type { EvaluationEnvironment } from "./evaluation-records.ts";
import { canonicalFingerprint } from "./canonical.ts";
import { parseJson } from "./json.ts";

export interface ProjectionOwner {
  run(
    invocation: string,
    component: string,
    body: (bind: () => Operation<void>) => Operation<string>,
  ): Operation<string>;
  close(): void;
}

/** Captured by execution before any public replay hook receives control. */
export function projectionOwner(
  context: DurableContext,
  environment: EvaluationEnvironment | undefined,
): ProjectionOwner {
  const parent = { ...context };
  const entered = new Set<string>();
  let live = true;
  return {
    *run(invocation, component, body) {
      if (!live || entered.has(invocation)) {
        throw new EvaluationStaleError("The projection owner is not available.");
      }
      entered.add(invocation);
      const childId = projectionId(parent.coroutineId, invocation);
      if (
        environment === undefined ||
        !environment.configurations.some((entry) => entry.owner === component)
      ) {
        throw new EvaluationStaleError("The projection has no current configuration.");
      }
      const identity = { version: 1, component, invocation, environment: environment.fingerprint };
      const retained = parent.replayIndex.getClose(childId);
      if (retained?.result.status === "err") {
        parent.replayIndex.claim(childId);
        throw retainedProjectionFailure(retained.result.error, childId);
      }
      let output: string;
      try {
        [output] = yield* all([
          (function* () {
            return yield* runDurableChild(
              function* () {
                const child = { ...(yield* DurableContext.expect()) };
                yield* scoped(function* () {
                  const retained: unknown = yield createDurableOperation(
                    { type: PROJECTION_ENTER, name: childId },
                    function* () {
                      return identity;
                    },
                  );
                  if (
                    canonicalFingerprint(parseJson(retained)) !== canonicalFingerprint(identity)
                  ) {
                    throw new EvaluationStaleError("The retained projection identity changed.");
                  }
                });

                let open = true;
                try {
                  return yield* scoped(() =>
                    body(function* () {
                      if (!live || !open) {
                        throw new EvaluationStaleError("The projection owner has closed.");
                      }
                      const frame = yield* useScope();
                      frame.set(DurableContext, { ...child });
                    }),
                  );
                } catch (cause) {
                  const error =
                    cause instanceof Error
                      ? cause
                      : new EvaluationInfrastructureError("runtime", cause);
                  throw projectionFailure(error, childId);
                } finally {
                  open = false;
                }
              },
              childId,
              parent,
            );
          })(),
        ]);
      } catch (error) {
        throw liveProjectionFailure(error);
      }
      if (typeof output !== "string") {
        throw new EvaluationStaleError("The retained projection does not contain text.");
      }
      return output;
    },
    close() {
      live = false;
    },
  };
}
