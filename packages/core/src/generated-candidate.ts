/**
 * Which generated failures a trusted caller may offer the candidate another
 * chance at.
 *
 * Public `<Evaluate>` throws on every failure, and that does not change here. A
 * host driving a loop — packaged `<Plan>` is the one that does — needs to tell
 * two things apart: a fragment whose *text* was wrong, which the candidate that
 * wrote it can correct, and everything else, which is this run's problem and
 * ends it.
 *
 * ## Why a tag rather than a class
 *
 * `GeneratedXmdError` is raised for both. A refused construct and a retained
 * admission whose ceilings moved are the same class and opposite decisions, so
 * recovering by `instanceof` would recover stale history and a revoked profile
 * along with a typo. Matching the message is worse: the sentences are fixed
 * precisely so nothing reads them.
 *
 * So the mark is applied per *throw site*, by the code that knows which kind of
 * failure it is raising, and read back structurally. A failure nobody marked is
 * terminal, which is the safe default: a new failure added anywhere in core is
 * not recoverable until someone decides it is.
 *
 * ## Why a namespaced string property
 *
 * The same reason `printsErrors` uses one. A separately loaded copy of this
 * package has its own classes and its own symbols, so neither survives the
 * boundary; a namespaced own-property does. It is non-enumerable, so an error
 * that is copied, wrapped or serialized does not carry the mark along by
 * accident — a wrapper that means to pass the classification on marks its own.
 *
 * ## What travels
 *
 * The reason only, already normalized where it was raised. A generated failure's
 * diagnostic is untrusted text and may name a path, a URL or a header the
 * candidate wrote; the fixed sentences core raises are safe by construction, and
 * this carries one of those rather than an arbitrary message.
 */

/**
 * The mark itself.
 *
 * Stable and namespaced, because it is read across loaded copies. Changing this
 * string is changing a cross-copy contract.
 */
const CANDIDATE_REASON = "executablemd.core.generatedCandidateReason";

/**
 * Mark this failure as one the generated candidate can correct, and answer with
 * it.
 *
 * Returns the error so a throw site reads as one expression. Marking twice is
 * harmless and keeps the first reason: the innermost site is the one that knows
 * what actually went wrong.
 */
export function markGeneratedCandidate<E extends Error>(error: E, reason: string): E {
  if (Object.getOwnPropertyDescriptor(error, CANDIDATE_REASON) === undefined) {
    Object.defineProperty(error, CANDIDATE_REASON, { value: reason, enumerable: false });
  }
  return error;
}

/**
 * The safe reason this failure carries, when it is one a candidate may retry.
 *
 * Answers `undefined` for everything else, including an unmarked
 * `GeneratedXmdError`. Reads the own property rather than walking the prototype
 * chain, so an object that merely inherits the name from something it was
 * created with is not a marked failure.
 */
export function generatedCandidateReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const held = Object.getOwnPropertyDescriptor(error, CANDIDATE_REASON)?.value;
  return typeof held === "string" && held.length > 0 ? held : undefined;
}
