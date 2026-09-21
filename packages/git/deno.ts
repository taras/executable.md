/**
 * @module
 *
 * The Deno host's Git capability.
 *
 * Native Git, managed checkouts, the local repository provider and the Git-host
 * adapters this platform can reach. Keeping them behind their own entrypoint is
 * what lets `@executablemd/git` stay provider-neutral: subprocesses, filesystem
 * paths and Deno's own behavior live here and nowhere above.
 *
 * Importing this module performs nothing. It discovers no repository, creates
 * no directory, runs no `git`, reads no credential and reaches no network —
 * every one of those happens inside the first operation that actually needs
 * repository state.
 */

export {
  GITHUB as GITHUB_PULL_REQUEST_PROVIDER,
  parseGitHubPullRequestUrl,
  pullRequestAllowed,
  recognizesGitHubPullRequestUrl,
} from "./src/deno/composition/pull-request-reads.ts";
export { useGitHubPullRequests } from "./src/deno/composition/pull-request.ts";
export type { GitHubPullRequestsOptions } from "./src/deno/composition/pull-request-reads.ts";
export {
  WORKSPACE_GIT_ADD,
  WORKSPACE_GIT_SWITCH,
  WORKSPACE_REPOSITORY,
  WORKSPACE_WORKTREE,
} from "./src/deno/composition/provider.ts";
export {
  GITHUB,
  parseGitHubIssueTarget,
  recognizesGitHubUrl,
  useGitHubIssues,
} from "./src/deno/issue/github.ts";
export type { GitHubIssuesOptions } from "./src/deno/issue/github.ts";
/**
 * The ordinary run's repository provider.
 *
 * The installer alone, and the options a trusted entrypoint supplies to it.
 * What the provider holds — the leases, the credential assembly, the selection
 * registry, the live Push evidence and the metadata writer — stays inside it:
 * a package that could reach one of those could authorize a publication this
 * execution never made.
 */
export { gitWorkspaceAttachment } from "./src/deno/attachment.ts";
export type { GitWorkspaceOptions } from "./src/deno/attachment.ts";
export { useRunComposition } from "./src/deno/run-composition/provider.ts";
export type { RunCompositionOptions } from "./src/deno/run-composition/provider.ts";
