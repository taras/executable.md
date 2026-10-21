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

export { gitCommitMessageEvidence } from "./src/deno/composition/commit.ts";
export { GitRefusal } from "./src/deno/composition/git.ts";
export type { GitCommitIdentity } from "./src/deno/composition/host.ts";
export { locatorFingerprint } from "./src/deno/composition/locator.ts";
export type { ObservationPlace } from "./src/deno/composition/observations.ts";
export { gitOperationFingerprint } from "./src/deno/composition/operations.ts";
export type { AdmittedReadExecution } from "./src/deno/composition/pull-request-reads.ts";
export { denoPullRequestOperations } from "./src/deno/composition/pull-request-host.ts";
export type { DenoPullRequestOperations } from "./src/deno/composition/pull-request-host.ts";
export {
  PULL_REQUEST_READ,
  retainPullRequestRead,
} from "./src/deno/composition/pull-request-read-retention.ts";
export {
  CompositionRefusal,
  gitRefusal,
  refusalReason,
  repositoryRefusal,
  restoredGitRefusal,
  worktreeRefusal,
} from "./src/deno/composition/refusals.ts";
export { useDenoGitHubIssues } from "./src/deno/issue/github-host.ts";
export { useDenoRepositoryOperations } from "./src/deno/repository-operations.ts";
export type { DenoRepositoryOperations } from "./src/deno/repository-operations.ts";
export type { AmbientRepository } from "./src/deno/run-composition/ambient.ts";
export {
  checkoutOf,
  commonDirectoryLock,
  repositorySlot,
  worktreeSlot,
} from "./src/deno/run-composition/checkout-layout.ts";
export {
  ManagedCheckoutError,
  NoAmbientRepositoryError,
  UnresolvedGitIdentityError,
} from "./src/deno/run-composition/errors.ts";
export type { ManagedCheckoutReason } from "./src/deno/run-composition/errors.ts";
export { captureCommitIdentity, denoIdentityReader } from "./src/deno/run-composition/identity.ts";
export type { IdentityReader } from "./src/deno/run-composition/identity.ts";
export { lazily } from "./src/deno/run-composition/lazy.ts";
export { useLeases } from "./src/deno/run-composition/leases.ts";
export type { Leases, SlotKind } from "./src/deno/run-composition/leases.ts";
export { selectCheckout } from "./src/deno/run-composition/operations.ts";
export type { RegisteredCheckout } from "./src/deno/run-composition/operations.ts";
export { selectionRegistry } from "./src/deno/selections.ts";
export type { SelectionRegistry } from "./src/deno/selections.ts";
