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
  GitSwitchRequest,
  GitSwitchResult,
} from "./git-records.ts";

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
  },
);
