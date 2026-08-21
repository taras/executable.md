/**
 * What an Issue refuses with, and who is allowed to say it.
 *
 * Two vocabularies live here, and they belong to different sides.
 *
 * The **local refusals** are the document's own: content around an element that
 * takes none, a missing tracker, a URL that is not a credential-free container,
 * a discriminator that is not a provider name. Each is decided before the
 * boundary exists in the story, and each names the remedy.
 *
 * The **provider refusals** are the closed words a provider ends a request
 * with. A provider owns reconciliation, so it owns the vocabulary for what
 * reconciliation found — but not the freedom to say it in its own text. A
 * tracker answers in whatever prose it likes, and a document that could read it
 * would be reading through the boundary at the one moment the boundary exists
 * for. So a provider raises one of these, carrying no message of its own, no
 * payload, no endpoint and no credential.
 */

/** The tracker already holds state this request cannot be reconciled with. */
export class IssueConflictError extends Error {
  override name = "IssueConflictError";

  constructor() {
    super(
      "the issue tracker already holds state this request conflicts with. Nothing was " +
        "created: conflicting external state is diagnosed rather than overwritten or " +
        "duplicated.",
    );
  }
}

/** Whether the issue already exists cannot be decided, and never will be. */
export class IssueAmbiguousError extends Error {
  override name = "IssueAmbiguousError";

  constructor() {
    super(
      "the issue tracker cannot prove whether this issue already exists. Nothing was " +
        "created: a request whose completion is permanently undecidable is never duplicated.",
    );
  }
}

/** The tracker could not be reached or could not answer for now. */
export class IssueUnavailableError extends Error {
  override name = "IssueUnavailableError";

  constructor() {
    super(
      "the issue tracker is temporarily unavailable, so this request's state is unknown. " +
        "Nothing was created on this answer, and nothing was retried: an explicit retry " +
        "observes again before it may create.",
    );
  }
}

/** What crossed the boundary is not something it will retain. */
export class IssueProtocolError extends Error {
  override name = "IssueProtocolError";

  constructor(condition: string) {
    super(
      `${condition}. The answer is refused rather than retained: a value this boundary ` +
        "cannot read is not an outcome, and its content is withheld.",
    );
  }
}

/**
 * The document wrote something around the element that it does not take.
 *
 * Refused before the tracker is read, before the boundary is reached and before
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

/**
 * A word from the fixed vocabulary a destination refusal speaks.
 *
 * Every one is decided locally, before the boundary exists in the story, and
 * each names the remedy: what a document can fix, it is told how to fix.
 */
export type IssueTrackerReason = "no-issue-tracker" | "invalid-tracker-url" | "invalid-provider";

export class IssueTrackerError extends Error {
  override name = "IssueTrackerError";

  readonly reason: IssueTrackerReason;

  constructor(reason: IssueTrackerReason, sentence: string) {
    super(`<Issue> has no destination it can use: ${sentence}`);
    this.reason = reason;
  }
}
