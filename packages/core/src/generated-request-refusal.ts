/**
 * Which failures are core refusing the generated request itself.
 *
 * A fact, not a permission. Core states that a fragment's own *text* was
 * refused — a construct it may not write, a form it wrote wrongly, a name that
 * is not available here, an ordinary captured read reporting `Err`. It states
 * nothing about what a caller should do next. A host driving a loop decides
 * that; packaged `<Plan>` is the one that does, and it is the only place that
 * turns this fact into another Agent turn.
 *
 * The distinction matters because the two things have different owners. Whether
 * the request was refused is knowable only where the failure is raised, and only
 * core is there. Whether a refused request earns another turn is a workflow's
 * policy, and core has no business holding an opinion about it.
 *
 * Public `<Evaluate>` throws on every failure, and that does not change here.
 *
 * ## Why a tag rather than a class
 *
 * `GeneratedXmdError` is raised for both a refused construct and a retained
 * admission whose ceilings moved — the same class, opposite meanings — so
 * reading it by `instanceof` would call stale history and a revoked profile a
 * refusal of the request. Matching the message is worse: the sentences are fixed
 * precisely so nothing reads them.
 *
 * So the mark is applied per *throw site*, by the code that knows which kind of
 * failure it is raising, and read back structurally. An unmarked failure is not
 * a refused request, which is the safe default: a new failure added anywhere in
 * core says nothing about the request until someone decides it does.
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
 *
 * ## What it is not
 *
 * It is not how a *durable* refusal travels. A failure crossing a durable
 * boundary is rebuilt without its class and without any non-enumerable property,
 * so a refusal that has to survive replay is retained as a value the record
 * distinguishes and re-raised — marked again — when that value is read back.
 * `components/Syntax.ts` is the one place that needs this today.
 */

/**
 * The mark itself.
 *
 * Stable and namespaced, because it is read across loaded copies. Changing this
 * string is changing a cross-copy contract.
 */
const REQUEST_REFUSAL = "executablemd.core.generatedRequestRefusal";

/**
 * State that this failure is core refusing the generated request, and answer
 * with it.
 *
 * Returns the error so a throw site reads as one expression. Marking twice is
 * harmless and keeps the first reason: the innermost site is the one that knows
 * what actually went wrong.
 */
export function markGeneratedRequestRefusal<E extends Error>(error: E, reason: string): E {
  if (Object.getOwnPropertyDescriptor(error, REQUEST_REFUSAL) === undefined) {
    Object.defineProperty(error, REQUEST_REFUSAL, { value: reason, enumerable: false });
  }
  return error;
}

/**
 * The safe reason this failure carries, when it is core refusing the request.
 *
 * Answers `undefined` for everything else, including an unmarked
 * `GeneratedXmdError`. Reads the own property rather than walking the prototype
 * chain, so an object that merely inherits the name from something it was
 * created with is not a marked failure.
 */
export function generatedRequestRefusal(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const held = Object.getOwnPropertyDescriptor(error, REQUEST_REFUSAL)?.value;
  return typeof held === "string" && held.length > 0 ? held : undefined;
}
