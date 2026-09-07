import { Err, Ok, ensure, race, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
import { DurablePersistenceError, StaleInputError } from "@executablemd/durable-streams";
import type { DurableStage, DurableStageFactory } from "@executablemd/durable-streams";
import { InvocationTeardownError } from "./invocation.ts";
import type { GeneratedObservationResult } from "./generated-xmd.ts";
import {
  EvaluationCandidateError,
  EvaluationInfrastructureError,
  EvaluationLimitError,
  EvaluationStaleError,
} from "./evaluation-errors.ts";
import { EvaluationResultCapture } from "./evaluation-result.ts";
import type { EvaluationBounds } from "./evaluation-result.ts";
import { EVALUATION_STAGE, evaluationRecord, readEvaluationRecord } from "./evaluation-records.ts";
import type { EvaluationEnvironment } from "./evaluation-records.ts";
import { isJsonObject, parseJson } from "./json.ts";

export type { EvaluationCaptureOperation } from "./evaluation-operation.ts";

/** Carried only by canonical expansion, never by a public context or request. */
export interface EvaluationCaptureSession {
  cancelling(): boolean;
  teardown(error: InvocationTeardownError): void;
  readonly capture: EvaluationResultCapture;
  readonly stage: DurableStage;
  begin(): void;
  source(value: string): void;
  complete(): void;
}

export type EvaluationProjection = (
  session: EvaluationCaptureSession,
  stage: DurableStage,
) => Operation<void>;

function containsCleanup(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof InvocationTeardownError) {
    return true;
  }
  return (
    (error instanceof AggregateError &&
      error.errors.some((cause) => containsCleanup(cause, seen))) ||
    (error instanceof Error && error.cause !== undefined && containsCleanup(error.cause, seen))
  );
}

export function evaluationFailure(error: unknown): Error {
  if (containsCleanup(error)) {
    return new EvaluationInfrastructureError("cleanup", error);
  }
  if (
    error instanceof EvaluationCandidateError ||
    error instanceof EvaluationLimitError ||
    error instanceof EvaluationStaleError ||
    error instanceof EvaluationInfrastructureError
  ) {
    return error;
  }
  if (error instanceof StaleInputError) {
    return new EvaluationStaleError("The evaluation's retained identity is stale.", {
      cause: error,
    });
  }
  return new EvaluationInfrastructureError(
    error instanceof DurablePersistenceError ? "persistence" : "runtime",
    error,
  );
}

export function* composeEvaluation(
  bounds: EvaluationBounds,
  project: EvaluationProjection,
  environment: EvaluationEnvironment,
  owner: string,
  invocation: string,
  factory: DurableStageFactory,
  enclosing?: EvaluationCaptureSession,
): Operation<Result<GeneratedObservationResult>> {
  return yield* scoped(function* () {
    const stage = yield* factory.create({ type: EVALUATION_STAGE, name: invocation, owner });
    const capture = new EvaluationResultCapture(bounds.resultBytes, enclosing?.capture);
    let began = false;
    let source: string | null = null;
    let completed: GeneratedObservationResult | undefined;
    const session: EvaluationCaptureSession = {
      cancelling: () => stopping,
      teardown(error): void {
        cleanupFailure ??= error;
        enclosing?.teardown(error);
      },
      capture,
      stage,
      begin(): void {
        if (began) {
          throw new EvaluationInfrastructureError(
            "runtime",
            new Error("A capture requires exactly one Evaluate invocation."),
          );
        }
        began = true;
        enclosing?.begin();
        capture.start();
      },
      source(value): void {
        source = value;
        enclosing?.source(value);
      },
      complete(): void {
        completed = capture.result();
        enclosing?.complete();
      },
    };
    let worker: Task<void> | undefined;
    let timer: Task<void> | undefined;
    let stopping = false;
    let cleanupFailure: unknown;
    yield* ensure(function* () {
      stopping = true;
      try {
        if (worker !== undefined) {
          yield* worker.halt();
        }
        if (timer !== undefined) {
          yield* timer.halt();
        }
      } finally {
        capture.close();
        stage.close();
      }
    });
    try {
      const settled = withResolvers<Result<void>>();
      const expired = withResolvers<Result<void>>();
      timer = yield* spawn(function* () {
        let remaining = bounds.durationMs;
        while (remaining > 0) {
          const interval = Math.min(remaining, 2147483647);
          yield* sleep(interval);
          remaining -= interval;
        }
        expired.resolve(Err(new EvaluationLimitError("duration")));
      });
      worker = yield* spawn(function* () {
        try {
          yield* stage.open();
          if (stage.retained === undefined) {
            yield* project(session, stage);
          }
          settled.resolve(Ok());
        } catch (error) {
          if (stopping) {
            cleanupFailure = error;
          }
          settled.resolve(Err(evaluationFailure(error)));
        }
      });
      // Race only notifications. Racing the work itself catches a loser's
      // teardown throw inside race's candidate and can hide it from its owner.
      const outcome = yield* race([settled.operation, expired.operation]);
      stopping = true;
      yield* worker.halt();
      yield* timer.halt();
      if (stage.failure !== undefined || cleanupFailure !== undefined) {
        return Err(new EvaluationInfrastructureError("cleanup", stage.failure ?? cleanupFailure));
      }
      if (!outcome.ok) {
        if (!stage.ready) {
          return Err(new EvaluationInfrastructureError("persistence", outcome.error));
        }
        if (
          outcome.error instanceof EvaluationCandidateError ||
          outcome.error instanceof EvaluationLimitError
        ) {
          yield* stage.finish(
            evaluationRecord(environment.fingerprint, invocation, source, outcome),
            false,
          );
        }
        return outcome;
      }
      if (stage.retained !== undefined) {
        const restored = readEvaluationRecord(
          stage.retained,
          environment.fingerprint,
          invocation,
          bounds,
        );
        if (restored.ok && enclosing !== undefined) {
          enclosing.begin();
          const record = parseJson(stage.retained);
          if (isJsonObject(record) && typeof record.source === "string") {
            enclosing.source(record.source);
          }
          for (const observation of restored.value.observations) {
            enclosing.capture.observation(observation);
          }
          enclosing.capture.output(restored.value.output);
          enclosing.complete();
        }
        return restored;
      }
      if (capture.failure !== undefined) {
        const refused = Err<GeneratedObservationResult>(capture.failure);
        yield* stage.finish(
          evaluationRecord(environment.fingerprint, invocation, source, refused),
          false,
        );
        return refused;
      }
      if (completed === undefined) {
        return Err(
          new EvaluationInfrastructureError(
            "runtime",
            new Error("The projection completed without a canonical Evaluate result."),
          ),
        );
      }
      capture.result();
      yield* stage.finish(
        evaluationRecord(environment.fingerprint, invocation, source, Ok(completed)),
        true,
      );
      return Ok(completed);
    } catch (error) {
      return Err(evaluationFailure(error));
    } finally {
      stopping = true;
    }
  });
}
