/**
 * The refusal vocabulary an external Issue effect speaks.
 *
 * The same closed-set discipline §10.2 uses, for the same reason: a provider's
 * message, payload, URL, credential and cause stay inside the provider, because
 * an issue tracker answers in whatever text it likes and a document that could
 * read it would be reading through the contextual boundary at the one moment
 * the boundary exists for.
 *
 * Each failure is reconstructed locally rather than recognized. A durable
 * failure is journaled as a name and a message and comes back out of the
 * journal as a plain `Error` carrying that name, so `instanceof` would answer
 * "no" for the run's own recorded conflict — and would answer it again for a
 * conflict raised by a second loaded copy of this package. What identifies the
 * condition is the closed name, and {@link issueFailure} is where a name
 * becomes the class again.
 */

/** The Issue provider holds state this effect cannot be reconciled with. */
export class IssueConflictError extends Error {
  override name = "IssueConflictError";

  constructor() {
    super(
      "the issue provider already holds state this effect conflicts with. Nothing was " +
        "performed: conflicting external state is diagnosed rather than overwritten or " +
        "duplicated.",
    );
  }
}

/** Whether the effect already happened cannot be decided, and never will be. */
export class IssueAmbiguousError extends Error {
  override name = "IssueAmbiguousError";

  constructor() {
    super(
      "the issue provider cannot prove whether this effect already happened. Nothing was " +
        "performed: an effect whose completion is permanently undecidable is never duplicated.",
    );
  }
}

/** The Issue provider could not be reached or could not answer for now. */
export class IssueUnavailableError extends Error {
  override name = "IssueUnavailableError";

  constructor() {
    super(
      "the issue provider is temporarily unavailable, so this effect's state is unknown. " +
        "Nothing was performed on this answer, and nothing was retried: an explicit retry or " +
        "suspension observes again before it may perform.",
    );
  }
}

/**
 * The boundary failed, so no Issue provider answered.
 *
 * No provider registered for the resolved discriminator, a request this
 * invocation did not mint, an invocation already spent, a target outside the
 * host's ceiling, or anything at all raised before an answer was accepted. The
 * condition is named; what was raised is not, because at this boundary it came
 * from replaceable code and would otherwise travel into logs and output.
 */
export class IssueProviderError extends Error {
  override name = "IssueProviderError";

  constructor(condition: string) {
    super(`${condition}. This external effect executed and published nothing.`);
  }
}

/** The provider answered with something that is not a closed Issue answer. */
export class IssueProtocolError extends Error {
  override name = "IssueProtocolError";

  constructor(condition: string) {
    super(
      `${condition}. The answer is refused rather than journaled: a value this boundary ` +
        "cannot read is not an outcome, and its content is withheld.",
    );
  }
}

/**
 * The document asked for a destination this run cannot resolve or reach.
 *
 * A missing context, a URL that is not a credential-free container, a URL no
 * built-in mapping names a provider for, and a provider name that is not one.
 * Every one of them is decided locally, before routing exists in the story, and
 * each names the remedy: what a document can fix, it is told how to fix.
 */
export type IssueTrackerReason =
  | "no-issue-tracker"
  | "invalid-tracker-url"
  | "unresolved-provider"
  | "invalid-provider";

/**
 * The document wrote something around the element that it does not take.
 *
 * Refused before the destination is resolved, before routing exists and before
 * any provider is asked anything — because content a component never renders is
 * content nobody would see was discarded, and an issue created beside silently
 * dropped text is worse than one not created at all.
 */
export class IssueContentError extends Error {
  override name = "IssueContentError";

  constructor(sentence: string) {
    super(sentence);
  }
}

export class IssueTrackerError extends Error {
  override name = "IssueTrackerError";

  readonly reason: IssueTrackerReason;

  constructor(reason: IssueTrackerReason, sentence: string) {
    super(`<Issue> has no destination it can use: ${sentence}`);
    this.reason = reason;
  }
}

const CLOSED_FAILURES: Readonly<Record<string, () => Error>> = Object.freeze({
  IssueConflictError: () => new IssueConflictError(),
  IssueAmbiguousError: () => new IssueAmbiguousError(),
  IssueUnavailableError: () => new IssueUnavailableError(),
});

/**
 * The same failure, rebuilt here, when this is one of the closed conditions.
 *
 * Everything else is handed back untouched. A durability failure, a stale-input
 * refusal and Effection's own control flow are not Issue outcomes, and turning
 * one of them into an Issue word would report a cancelled attempt as a provider
 * that was merely unavailable.
 */
export function issueFailure(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const rebuild = Object.hasOwn(CLOSED_FAILURES, error.name)
    ? CLOSED_FAILURES[error.name]
    : undefined;
  return rebuild === undefined ? error : rebuild();
}

/** Whether a provider's own failure answer says "not right now". */
export function isIssueUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === "IssueUnavailableError";
}

/** Whether a provider's own failure answer says "not this target". */
export function isIssueRefused(error: unknown): boolean {
  return error instanceof Error && error.name === "IssueProviderError";
}
