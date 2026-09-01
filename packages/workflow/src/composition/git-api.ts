/**
 * The profile-neutral Api a Git component asks for work through.
 *
 * `<Git.Switch>` names no subprocess and reaches no filesystem. It observes two
 * things a document can see — the Repository in scope and the contextual working
 * directory — and asks whoever is installed to do the rest. Neither observation
 * carries authority: a replaced selection can misname a Repository, and the
 * provider's answer is what decides which checkout, if any, those two select.
 *
 * What lifecycle the work has is the installed provider's, not this Api's. A
 * workflow provider runs each of these as one durable Workspace effect, so a
 * completed one restores from the journal and moves no branch. The ordinary
 * `xmd run` provider performs them directly against the selected checkout:
 * there is no transaction to enclose a person's own repository in, and none is
 * claimed.
 *
 * The default handler throws. There is no host-less fallback, because a Git
 * operation that "ran" without a provider would report a branch this run never
 * moved.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { GitCompositionProviderError } from "./errors.ts";
import type { GitAddResult, GitCommitResult, GitSwitchResult } from "./git-records.ts";
import type { GitCommitMessageSource } from "./git-records.ts";
import type { GitPushOutcome } from "./git-push-records.ts";
import type { RepositorySelection } from "./selection.ts";

/**
 * Where a Git operation happens, as the component observed it.
 *
 * The selection is what the operation belongs to; the working directory is
 * where inside it the element was written, and the two are equal only when a
 * document wrote the element at the checkout root.
 */
export interface GitInvocationPlace {
  readonly repository: RepositorySelection;
  /** The contextual working directory the component observed. */
  readonly workingDirectory: string;
}

export interface GitSwitchInvocation extends GitInvocationPlace {
  readonly branch: string;
  readonly base: string | undefined;
}

export interface GitAddInvocation extends GitInvocationPlace {
  readonly paths: readonly string[];
}

export interface GitCommitInvocation extends GitInvocationPlace {
  /** The exact bytes to commit, already canonical. */
  readonly message: string;
  readonly messageSource: GitCommitMessageSource;
}

export type GitPushInvocation = GitInvocationPlace;

export interface GitCompositionApi {
  /** Put the selected checkout on a named branch. */
  switchBranch(invocation: GitSwitchInvocation): Operation<GitSwitchResult>;

  /**
   * Stage exactly the pathspecs this invocation names.
   *
   * One command for the whole array rather than one per entry: Git decides what
   * a pathspec matches, and a per-entry loop would be several transitions where
   * the document wrote one.
   */
  addPaths(invocation: GitAddInvocation): Operation<GitAddResult>;

  /**
   * Record exactly what the index holds.
   *
   * Nothing is staged for it and nothing is amended: the index is the whole of
   * what a commit is made from, and an index that already matches HEAD is
   * refused rather than committed empty.
   */
  commitIndex(invocation: GitCommitInvocation): Operation<GitCommitResult>;

  /**
   * Publish the selected checkout's current branch to its origin.
   *
   * The one operation here whose outcome no local transaction can enclose. It
   * observes the destination before it mutates and performs at most once, so an
   * interrupted attempt that already reached the remote is adopted rather than
   * repeated.
   *
   * Routed through this Api like the other three, and for the same reason: a
   * document names a checkout by writing an element inside one, and what that
   * observation selects is the installed provider's to decide. Observation is
   * all this carries — the provider still authenticates the selection, the
   * directory and the objects it publishes.
   */
  pushCurrentBranch(invocation: GitPushInvocation): Operation<GitPushOutcome>;
}

export const GitComposition: Api<GitCompositionApi> = createApi<GitCompositionApi>(
  "executablemd.workflow.composition.git",
  {
    // deno-lint-ignore require-yield
    *switchBranch(_invocation: GitSwitchInvocation): Operation<GitSwitchResult> {
      throw new GitCompositionProviderError("<Git.Switch>");
    },
    // deno-lint-ignore require-yield
    *addPaths(_invocation: GitAddInvocation): Operation<GitAddResult> {
      throw new GitCompositionProviderError("<Git.Add>");
    },
    // deno-lint-ignore require-yield
    *commitIndex(_invocation: GitCommitInvocation): Operation<GitCommitResult> {
      throw new GitCompositionProviderError("<Git.Commit>");
    },
    // deno-lint-ignore require-yield
    *pushCurrentBranch(_invocation: GitPushInvocation): Operation<GitPushOutcome> {
      throw new GitCompositionProviderError("<Git.Push>");
    },
  },
);
