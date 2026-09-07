import { Err, Ok, ensure, race, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
import { DurablePersistenceError, StaleInputError } from "@executablemd/durable-streams";
import { InvocationTeardownError } from "./invocation.ts";
import {
  EvaluationCandidateError,
  EvaluationInfrastructureError,
  EvaluationLimitError,
  EvaluationStaleError,
} from "./evaluation-errors.ts";
import { EvaluationOutputCapture } from "./evaluation-result.ts";
import type { EvaluationBounds } from "./evaluation-result.ts";
import type { ProjectionOwner } from "./projection-owner.ts";

export type { EvaluationCaptureOperation } from "./evaluation-operation.ts";

export interface EvaluationCaptureSession {
  cancelling(): boolean;
  teardown(error: InvocationTeardownError): void;
  readonly capture: EvaluationOutputCapture;
  bind(): Operation<void>;
}

export type EvaluationProjection = (session: EvaluationCaptureSession) => Operation<void>;

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
  invocation: string,
  component: string,
  owner: ProjectionOwner,
  enclosing?: EvaluationCaptureSession,
): Operation<Result<string>> {
  try {
    const output = yield* owner.run(invocation, component, (bind) =>
      scoped(function* () {
        const capture = new EvaluationOutputCapture(bounds.outputBytes, enclosing?.capture);
        let worker: Task<void> | undefined;
        let timer: Task<void> | undefined;
        let stopping = false;
        let cleanupFailure: unknown;
        const session: EvaluationCaptureSession = {
          capture,
          bind,
          cancelling: () => stopping,
          teardown(error) {
            cleanupFailure ??= error;
            enclosing?.teardown(error);
          },
        };
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
          }
        });
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
            yield* project(session);
            settled.resolve(Ok());
          } catch (error) {
            if (stopping) {
              cleanupFailure ??= error;
            }
            settled.resolve(Err(evaluationFailure(error)));
          }
        });
        // Racing notifications leaves teardown failures with the work's owner.
        const outcome = yield* race([settled.operation, expired.operation]);
        stopping = true;
        yield* worker.halt();
        yield* timer.halt();
        if (cleanupFailure !== undefined) {
          throw new EvaluationInfrastructureError("cleanup", cleanupFailure);
        }
        if (!outcome.ok) {
          throw outcome.error;
        }
        return capture.result();
      }),
    );
    return Ok(output);
  } catch (error) {
    return Err(evaluationFailure(error));
  }
}
