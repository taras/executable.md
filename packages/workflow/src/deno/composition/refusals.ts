/**
 * The fixed vocabulary a composition refusal is reported in.
 *
 * A refusal is something the document asked for and did not get. What travels
 * back is a word from a closed set and a sentence this package owns — never a
 * Git message, a locator or a host path. The same word has to survive a round
 * trip through the journal, so a refusal is carried as the failure's *name* and
 * rebuilt from it: a live refusal and a replayed one are the same sentence,
 * assembled by the same route from the same bytes.
 */
import {
  GitOperationError,
  GitOperationInfrastructureError,
  RepositoryCompositionError,
  WorktreeCompositionError,
  type GitFailureReason,
  type RepositoryFailureReason,
  type WorktreeFailureReason,
} from "../../composition/errors.ts";
import { JournaledEffectFailure } from "../workspace/errors.ts";

const REPOSITORY_REASONS: ReadonlyMap<string, RepositoryFailureReason> = new Map([
  ["invalid-locator", "invalid-locator"],
  ["unresolved-base", "unresolved-base"],
  ["missing-remote-default", "missing-remote-default"],
  ["incompatible-reuse", "incompatible-reuse"],
  ["unusable-repository", "unusable-repository"],
] as const);

const WORKTREE_REASONS: ReadonlyMap<string, WorktreeFailureReason> = new Map([
  ["unresolved-base", "unresolved-base"],
  ["branch-checked-out-elsewhere", "branch-checked-out-elsewhere"],
  ["incompatible-reuse", "incompatible-reuse"],
  ["unusable-repository", "unusable-repository"],
] as const);

/**
 * The words a Git operation may be refused under, once it has begun.
 *
 * `no-repository-context` and `invalid-invocation` are deliberately absent: both
 * are decided by the component before any effect exists, so neither can arrive
 * back through the journal.
 */
const GIT_REASONS: ReadonlyMap<string, GitFailureReason> = new Map([
  ["invalid-branch", "invalid-branch"],
  ["unresolved-base", "unresolved-base"],
  ["branch-checked-out-elsewhere", "branch-checked-out-elsewhere"],
  ["overwrites-local-changes", "overwrites-local-changes"],
] as const);

const GIT_SENTENCES: ReadonlyMap<GitFailureReason, string> = new Map([
  ["invalid-invocation", "it is not written the way that component is written."],
  ["invalid-branch", "the branch it names cannot be used as one."],
  ["unresolved-base", "its base does not name a commit in that repository."],
  [
    "branch-checked-out-elsewhere",
    "that branch is already checked out by another checkout of the same repository. Nothing " +
      "was moved, reset or detached to make room for it.",
  ],
  [
    "overwrites-local-changes",
    "changes in the checkout would be overwritten by it. Nothing was discarded, stashed or " +
      "forced to make it apply.",
  ],
]);

const REPOSITORY_SENTENCES: ReadonlyMap<RepositoryFailureReason, string> = new Map([
  [
    "invalid-locator",
    "its url could not be used as a Git locator, or the repository it names could not be read.",
  ],
  ["unresolved-base", "its base does not name a commit in that repository."],
  ["missing-remote-default", "the repository has no default branch to start from."],
  [
    "incompatible-reuse",
    "that name is already this run's, for a different url or base. A name is durable identity; " +
      "use another name rather than pointing this one somewhere else.",
  ],
  ["unusable-repository", "the repository Git produced is not one this run can retain."],
]);

const WORKTREE_SENTENCES: ReadonlyMap<WorktreeFailureReason, string> = new Map([
  ["no-repository-context", "there is no enclosing <Repository>."],
  ["unresolved-base", "its base does not name a commit in the enclosing repository."],
  [
    "branch-checked-out-elsewhere",
    "that branch is already checked out by another worktree. Nothing was moved, reset or " +
      "detached to make room for this one.",
  ],
  [
    "incompatible-reuse",
    "that name is already this repository's, for a different branch or base. A name is durable " +
      "identity; use another name rather than pointing this one at another branch.",
  ],
  ["unusable-repository", "the worktree Git produced is not one this run can retain."],
]);

export function repositoryRefusal(name: string, reason: string): RepositoryCompositionError {
  const word = REPOSITORY_REASONS.get(reason) ?? "unusable-repository";
  return new RepositoryCompositionError(
    name,
    word,
    `<Repository name=${JSON.stringify(name)}> could not be prepared: ` +
      `${REPOSITORY_SENTENCES.get(word)}`,
  );
}

/**
 * A Git refusal, named by the component a document wrote rather than by a
 * repository or a worktree.
 *
 * `operation` plays the part `name` plays for the other two: it is what the
 * sentence is built around, and what a replayed refusal is rebuilt with — so a
 * live refusal and a replayed one are the same sentence for the same element.
 */
export function gitRefusal(operation: string, reason: GitFailureReason): GitOperationError {
  return new GitOperationError(
    operation,
    reason,
    `${operation} could not run: ${GIT_SENTENCES.get(reason)}`,
  );
}

/**
 * The refusal a retained failure name describes, or `undefined` for none.
 *
 * A word outside the closed set is not a refusal this build may rebuild. It is a
 * retained result that says something this version cannot read, and the caller
 * treats it as one rather than receiving a plausible refusal assembled from a
 * word nobody wrote.
 */
export function restoredGitRefusal(operation: string, word: string): GitOperationError | undefined {
  const reason = GIT_REASONS.get(word);
  return reason === undefined ? undefined : gitRefusal(operation, reason);
}

export function worktreeRefusal(name: string, reason: string): WorktreeCompositionError {
  const word = WORKTREE_REASONS.get(reason) ?? "unusable-repository";
  return new WorktreeCompositionError(
    name,
    word,
    `<Worktree name=${JSON.stringify(name)}> could not be prepared: ` +
      `${WORKTREE_SENTENCES.get(word)}`,
  );
}

/**
 * A refusal, in the only form the journal can carry it.
 *
 * `serializeError` retains a name, a message and a stack, and drops everything
 * else — so a word this provider must still have after a replay cannot live in a
 * field of its own. It lives in the name: `RepositoryCompositionRefusal:
 * unresolved-base` is a name and a vocabulary word, and reading it back is
 * splitting a string rather than interpreting a sentence somebody may later
 * reword.
 *
 * The message is the fixed component-owned diagnostic, so what the journal holds
 * is already sanitized. Nothing Git printed and no locator reaches it.
 *
 * Live and replay produce the same value by the same route: a live result is
 * serialized and deserialized on its way out of the effect exactly as a restored
 * one is, so both arrive as a plain `Error` carrying this name.
 */
export class CompositionRefusal extends JournaledEffectFailure {
  override name: string;

  constructor(kind: RefusalKind, reason: string, sentence: string) {
    super(sentence);
    this.name = `${REFUSAL_NAMES[kind]}:${reason}`;
  }
}

const REFUSAL_NAMES = {
  repository: "RepositoryCompositionRefusal",
  worktree: "WorktreeCompositionRefusal",
  git: "GitOperationRefusal",
} as const;

/** Which vocabulary a refusal is read and written in. */
export type RefusalKind = keyof typeof REFUSAL_NAMES;

/** The vocabulary word this restored failure refuses under, if it is a refusal. */
export function refusalReason(error: unknown, kind: RefusalKind): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const prefix = `${REFUSAL_NAMES[kind]}:`;
  return error.name.startsWith(prefix) ? error.name.slice(prefix.length) : undefined;
}

export function repositoryRefused(name: string, reason: string): never {
  throw new CompositionRefusal("repository", reason, repositoryRefusal(name, reason).message);
}

export function worktreeRefused(name: string, reason: string): never {
  throw new CompositionRefusal("worktree", reason, worktreeRefusal(name, reason).message);
}

/**
 * Refuse a Git operation under one word from the closed set.
 *
 * A word outside it is not refused under the nearest one: an unrecognized
 * condition is infrastructure, and publishing it as a refusal would put an
 * outcome this run cannot describe into its own history.
 */
export function gitRefused(operation: string, word: string): never {
  const refusal = restoredGitRefusal(operation, word);
  if (refusal === undefined) {
    throw new GitOperationInfrastructureError(
      operation,
      "native Git reported a condition this provider has no word for",
    );
  }
  throw new CompositionRefusal("git", word, refusal.message);
}
