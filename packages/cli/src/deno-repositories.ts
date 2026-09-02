/**
 * The live repository provider, assembled where it can be.
 *
 * Kept apart from `run-repositories.ts` because that module is on the shared
 * command path and this one names the Deno adapter, whose module graph reaches
 * `node:sqlite`. Bun has no such built-in, so a static import of this from
 * shared code would stop `xmd` loading there — not refuse a repository
 * operation, but fail to start at all. Only `deno.ts` and `compiled.ts` import
 * this file, and both of them are Deno.
 *
 * Managed checkouts live beneath `~/.xmd/repositories` and survive every
 * execution: what is in one is somebody's work, and nothing deletes one. There
 * is no environment variable naming a different root, because the only caller
 * that needs one is a test, and a test is handed the root directly.
 */

import type { Operation } from "effection";
import { cwd } from "@executablemd/runtime";
import { useRunComposition } from "@executablemd/workflow/deno";
import type { HelperAssembly } from "@executablemd/workflow/credential-helper";
import { gitHubIssuesConfiguration } from "./github-issues-config.ts";
import { gitHubPullRequestsConfiguration } from "./github-pull-requests-config.ts";
import { DEFAULT_REPOSITORY_ROOT } from "./run-repositories.ts";
import type { RepositoryInstaller } from "./run-repositories.ts";

/**
 * The live provider Deno and the compiled binary install.
 *
 * The two GitHub configurations are read once, when the installer runs, so an
 * operator who wrote something this host cannot use learns it before a document
 * expands rather than in the middle of one.
 */
export function denoRunRepositories(
  helper: HelperAssembly,
  root: string = DEFAULT_REPOSITORY_ROOT,
): RepositoryInstaller {
  return function* (): Operation<void> {
    const gitHubIssues = yield* gitHubIssuesConfiguration();
    const gitHubPullRequests = yield* gitHubPullRequestsConfiguration();
    yield* useRunComposition({
      root,
      // The directory this execution starts in, which is where the ambient
      // repository is discovered from. Read through the contextual Api rather
      // than from the process, so a nested execution that composed its own
      // working directory is discovered from that one.
      cwd: yield* cwd(),
      helper,
      ...(gitHubIssues === undefined ? {} : { gitHubIssues }),
      ...(gitHubPullRequests === undefined ? {} : { gitHubPullRequests }),
    });
  };
}
