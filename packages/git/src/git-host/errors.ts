/**
 * The refusal vocabulary an external Git-host effect speaks.
 *
 * Five conditions, five fixed words, and nothing else travels with any of them.
 * A provider's message, payload, URL, credential and cause stay inside the
 * provider: a Git host answers in whatever text it likes, and a document that
 * could read it would be reading through the contextual boundary at the one
 * moment the boundary exists for.
 *
 * Each failure is reconstructed locally rather than recognized. A durable
 * failure is journaled as a name and a message and comes back out of the
 * journal as a plain `Error` carrying that name, so `instanceof` would answer
 * "no" for the run's own recorded conflict — and would answer it again for a
 * conflict raised by a second loaded copy of this package. What identifies the
 * condition is the closed name, and {@link gitHostFailure} is where a name
 * becomes the class again.
 *
 * Nothing here is fatal. A conflict, an ambiguity and an unavailability are
 * ordinary failures of the operation they are part of; whether the document
 * retries, suspends or prints one is decided by the structure it is written in.
 */

/** The Git host holds state this effect cannot be reconciled with. */
export class GitHostConflictError extends Error {
  override name = "GitHostConflictError";

  constructor() {
    super(
      "the Git host already holds state this effect conflicts with. Nothing was performed: " +
        "conflicting external state is diagnosed rather than overwritten or duplicated.",
    );
  }
}

/** Whether the effect already happened cannot be decided, and never will be. */
export class GitHostAmbiguousError extends Error {
  override name = "GitHostAmbiguousError";

  constructor() {
    super(
      "the Git host cannot prove whether this effect already happened. Nothing was performed: " +
        "an effect whose completion is permanently undecidable is never duplicated.",
    );
  }
}

/** The Git host could not be reached or could not answer for now. */
export class GitHostUnavailableError extends Error {
  override name = "GitHostUnavailableError";

  constructor() {
    super(
      "the Git host is temporarily unavailable, so this effect's state is unknown. Nothing was " +
        "performed on this answer, and nothing was retried: an explicit retry or suspension " +
        "observes again before it may perform.",
    );
  }
}

/**
 * The boundary failed, so the Git host never answered.
 *
 * No provider installed, a request this invocation did not mint, an invocation
 * already spent, an effect kind this host does not implement, or anything at
 * all raised before an answer was accepted. The condition is named; what was
 * raised is not, because at this boundary it came from replaceable code and
 * would otherwise travel into logs and output.
 *
 * A provider also answers with this class — and nothing else about it — to
 * refuse an effect kind it does not support. The instance it supplies is
 * discarded; what travels on is built here.
 */
export class GitHostProviderError extends Error {
  override name = "GitHostProviderError";

  constructor(condition: string) {
    super(`${condition}. This external effect executed and published nothing.`);
  }
}

/** The provider answered with something that is not a closed Git-host answer. */
export class GitHostProtocolError extends Error {
  override name = "GitHostProtocolError";

  constructor(condition: string) {
    super(
      `${condition}. The answer is refused rather than journaled: a value this boundary ` +
        "cannot read is not an outcome, and its content is withheld.",
    );
  }
}

const CLOSED_FAILURES: Readonly<Record<string, () => Error>> = Object.freeze({
  GitHostConflictError: () => new GitHostConflictError(),
  GitHostAmbiguousError: () => new GitHostAmbiguousError(),
  GitHostUnavailableError: () => new GitHostUnavailableError(),
});

/**
 * The same failure, rebuilt here, when this is one of the closed conditions.
 *
 * Everything else is handed back untouched. A durability failure, a stale-input
 * refusal and Effection's own control flow are not Git-host outcomes, and
 * turning one of them into a Git-host word would report a cancelled attempt as
 * a host that was merely unavailable.
 */
export function gitHostFailure(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const rebuild = Object.hasOwn(CLOSED_FAILURES, error.name)
    ? CLOSED_FAILURES[error.name]
    : undefined;
  return rebuild === undefined ? error : rebuild();
}

/**
 * Whether a provider's own failure answer says "not right now".
 *
 * Read from the closed name, because the value came from a provider that may be
 * another loaded copy. It selects a word; the instance is discarded.
 */
export function isGitHostUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === "GitHostUnavailableError";
}

/** Whether a provider's own failure answer says "not this effect kind". */
export function isGitHostUnsupportedKind(error: unknown): boolean {
  return error instanceof Error && error.name === "GitHostProviderError";
}
