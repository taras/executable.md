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
  RepositoryCompositionError,
  WorktreeCompositionError,
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

  constructor(kind: "repository" | "worktree", reason: string, sentence: string) {
    super(sentence);
    this.name = `${REFUSAL_NAMES[kind]}:${reason}`;
  }
}

const REFUSAL_NAMES = {
  repository: "RepositoryCompositionRefusal",
  worktree: "WorktreeCompositionRefusal",
} as const;

/** The vocabulary word this restored failure refuses under, if it is a refusal. */
export function refusalReason(error: unknown, kind: "repository" | "worktree"): string | undefined {
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
