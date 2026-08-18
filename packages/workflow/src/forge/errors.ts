/**
 * The refusal vocabulary an external forge effect speaks.
 *
 * Five conditions, five fixed words, and nothing else travels with any of them.
 * A provider's message, payload, URL, credential and cause stay inside the
 * provider: an external forge answers in whatever text it likes, and a document
 * that could read it would be reading through the contextual boundary at the
 * one moment the boundary exists for.
 *
 * Each failure is reconstructed locally rather than recognized. A durable
 * failure is journaled as a name and a message and comes back out of the
 * journal as a plain `Error` carrying that name, so `instanceof` would answer
 * "no" for the run's own recorded conflict — and would answer it again for a
 * conflict raised by a second loaded copy of this package. What identifies the
 * condition is the closed name, and {@link forgeFailure} is where a name
 * becomes the class again.
 *
 * Nothing here is fatal. A conflict, an ambiguity and an unavailability are
 * ordinary failures of the operation they are part of; whether the document
 * retries, suspends or prints one is decided by the structure it is written in.
 */

/** The forge holds state this effect cannot be reconciled with. */
export class ForgeConflictError extends Error {
  override name = "ForgeConflictError";

  constructor() {
    super(
      "the forge already holds state this effect conflicts with. Nothing was performed: " +
        "conflicting external state is diagnosed rather than overwritten or duplicated.",
    );
  }
}

/** Whether the effect already happened cannot be decided, and never will be. */
export class ForgeAmbiguousError extends Error {
  override name = "ForgeAmbiguousError";

  constructor() {
    super(
      "the forge cannot prove whether this effect already happened. Nothing was performed: " +
        "an effect whose completion is permanently undecidable is never duplicated.",
    );
  }
}

/** The forge could not be reached or could not answer for now. */
export class ForgeUnavailableError extends Error {
  override name = "ForgeUnavailableError";

  constructor() {
    super(
      "the forge is temporarily unavailable, so this effect's state is unknown. Nothing was " +
        "performed on this answer, and nothing was retried: an explicit retry or suspension " +
        "observes again before it may perform.",
    );
  }
}

/**
 * The boundary failed, so the forge never answered.
 *
 * No provider installed, a selection this scope did not mint, an invocation
 * already spent, or anything at all raised before an answer was accepted. The
 * condition is named; what was raised is not, because at this boundary it came
 * from replaceable code and would otherwise travel into logs and output.
 */
export class ForgeProviderError extends Error {
  override name = "ForgeProviderError";

  constructor(condition: string) {
    super(`${condition}. This external effect executed and published nothing.`);
  }
}

/** The provider answered with something that is not a closed forge answer. */
export class ForgeProtocolError extends Error {
  override name = "ForgeProtocolError";

  constructor(condition: string) {
    super(
      `${condition}. The answer is refused rather than journaled: a value this boundary ` +
        "cannot read is not an outcome, and its content is withheld.",
    );
  }
}

const CLOSED_FAILURES: Readonly<Record<string, () => Error>> = Object.freeze({
  ForgeConflictError: () => new ForgeConflictError(),
  ForgeAmbiguousError: () => new ForgeAmbiguousError(),
  ForgeUnavailableError: () => new ForgeUnavailableError(),
});

/**
 * The same failure, rebuilt here, when this is one of the closed conditions.
 *
 * Everything else is handed back untouched. A durability failure, a stale-input
 * refusal and Effection's own control flow are not forge outcomes, and turning
 * one of them into a forge word would report a cancelled attempt as a provider
 * that was merely unavailable.
 */
export function forgeFailure(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const rebuild = Object.hasOwn(CLOSED_FAILURES, error.name)
    ? CLOSED_FAILURES[error.name]
    : undefined;
  return rebuild === undefined ? error : rebuild();
}

/** Whether this error is the closed temporary-unavailability condition. */
export function isForgeUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === "ForgeUnavailableError";
}
