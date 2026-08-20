/**
 * The refusal vocabulary Repository/Worktree composition speaks.
 *
 * A composition failure travels back with a fixed word rather than a raw Git
 * message or a host path. Native Git is one provider; another might refuse the
 * same authored input for the same reason and describe it differently, and a
 * document must not see through to which one is installed. Nothing here quotes
 * a locator or a stderr line: what arrives from a subprocess selects a word
 * from a closed set and is then discarded.
 *
 * Two kinds of failure live here and they are not interchangeable. An ordinary
 * refusal is something the document asked for and did not get — a locator that
 * cannot be admitted, a base that resolves to nothing, a branch already checked
 * out somewhere else. Describing it is this package's job; deciding what the
 * document does about it is not. It fails the operation it is part of like any
 * other Effection work, and an authored `<PrintErrors>` region is what says
 * otherwise — for everything inside that region rather than for these
 * components alone.
 *
 * A stale-state failure is the retained authoritative state disagreeing with
 * what attachment found. That is not something the document did, and not
 * something an authored region may decide either.
 */

import { StaleInputError } from "@executablemd/durable-streams";
import { WorkflowStorageError } from "../storage/errors.ts";

/** A word from the fixed vocabulary a Repository refusal is reported under. */
export type RepositoryFailureReason =
  | "invalid-locator"
  | "unresolved-base"
  | "missing-remote-default"
  | "incompatible-reuse"
  | "unusable-repository";

/** A word from the fixed vocabulary a Worktree refusal is reported under. */
export type WorktreeFailureReason =
  | "no-repository-context"
  | "unresolved-base"
  | "branch-checked-out-elsewhere"
  | "incompatible-reuse"
  | "unusable-repository";

/** A Repository the document asked for and did not get. */
export class RepositoryCompositionError extends Error {
  override name = "RepositoryCompositionError";

  readonly repositoryName: string;
  readonly reason: RepositoryFailureReason;

  constructor(repositoryName: string, reason: RepositoryFailureReason, sentence: string) {
    super(sentence);
    this.repositoryName = repositoryName;
    this.reason = reason;
  }
}

/** A Worktree the document asked for and did not get. */
export class WorktreeCompositionError extends Error {
  override name = "WorktreeCompositionError";

  readonly worktreeName: string;
  readonly reason: WorktreeFailureReason;

  constructor(worktreeName: string, reason: WorktreeFailureReason, sentence: string) {
    super(sentence);
    this.worktreeName = worktreeName;
    this.reason = reason;
  }
}

/**
 * Retained authoritative state disagrees with what attachment found.
 *
 * A `StaleInputError`, which is what makes it fatal rather than printable: the
 * journal says this run has a checkout on a commit, and the Workspace root the
 * journal selected does not hold one. Children and later siblings must not
 * begin, because every one of them would run against state the run's own
 * history does not describe — and an enclosing `<PrintErrors>` must not be able
 * to downgrade that to a comment.
 *
 * Nothing here repairs anything. Recloning would replace authoritative retained
 * state with whatever the current remote happens to hold, which is a different
 * run wearing this run's identity.
 */
export class RepositoryStaleStateError extends StaleInputError {
  override name = "RepositoryStaleStateError";

  readonly subject: string;

  constructor(subject: string, reason: string) {
    super(
      `the retained Git state for ${subject} is not what this run recorded: ${reason}. ` +
        "The run is left exactly as it was found; nothing is recloned or repaired, and no " +
        "later work runs against state this run's history does not describe.",
    );
    this.subject = subject;
  }
}

/** No Repository composition provider is installed in this scope. */
export class RepositoryCompositionProviderError extends WorkflowStorageError {
  override name = "RepositoryCompositionProviderError";

  constructor(operation: string) {
    super(
      `no Repository composition provider is installed, so ${operation} cannot answer. A ` +
        "workflow host installs one for a live or partial execution.",
    );
  }
}

/** The provider answered with something that is not a record. */
export class RepositoryCompositionProtocolError extends WorkflowStorageError {
  override name = "RepositoryCompositionProtocolError";

  constructor(operation: string) {
    super(
      `the Repository composition provider answered ${operation} with a value that is not a ` +
        "creation record.",
    );
  }
}

/**
 * A word from the fixed vocabulary a Git operation's refusal is reported under.
 *
 * The same closed-set discipline the two composition components speak. A
 * document learns that its base named no commit, or that the branch it asked for
 * is checked out somewhere else — never which Git version said so, and never
 * what it printed.
 */
export type GitFailureReason =
  | "invalid-invocation"
  | "invalid-branch"
  | "unresolved-base"
  | "branch-checked-out-elsewhere"
  | "overwrites-local-changes"
  | "unmatched-pathspec"
  | "ignored-pathspec"
  | "outside-checkout-pathspec"
  | "invalid-pathspec-magic"
  | "empty-index"
  | "unnamed-branch";

/** A Git operation the document asked for and did not get. */
export class GitOperationError extends Error {
  override name = "GitOperationError";

  /** The component that was written, as a document writes it. */
  readonly operation: string;
  readonly reason: GitFailureReason;

  constructor(operation: string, reason: GitFailureReason, sentence: string) {
    super(sentence);
    this.operation = operation;
    this.reason = reason;
  }
}

/**
 * The observation an operation arrived with is not this run's retained state.
 *
 * A Repository record that is not the row this run retains, a working directory
 * inside no checkout it holds, a retained path that has stopped agreeing with
 * the identity naming it — none of these is something a document asked for and
 * did not get. Each is the run's own state disagreeing with what was presented
 * for it, so each fails the run the way a stale-state condition does: children
 * and later siblings do not begin, `<PrintErrors>` cannot print it, and no
 * result is published for an operation that was never authorized to happen.
 *
 * The sentence names the operation and the condition, and nothing else. What a
 * caller presented is not quoted back: a forged record is untrusted input, and
 * an untrusted value belongs in a diagnostic even less than a retained one does.
 */
export class GitOperationAuthorityError extends StaleInputError {
  override name = "GitOperationAuthorityError";

  readonly operation: string;

  constructor(operation: string, reason: string) {
    super(
      `${operation} is not authorized against this run's retained state: ${reason}. The run is ` +
        "left exactly as it was found; no Git ran and no result was recorded for it.",
    );
    this.operation = operation;
  }
}

/**
 * A word from the fixed vocabulary a `<PullRequest>` authority refusal speaks.
 *
 * Every one of them is decided locally, before a Git host is observed. A pull
 * request is a public statement about a branch that exists somewhere else, and
 * the run has to be able to prove it put that branch there before it makes one.
 */
export type PullRequestAuthorityReason =
  | "no-repository-context"
  | "unnamed-branch"
  | "missing-push-evidence"
  | "conflicting-push-evidence"
  | "unreadable-push-evidence";

/**
 * `<PullRequest>` is not authorized by what this run retained.
 *
 * A `StaleInputError`, on the same terms as {@link GitOperationAuthorityError}:
 * a document cannot avoid a Repository context that was replaced or a retained
 * Push result that stopped being readable, and later siblings must not run as
 * though a pull request had been opened. None of these is a Git-host answer —
 * every one of them is decided before anything is observed — so none of them is
 * printable and none of them is journaled as an effect outcome.
 *
 * The sentence names the category and, where there is one, the remedy. It
 * quotes no journal content, no retained record and nothing a caller presented:
 * the evidence this refuses to read is exactly the evidence it must not repeat.
 */
export class PullRequestAuthorityError extends StaleInputError {
  override name = "PullRequestAuthorityError";

  readonly reason: PullRequestAuthorityReason;

  constructor(reason: PullRequestAuthorityReason, sentence: string) {
    super(
      `<PullRequest> is not authorized against this run's retained state: ${sentence} Nothing ` +
        "was observed at the Git host, and no pull request was created.",
    );
    this.reason = reason;
  }
}

/**
 * Native Git failed in a way this provider does not recognize.
 *
 * A refusal is a condition a document can act on, and the set of them is closed.
 * Everything else Git can do — an exit this provider has no word for, a state
 * read that answered nothing, a checkout that did not end where the command said
 * it would — is infrastructure. Publishing one as a failed durable result would
 * put a fabricated Git outcome in the run's history, so it fails the run
 * instead, and the mutation it was part of commits nothing.
 *
 * Nothing Git printed travels with it. The condition is named by what this
 * provider was doing, which is what a reader needs and all it may have.
 */
export class GitOperationInfrastructureError extends WorkflowStorageError {
  override name = "GitOperationInfrastructureError";

  readonly operation: string;

  constructor(operation: string, reason: string) {
    super(
      `${operation} could not be completed: ${reason}. Nothing was committed: the run is ` +
        "exactly what it was before this operation began.",
    );
    this.operation = operation;
  }
}

/** No Git composition provider is installed in this scope. */
export class GitCompositionProviderError extends WorkflowStorageError {
  override name = "GitCompositionProviderError";

  constructor(operation: string) {
    super(
      `no Git composition provider is installed, so ${operation} cannot answer. A workflow ` +
        "host installs one for a live or partial execution.",
    );
  }
}

/** The provider answered with something that is not a Git operation result. */
export class GitOperationProtocolError extends WorkflowStorageError {
  override name = "GitOperationProtocolError";

  constructor(operation: string) {
    super(
      `the Git composition provider answered ${operation} with a value that is not the result ` +
        "that operation retains.",
    );
  }
}
