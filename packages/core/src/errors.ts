import { createContext } from "effection";
import type { Context, Operation } from "effection";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  EarlyReturnDivergenceError,
  StaleInputError,
} from "@executablemd/durable-streams";
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
 * A failure that says the journal no longer describes this run: a stale
 * recorded input (§6.11), or a divergence between what the journal holds and
 * what the run reached.
 */
export type DurabilityFailure =
  | StaleInputError
  | DivergenceError
  | EarlyReturnDivergenceError
  | ContinuePastCloseDivergenceError;

/** A failure that ends the execution rather than becoming a diagnostic. */
export type FatalFailure = DocumentationError | DurabilityFailure;

/**
 * The error that ends the execution, if this failure carries one.
 *
 * Expansion turns a failure into a diagnostic the document can render, which
 * is right for anything the document itself got wrong. Two kinds are not that,
 * and every generic catch in the engine rethrows them:
 *
 * - `DocumentationError` — the ambient policy has already decided this
 *   execution fails (§6.9); collecting it would undo that decision.
 * - a `DurabilityFailure` — the journal no longer describes this run (§6.11).
 *   The document is not wrong and there is nothing useful to render: continuing
 *   would run later siblings on top of work that never happened, and rendering
 *   it as a comment would let the ambient policy downgrade a durability failure
 *   to a note. It would also bury *where* the journal stopped describing the
 *   run: expansion that carried on would reach another durable operation, whose
 *   own mismatch is then the one reported.
 *
 * A fatal error stays fatal however it is wrapped, so this looks through the
 * three ways the engine and the platform aggregate failures. It returns the
 * fatal error itself rather than the wrapper, which is the one worth reporting.
 *
 * **A durability failure outranks a documentation failure**, wherever each sits
 * in the graph. A wrapper carries whatever failed together, in whatever order
 * the platform happened to collect it, and one of those orders would otherwise
 * report the document's failure and let the loop record an `error` outcome onto
 * a journal already known not to describe this run. Precedence is therefore
 * decided by kind, not by position: the graph is searched for a durability
 * failure first, and only a graph without one reports a documentation failure.
 */
export function fatalCause(error: unknown): FatalFailure | undefined {
  return durabilityFailure(error) ?? firstCause(error, asDocumentationError);
}

/**
 * The durability failure this one carries, if any.
 *
 * A durability failure is not something the document did, so nothing may record
 * it as an outcome of the document's own work: doing that would append or
 * consume a journal entry on top of a journal already known to be wrong.
 * `DocumentationError` is deliberately not included — an ordinary document
 * failure *is* an outcome, which is why this is a narrower question than
 * `fatalCause`.
 */
export function durabilityFailure(error: unknown): DurabilityFailure | undefined {
  return firstCause(error, asDurabilityFailure);
}

function asDurabilityFailure(error: unknown): DurabilityFailure | undefined {
  if (
    error instanceof StaleInputError ||
    error instanceof DivergenceError ||
    error instanceof EarlyReturnDivergenceError ||
    error instanceof ContinuePastCloseDivergenceError
  ) {
    return error;
  }
  return undefined;
}

function asDocumentationError(error: unknown): DocumentationError | undefined {
  return error instanceof DocumentationError ? error : undefined;
}

/**
 * The first failure in this one's cause graph that `select` recognises.
 *
 * Cause graphs are arbitrary — nothing stops `error.cause` from pointing back
 * at `error` — so traversal remembers what it has seen. Recursing forever would
 * turn an ordinary diagnostic into a stack overflow, which is exactly the
 * failure this traversal exists to prevent. Every question asked of a failure
 * shares it, so no two can drift on what counts as a wrapper.
 */
function firstCause<T>(
  error: unknown,
  select: (candidate: unknown) => T | undefined,
): T | undefined {
  return walkCauses(error, select, new Set());
}

function walkCauses<T>(
  error: unknown,
  select: (candidate: unknown) => T | undefined,
  seen: Set<unknown>,
): T | undefined {
  const selected = select(error);
  if (selected !== undefined) {
    return selected;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  for (const cause of causesOf(error)) {
    const found = walkCauses(cause, select, seen);
    if (found !== undefined) {
      return found;
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
