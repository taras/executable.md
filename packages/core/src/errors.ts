import { createContext } from "effection";
import type { Context, Operation } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import { InvocationTeardownError } from "./invocation.ts";
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

/**
 * The error that ends the execution, if this failure carries one.
 *
 * Expansion turns a failure into a diagnostic the document can render, which
 * is right for anything the document itself got wrong. Two kinds are not that,
 * and every generic catch in the engine rethrows them:
 *
 * - `DocumentationError` — the ambient policy has already decided this
 *   execution fails (§6.9); collecting it would undo that decision.
 * - `StaleInputError` — a journal entry no longer describes the world it was
 *   recorded in (§6.11). The document is not wrong and there is nothing useful
 *   to render: continuing would run later siblings on top of work that never
 *   happened. Rendering it as a comment would let the ambient policy downgrade
 *   a durability failure to a note.
 *
 * A fatal error stays fatal however it is wrapped, so this looks through the
 * three ways the engine and the platform aggregate failures: an
 * `InvocationTeardownError`'s causes (§4.4), an `AggregateError`'s members,
 * and an ordinary `cause`. It returns the fatal error itself rather than the
 * wrapper, which is the one worth reporting.
 *
 * Cause graphs are arbitrary — nothing stops `error.cause` from pointing back
 * at `error` — so traversal remembers what it has seen. Recursing forever would
 * turn an ordinary diagnostic into a stack overflow, which is exactly the
 * failure this function exists to prevent.
 */
export function fatalCause(error: unknown): DocumentationError | StaleInputError | undefined {
  return findFatal(error, new Set());
}

function findFatal(
  error: unknown,
  seen: Set<unknown>,
): DocumentationError | StaleInputError | undefined {
  if (error instanceof DocumentationError || error instanceof StaleInputError) {
    return error;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  for (const cause of causesOf(error)) {
    const fatal = findFatal(cause, seen);
    if (fatal !== undefined) {
      return fatal;
    }
  }
  return undefined;
}

/** The wrapper contracts a failure can aggregate other failures through. */
function causesOf(error: object): unknown[] {
  if (error instanceof InvocationTeardownError) {
    return error.causes;
  }
  if (error instanceof AggregateError) {
    return error.errors;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return [error.cause];
  }
  return [];
}
