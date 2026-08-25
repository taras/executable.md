/**
 * The Workspace attachment a host outside this package installs.
 *
 * Same name as the one beside it, and deliberately not the same function. The
 * internal `withWorkflowWorkspace` accepts the leaf substitutions a suite needs
 * — the Git subprocess, the temporary directory, the Git-host transport — and
 * any one of them is a seam through which a credential this run acquires would
 * become visible to whoever supplied it. A `RepositoryHost` sees every
 * `GitInvocation`, and an authenticated invocation carries its attachment; a
 * package that could install one could read what the adapter is holding.
 *
 * So what is published is this: a wrapper that names the two things a *host*
 * owns and projects only those. There is no member on its options for a
 * substituted host, and no path through it that would reach one if a caller
 * invented the property anyway — the projection is explicit rather than a spread
 * of whatever arrived.
 *
 * The broad one keeps its name and stays where it is. Code inside this package
 * imports it source-relatively, which is a path nothing a document loaded can
 * write.
 */

import type { Operation } from "effection";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import type { GitHubIssuesOptions } from "../issue/github.ts";
import type { GitHubPullRequestsOptions } from "../composition/pull-request-reads.ts";
import type { HelperAssembly } from "../composition/credential-helper.ts";
import { withWorkflowWorkspace as withBroadWorkspace } from "./host.ts";
import type { WorkflowAgentInstaller } from "./host.ts";

/**
 * What a host may configure, and the whole of it.
 *
 * Which issue tracker this host authorizes, and how it assembles its own
 * credential helper. Both are facts about the program that is running rather
 * than anything a document or a loaded package decides.
 */
export interface WorkflowWorkspaceOptions {
  readonly gitHubIssues?: GitHubIssuesOptions;
  /**
   * Which pull requests this host allows a document to read.
   *
   * A host fact like the tracker beside it. Absent authorizes no URL read and
   * disables nothing else: `<PullRequest>` upserts on this run's own Push
   * evidence, which no configuration grants or withdraws.
   *
   * Its `access` member is deliberately *not* projected through here. A
   * transport is a seam through which a credential this run acquires would
   * become visible to whoever supplied it, and a host outside this package has
   * no business installing one — the same reason there is no member for a
   * substituted `RepositoryHost`.
   */
  readonly gitHubPullRequests?: Pick<GitHubPullRequestsOptions, "allowed" | "endpoint">;
  readonly helper?: HelperAssembly;
  /**
   * The Agent profile this host installs for a live or partial attachment.
   *
   * A host fact like the two beside it: which agent client this program can
   * reach, and under what ceiling. This package names no agent client, so the
   * profile arrives from the runtime entrypoint that does.
   */
  readonly agent?: WorkflowAgentInstaller;
}

/** Run `operation` with this run's Workspace attached, as a host installs it. */
export function withWorkflowWorkspace<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
  options: WorkflowWorkspaceOptions = {},
): Operation<T> {
  // Projected member by member. A spread would carry whatever else a caller put
  // on the object, and reading an unknown property is how a getter somebody
  // else wrote gets to run.
  return withBroadWorkspace(database, operation, {
    ...(options.gitHubIssues === undefined ? {} : { gitHubIssues: options.gitHubIssues }),
    ...(options.gitHubPullRequests === undefined
      ? {}
      : {
          // Member by member here too, so a caller that put an `access` on the
          // object cannot reach the transport seam through a published surface.
          gitHubPullRequests: {
            ...(options.gitHubPullRequests.allowed === undefined
              ? {}
              : { allowed: options.gitHubPullRequests.allowed }),
            ...(options.gitHubPullRequests.endpoint === undefined
              ? {}
              : { endpoint: options.gitHubPullRequests.endpoint }),
          },
        }),
    ...(options.helper === undefined ? {} : { helper: options.helper }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
}
