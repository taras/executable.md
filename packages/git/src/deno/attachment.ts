/**
 * What this package installs into one workflow run's Workspace.
 *
 * The block `@executablemd/workflow` used to hold: the Repository and Git
 * composition providers, the retained lifecycles for the two service-reaching
 * vocabularies, the component registrations and the Git-host middleware this
 * platform can reach. It is the same sequence in the same order — a run that
 * attaches it gets the providers it always had, beneath the run's own effect
 * coordinator and above nothing.
 *
 * It is a `WorkflowWorkspaceInstaller`, so the host names it and Workflow
 * decides when it runs. What it is handed is the run's database and nothing
 * else: every durable thing it does goes through one published boundary — a
 * Workspace effect, or a read-only inspection.
 *
 * A completed replay never reaches this path, which is why it contacts no
 * remote and spawns no Git: the providers that could are never installed.
 */

import type { Operation } from "effection";
import type { WorkflowWorkspaceAttachment } from "@executablemd/workflow/deno";
import { useRetainedIssueOperations } from "../issue/effect.ts";
import { denoRepositoryHost } from "./composition/host.ts";
import { useGitHubPullRequests } from "./composition/pull-request-reads.ts";
import type { GitHubPullRequestsOptions } from "./composition/pull-request-reads.ts";
import type { HelperAssembly } from "./composition/credential-helper.ts";
import {
  useGitComposition,
  useRepositoryComposition,
  workflowSelections,
  type CompositionProviderOptions,
} from "./composition/provider.ts";
import {
  useRetainedPullRequestOperations,
  useRetainedPullRequestReads,
} from "./composition/pull-request-operations.ts";
import { useGitHubIssues, type GitHubIssuesOptions } from "./issue/github.ts";

/**
 * Installation options a host owns and a document cannot reach.
 *
 * Supplied where the provider is installed, which is before any document
 * exists. A suite substitutes the leaf host dependencies here — the Git
 * subprocess and the temporary directory — because those are the two things a
 * repository arranged on disk cannot make behave deterministically.
 */
export interface GitWorkspaceOptions {
  readonly composition?: CompositionProviderOptions;
  /**
   * What GitHub issue handling this host installs, and what it may reach.
   *
   * Separate from `composition` because `<Issue>` is not Repository
   * composition: it reaches a service that need not own a Git repository, so
   * its middleware, its ceiling and its credentials are configured on their
   * own. Absent installs none, and a document that writes `<Issue>` then
   * reaches `IssueApi`'s own base error.
   */
  readonly gitHubIssues?: GitHubIssuesOptions;
  /**
   * The pull-request destinations this host allows a document to read.
   *
   * Absent authorizes no URL read, so a document naming one reaches
   * `PullRequestAPI`'s own base error rather than a host that quietly read
   * somewhere nobody allowed. It does not disable `<PullRequest>`, whose
   * admission is this run's own Push evidence rather than a configured URL.
   */
  readonly gitHubPullRequests?: GitHubPullRequestsOptions;
  /**
   * How this host writes and starts its own credential helper.
   *
   * Supplied by the runtime entrypoint, which is the only place that knows
   * whether this is Deno source or a compiled binary and which platform it is
   * standing on.
   */
  readonly helper?: HelperAssembly;
}

/**
 * The attachment a host names to give a workflow run this vocabulary's
 * providers.
 *
 * Providers and per-run durable state, and not the declarations: what names
 * `<Repository>` is the Plugin, installed once per command in the scope that
 * encloses everything the command does. A Workspace attachment is nested
 * inside that scope, so declaring here would register the same names a second
 * time, one scope deeper — which is not a collision but a shadow, and a shadow
 * of the defaults is exactly the position a document's own registration is
 * entitled to.
 */
export function gitWorkspaceAttachment(
  options: GitWorkspaceOptions = {},
): (attachment: WorkflowWorkspaceAttachment) => Operation<void> {
  return function* ({ database }): Operation<void> {
    // One registry for the whole attachment: `<Git.Add>` is handed what
    // `<Repository>` minted, and two registries would be two providers that
    // could not recognize each other's selections.
    const selections = options.composition?.selections ?? workflowSelections();
    const composition = {
      ...options.composition,
      ...(options.helper === undefined ? {} : { helper: options.helper }),
      selections,
    };
    yield* useRepositoryComposition(database, composition);
    yield* useGitComposition(database, composition);
    if (options.gitHubIssues !== undefined) {
      yield* useGitHubIssues(options.gitHubIssues);
    }
    // The retained lifecycle for both service-reaching vocabularies, above
    // whichever transport middleware this host installed for them.
    yield* useRetainedIssueOperations();
    yield* useRetainedPullRequestOperations();
    // Durability for an admitted read, installed beside the transport rather
    // than above it: the adapter admits, this retains.
    yield* useRetainedPullRequestReads();
    // Ordinary middleware, installed the way the Issue adapter is: it owns
    // the URLs it recognizes and delegates the rest.
    // Installed on every live or partial attachment, configured or not: the
    // configuration governs URL reads, and `<PullRequest>` must keep working
    // on a host that authorizes none.
    yield* useGitHubPullRequests(
      database,
      composition.host ?? denoRepositoryHost(),
      options.gitHubPullRequests ?? {},
      selections,
    );
  };
}
