import { all, scoped, useScope } from "effection";
import type { Operation } from "effection";
import { DurableContext, runDurableChild } from "@executablemd/durable-streams";
import { canonicalFingerprint } from "./canonical.ts";
import {
  EvaluationCandidateError,
  EvaluationInfrastructureError,
  EvaluationLimitError,
  EvaluationStaleError,
} from "./evaluation-errors.ts";
import { deserializeError } from "@executablemd/durable-streams";
import type { SerializedError } from "@executablemd/durable-streams";

/** Only the canonical owner's ordinary Close carries a settled evaluation failure. */
export function retainedEvaluationFailure(record: SerializedError): Error {
  const cause = deserializeError(record);
  switch (record.name) {
    case "EvaluationCandidateError":
      return new EvaluationCandidateError("retained-refusal", record.message, { cause });
    case "EvaluationDurationError":
      return new EvaluationLimitError("duration", { cause });
    case "EvaluationOutputLimitError":
      return new EvaluationLimitError("output-bytes", { cause });
    case "EvaluationStaleError":
      return new EvaluationStaleError(record.message, { cause });
    case "EvaluationInfrastructureError:setup":
      return new EvaluationInfrastructureError("setup", cause);
    case "EvaluationInfrastructureError:cleanup":
      return new EvaluationInfrastructureError("cleanup", cause);
    case "EvaluationInfrastructureError:persistence":
      return new EvaluationInfrastructureError("persistence", cause);
    default:
      return new EvaluationInfrastructureError("runtime", cause);
  }
}

export interface ProjectionOwner {
  run(
    invocation: string,
    body: (bind: () => Operation<void>) => Operation<string>,
  ): Operation<string>;
  close(): void;
}

/** Captured by execution before any public replay hook receives control. */
export function projectionOwner(context: DurableContext): ProjectionOwner {
  const parent = { ...context };
  const entered = new Set<string>();
  let live = true;
  return {
    *run(invocation, body) {
      if (!live || entered.has(invocation)) {
        throw new EvaluationStaleError("The projection owner is not available.");
      }
      entered.add(invocation);
      const childId = `${parent.coroutineId}.projection-${canonicalFingerprint(invocation)}`;
      const retained = parent.replayIndex.getClose(childId);
      if (retained?.result.status === "err") {
        parent.replayIndex.claim(childId);
        throw retainedEvaluationFailure(retained.result.error);
      }
      const [output] = yield* all([
        (function* () {
          return yield* runDurableChild(
            function* () {
              const child = { ...(yield* DurableContext.expect()) };
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
              } finally {
                open = false;
              }
            },
            childId,
            parent,
          );
        })(),
      ]);
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
