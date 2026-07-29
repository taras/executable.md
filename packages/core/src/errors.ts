import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { ErrorSegment } from "./types.ts";

/**
 * How an ErrorSegment settles once it has been reported (spec §6.9).
 *
 * `Component.raise` is the observation chain — every segment passes through it
 * exactly once, where it is created. Settlement is this separate value, so an
 * error crossing from a component's own policy to its caller's does not emit a
 * second observation.
 */
export type ErrorPolicy = "collect" | "throw";

export const AmbientErrorPolicy: Context<ErrorPolicy> = createContext<ErrorPolicy>(
  "component.errorPolicy",
  "collect",
);

/**
 * Settle a segment under the ambient policy: the default `Component.raise`
 * implementation calls this, and so does a consumer applying its own policy to
 * an error that already crossed a nested one.
 */
export function* settle(segment: ErrorSegment): Operation<ErrorSegment> {
  const policy = yield* AmbientErrorPolicy.get();
  if (policy === "throw") {
    throw new DocumentationError(segment);
  }
  return segment;
}

/**
 * Thrown by suppressed-documentation settlement (spec §6.9). Generic
 * catches in the engine rethrow it instead of converting it into an
 * ErrorSegment, so documentation fail-fast is never swallowed.
 */
export class DocumentationError extends Error {
  readonly segment: ErrorSegment;

  constructor(segment: ErrorSegment) {
    super(segment.message);
    this.name = "DocumentationError";
    this.segment = segment;
  }
}
