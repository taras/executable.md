/**
 * The provider-neutral Api a transactional Git component asks for work through.
 *
 * `<Git.Switch>` names no subprocess and reaches no filesystem. It observes two
 * things a document can see — the enclosing `<Repository>` and the contextual
 * working directory — and asks whoever is installed to do the rest. Neither
 * observation carries authority: a replaced context can misname a Repository,
 * and the provider's answer is what decides which retained checkout, if any,
 * those two select.
 *
 * The default handler throws. There is no host-less fallback, because a Git
 * operation that "ran" without a provider would report a branch this run never
 * moved — and ordinary `xmd run` installs none, so a document written for a
 * workflow fails there rather than quietly touching a checkout in the caller's
 * own filesystem.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { GitCompositionProviderError } from "./errors.ts";
import type {
  GitAddRequest,
  GitAddResult,
  GitCommitRequest,
  GitCommitResult,
  GitSwitchRequest,
  GitSwitchResult,
} from "./git-records.ts";
import type { GitPushOutcome, GitPushRequest } from "./git-push-records.ts";

export interface GitCompositionApi {
  /**
   * Put the selected checkout on a named branch, as one durable effect.
   *
   * A completed one restores its retained result: replay changes no branch and
   * spawns no Git.
   */
  switchBranch(request: GitSwitchRequest): Operation<GitSwitchResult>;

  /**
   * Stage exactly the pathspecs this request names, as one durable effect.
   *
   * One command for the whole array rather than one per entry: Git decides what
   * a pathspec matches, and a per-entry loop would be several transitions where
   * the document wrote one.
   */
  addPaths(request: GitAddRequest): Operation<GitAddResult>;

  /**
   * Record exactly what the index holds, as one durable effect.
   *
   * Nothing is staged for it and nothing is amended: the index is the whole of
   * what a commit is made from, and an index that already matches HEAD is
   * refused rather than committed empty. A completed one restores its retained
   * result: replay writes no object, reads no clock and spawns no Git.
   */
  commitIndex(request: GitCommitRequest): Operation<GitCommitResult>;

  /**
   * Publish the selected checkout's current branch to its origin.
   *
   * The one operation here whose outcome a local transaction cannot enclose.
   * It observes the destination ref before it mutates and performs at most
   * once, so an interrupted attempt that already reached the remote is adopted
   * on the next execution rather than repeated; a completed one restores its
   * retained record without contacting the remote at all.
   *
   * Routed through this Api like the other three, and for the same reason: a
   * document names a checkout by writing an element inside one, and what that
   * observation selects is the installed provider's to decide. Observation is
   * all this carries — the provider still authenticates the record, the
   * directory and the objects it publishes against what this run retained.
   */
  pushCurrentBranch(request: GitPushRequest): Operation<GitPushOutcome>;
}

export const GitComposition: Api<GitCompositionApi> = createApi<GitCompositionApi>(
  "executablemd.workflow.composition.git",
  {
    // deno-lint-ignore require-yield
    *switchBranch(_request: GitSwitchRequest): Operation<GitSwitchResult> {
      throw new GitCompositionProviderError("<Git.Switch>");
    },
    // deno-lint-ignore require-yield
    *addPaths(_request: GitAddRequest): Operation<GitAddResult> {
      throw new GitCompositionProviderError("<Git.Add>");
    },
    // deno-lint-ignore require-yield
    *commitIndex(_request: GitCommitRequest): Operation<GitCommitResult> {
      throw new GitCompositionProviderError("<Git.Commit>");
    },
    // deno-lint-ignore require-yield
    *pushCurrentBranch(_request: GitPushRequest): Operation<GitPushOutcome> {
      throw new GitCompositionProviderError("<Git.Push>");
    },
  },
);
