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
 * The failure a contextual ErrorSegment was translated from.
 *
 * The segment is what the document says; the failure is the structural account
 * of how expansion got there, and a component that recovered from failed content
 * and then failed on its own terms is the only place that account survives. The
 * two have to arrive together: settlement happens at the far end of the
 * observation chain, which carries the segment and nothing else, so the link
 * travels beside the chain instead of through it. Every `DocumentationError`
 * built for the segment therefore has its `cause` in place before any observer —
 * including middleware that catches what `raise` throws — can look at it.
 */
const segmentCauses = new WeakMap<ErrorSegment, unknown>();

/**
 * Internal: record what expansion translated into this segment, before raising
 * it. Not part of the package surface — an author reports a failure by throwing
 * it, and the engine decides what a diagnostic is made from.
 */
export function attributeCause(segment: ErrorSegment, from: unknown): void {
  segmentCauses.set(segment, from);
}

/**
 * Thrown by suppressed-documentation settlement (spec §6.9). Generic
 * catches in the engine rethrow it instead of converting it into an
 * ErrorSegment, so documentation fail-fast is never swallowed.
 *
 * A segment that expansion built from a failure of its own brings that failure
 * along as `cause`, so nothing that catches this error can see it without the
 * account of how the component got there.
 */
export class DocumentationError extends Error {
  readonly segment: ErrorSegment;

  constructor(segment: ErrorSegment) {
    super(segment.message);
    this.name = "DocumentationError";
    this.segment = segment;
    // Membership, not value: a component can throw `undefined`, and that is
    // still the exact value this failure was translated from — the own `cause`
    // property records it. Only a segment with no attribution has none.
    if (segmentCauses.has(segment)) {
      this.cause = segmentCauses.get(segment);
    }
  }
}

/**
 * What `content()` throws when the requested content fails to expand.
 *
 * `errors` holds the original `ErrorSegment` references in source order — not
 * copies, and not a rendered string — so a component that recovers can inspect
 * the same objects the document reports.
 *
 * Catching this at `yield* content()` is explicit recovery: the component
 * decides what to render instead, and the failure never reaches its consumer.
 * The same shape is presented under both `collect` and `throw`, so recovery
 * code does not branch on the ambient policy. Left uncaught, normal
 * continuation stops and the invocation boundary reports the original errors
 * under the consumer's policy.
 *
 * A component that recovers and then fails on its own terms keeps this error in
 * the cause chain of the failure it reports, so the content failure it recovered
 * from — and the segments it carries — stay reachable from the outside. What is
 * *reported* is still the component's own failure: documentation discovery stops
 * here rather than continuing into the decision the component replaced
 * (`isRecoveredContent`).
 */
export class ContentError extends Error {
  readonly errors: readonly ErrorSegment[];

  constructor(errors: readonly ErrorSegment[]) {
    super(errors[0]?.message ?? "content failed to expand");
    this.name = "ContentError";
    this.errors = errors;
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
 * This looks through the three ways the engine and the platform aggregate
 * failures and returns the fatal error itself rather than the wrapper, which is
 * the one worth reporting. The two kinds travel differently: a durability
 * failure stays fatal through the complete cause graph, while a
 * `DocumentationError` remains fatal unless it crossed an explicit
 * `ContentError` recovery boundary — a component that recovered decided what
 * the document reports. An uncaught private content transport restores its
 * original `DocumentationError` explicitly at the function-component boundary,
 * not through this traversal.
 *
 * **A durability failure outranks a documentation failure**, wherever each sits
 * in the graph. A wrapper carries whatever failed together, in whatever order
 * the platform happened to collect it, and one of those orders would otherwise
 * report the document's failure and let the loop record an `error` outcome onto
 * a journal already known not to describe this run. Precedence is therefore
 * decided by kind, not by position: the graph is searched for a durability
 * failure first, and only a graph without one reports a documentation failure.
 *
 * The two searches reach different parts of the same graph. A content failure
 * ends the documentation search and not the durability one — see
 * `isRecoveredContent` for why the asymmetry is the point.
 */
export function fatalCause(error: unknown): FatalFailure | undefined {
  return durabilityFailure(error) ?? firstCause(error, asDocumentationError, isRecoveredContent);
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
 *
 * This walks the whole graph. Nothing a failure is wrapped in may keep a
 * durability failure from being found, so unlike documentation discovery it
 * treats no node as a leaf.
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
 * A failure whose own causes the current question does not extend to. The node
 * is still offered to `select`; what lies beneath it is out of scope.
 */
type OpaqueFailure = (error: object) => boolean;

/**
 * A content failure ends documentation discovery.
 *
 * A `ContentError` reached in a cause graph is recovered context rather than a
 * failure still looking for a policy: it was delivered to a component that
 * caught it and chose a failure of its own, and that choice is what the document
 * has to report. Walking through it would resurrect the decision the component
 * replaced — the component's contextual diagnostic would be built and then
 * discarded in favour of the child's.
 *
 * Durability discovery looks straight through it. Only the engine's own
 * projection failures are known to carry a documentation failure and nothing
 * else; this class is public, so an author constructs and subclasses it and may
 * put anything underneath — and a durability failure stays fatal however it is
 * wrapped (§6.11). Recovery decides which failure the document *reports*, and a
 * durability failure is not one of the things a document reports.
 */
function isRecoveredContent(error: object): boolean {
  return error instanceof ContentError;
}

/**
 * The first failure in this one's cause graph that `select` recognises, skipping
 * whatever `opaque` declares out of scope.
 *
 * Cause graphs are arbitrary — nothing stops `error.cause` from pointing back
 * at `error` — so traversal remembers what it has seen. Recursing forever would
 * turn an ordinary diagnostic into a stack overflow, which is exactly the
 * failure this traversal exists to prevent. Every question asked of a failure
 * shares the traversal, so no two can drift on what counts as a wrapper; each
 * names its own reach, so a rule that belongs to one question cannot silence the
 * other.
 */
function firstCause<T>(
  error: unknown,
  select: (candidate: unknown) => T | undefined,
  opaque?: OpaqueFailure,
): T | undefined {
  return walkCauses(error, select, opaque, new Set());
}

function walkCauses<T>(
  error: unknown,
  select: (candidate: unknown) => T | undefined,
  opaque: OpaqueFailure | undefined,
  seen: Set<unknown>,
): T | undefined {
  const selected = select(error);
  if (selected !== undefined) {
    return selected;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return undefined;
  }
  if (opaque !== undefined && opaque(error)) {
    return undefined;
  }
  seen.add(error);
  for (const cause of causesOf(error)) {
    const found = walkCauses(cause, select, opaque, seen);
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
