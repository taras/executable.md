/**
 * Contextual error policy for expansion (spec §6.9).
 *
 * Inside a rendered region — an `<Output>` region, or anywhere when no
 * `<Output>` is declared — an ErrorSegment renders as an HTML comment
 * ("collect"). While executing suppressed documentation, the first
 * ErrorSegment produced throws immediately ("throw") so it propagates to be
 * handled above.
 */

import { createContext } from "effection";
import type { Operation } from "effection";
import type { ErrorSegment, Segment } from "./types.ts";

export type ErrorPolicy = "collect" | "throw";

/**
 * Effection context holding the ambient error policy. Unset defaults to
 * "collect" — today's behavior where ErrorSegments render as comments.
 */
export const ErrorPolicyCtx = createContext<ErrorPolicy>("errorPolicy");

/**
 * Thrown when an ErrorSegment is produced or transported into a suppressed
 * documentation region. Carries the offending segment so callers above can
 * inspect it.
 */
export class DocumentationError extends Error {
  readonly segment: ErrorSegment;

  constructor(segment: ErrorSegment) {
    super(segment.message);
    this.name = "DocumentationError";
    this.segment = segment;
  }
}

/** Read the ambient error policy, defaulting to "collect" when unset. */
export function* currentErrorPolicy(): Operation<ErrorPolicy> {
  const policy = yield* ErrorPolicyCtx.get();
  return policy ?? "collect";
}

/**
 * Route an ErrorSegment through the ambient policy. Under "throw" it raises a
 * DocumentationError (fail-fast); under "collect" it returns the segment so
 * the caller renders it as a comment.
 */
export function* raise(segment: ErrorSegment): Operation<Segment[]> {
  const policy = yield* currentErrorPolicy();
  if (policy === "throw") {
    throw new DocumentationError(segment);
  }
  return [segment];
}
