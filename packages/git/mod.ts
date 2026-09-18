/**
 * @module
 *
 * The Git Plugin for Executable.md.
 *
 * Repositories, worktrees, Git operations, pull requests and issues, as
 * vocabulary a document writes and as durable effects a run retains. The
 * default export is the Plugin itself; everything beside it is the surface a
 * provider adapter composes against.
 *
 * ```md
 * <Repository name="site" url="https://github.com/octo/site.git">
 *   <Git.Switch branch="topic" />
 *   <File path="notes.md">what this run decided</File>
 *   <Git.Commit message="record the decision" />
 * </Repository>
 * ```
 *
 * A `<Repository>` is retained in the run's Workspace: its bytes, the row that
 * names it, and the Workspace root they were published against all commit
 * together or not at all. So a resumed run continues from the checkout it
 * recorded rather than from whatever is on the machine now, and a replay
 * performs no Git at all.
 *
 * ## Git-host effects
 *
 * A **Git host** is an external service that owns remote Git repositories and
 * associated collaboration objects such as branches, pull requests and issues.
 * GitHub is one Git-host adapter; a Git host is not the local Git capability
 * and not the trusted workflow host.
 *
 * A Git host owns state no local transaction can enclose, so pushing, opening a
 * pull request and filing an issue all face the same question after an
 * interruption: did the previous attempt already succeed?
 * `reconcileGitHostEffect()` answers it once, for all three. A live attempt
 * observes under an identity derived from the run and the expansion, then
 * adopts a proven compatible completion, performs a proven absence exactly
 * once, or refuses.
 *
 * `withGitHostProvider()` installs the provider that answers those phases. A
 * provider need not implement every kind: a plain Git server may support
 * `git-push` and refuse pull requests and issues. Routing is one contextual
 * operation that settles no completion — middleware may inspect, narrow or
 * refuse a request, and nothing it can hold or combine can answer one.
 *
 * ## Durable identity does not move with the source
 *
 * These components were published by `@executablemd/workflow` before this
 * package existed, and every journal, database row and artifact a released
 * build wrote names that origin. Those strings identify retained history rather
 * than current source ownership, so they are preserved exactly here — including
 * the `@executablemd/workflow/composition` origin and the released
 * `@executablemd/workflow/composition/dir-v2#Dir` alias.
 */

export { default } from "./src/plugin.ts";
export { gitPlugin } from "./src/plugin.ts";
export { workflowInstallation } from "./src/installation.ts";
export {
  Git,
  gitObjectFormat,
  GitObjectError,
  GitRepositoryError,
  GitRevisionError,
  readGitObject,
  repositoryRoot,
  revParse,
} from "./src/git.ts";
export type { GitApi, GitObjectFormat } from "./src/git.ts";
export { RepositoryComposition } from "./src/composition/api.ts";
export type { RepositoryCompositionApi } from "./src/composition/api.ts";
export { currentRepository, RepositoryContext } from "./src/composition/context.ts";
export type { RepositoryContextApi } from "./src/composition/context.ts";
export {
  GitCompositionProviderError,
  GitOperationError,
  GitOperationProtocolError,
  PullRequestAdmissionError,
  RepositoryCompositionError,
  RepositoryCompositionProtocolError,
  RepositoryCompositionProviderError,
  RepositoryStaleStateError,
  WorktreeCompositionError,
} from "./src/composition/errors.ts";
export type {
  GitFailureReason,
  PullRequestAdmissionReason,
  RepositoryFailureReason,
  WorktreeFailureReason,
} from "./src/composition/errors.ts";
export {
  parseRepositoryRecord,
  parseWorktreeRecord,
  repositoryRecordJson,
  sameRepositoryRecord,
  sameWorktreeRecord,
  worktreeRecordJson,
} from "./src/composition/records.ts";
export type {
  RepositoryCreationRequest,
  RepositoryRecord,
  WorktreeCreationRequest,
  WorktreeRecord,
} from "./src/composition/records.ts";
export {
  NoPullRequestProvider,
  PULL_REQUEST_API,
  PullRequestAPI,
} from "./src/composition/pull-request-api.ts";
export type {
  PullRequestApi,
  PullRequestInput,
  PullRequestReadOptions,
  PullRequestUpsertOptions,
} from "./src/composition/pull-request-api.ts";
export {
  canonicalPullRequestUrl,
  pullRequestProviderName,
} from "./src/composition/pull-request-target.ts";
export type { PullRequestTarget } from "./src/composition/pull-request-target.ts";
export { GitComposition } from "./src/composition/git-api.ts";
export type { GitCompositionApi } from "./src/composition/git-api.ts";
export {
  gitAddResultJson,
  gitCommitResultJson,
  gitSwitchResultJson,
  parseGitAddResult,
  parseGitCheckoutIdentity,
  parseGitCheckoutState,
  parseGitCommitMessageSource,
  parseGitCommitResult,
  parseGitSwitchResult,
} from "./src/composition/git-records.ts";
export type {
  GitAddExpectation,
  GitAddRequest,
  GitAddResult,
  GitCheckoutExpectation,
  GitCheckoutIdentity,
  GitCheckoutState,
  GitCommitExpectation,
  GitCommitMessageSource,
  GitCommitRequest,
  GitCommitResult,
  GitSwitchExpectation,
  GitSwitchRequest,
  GitSwitchResult,
} from "./src/composition/git-records.ts";
export {
  destinationRefFor,
  GIT_PUSH,
  gitPushInputsJson,
  gitPushNaturalKeyJson,
  gitPushObservationsJson,
  gitPushPreStateJson,
  gitPushResultJson,
  parseGitPushInputs,
  parseGitPushNaturalKey,
  parseGitPushObservations,
  parseGitPushPreState,
  parseGitPushRecord,
  parseGitPushResult,
  PUSH_REMOTE,
  pushExpectation,
  refspecFor,
} from "./src/composition/git-push-records.ts";
export type {
  GitPushExpectation,
  GitPushInputs,
  GitPushNaturalKey,
  GitPushObservations,
  GitPushOutcome,
  GitPushPreState,
  GitPushRequest,
  GitPushResult,
} from "./src/composition/git-push-records.ts";
export {
  OPEN,
  parsePullRequestInputs,
  parsePullRequestNaturalKey,
  parsePullRequestObservations,
  parsePullRequestPreState,
  parsePullRequestRecord,
  parsePullRequestResult,
  parsePullRequestSnapshot,
  PULL_REQUEST,
  pullRequestAgrees,
  pullRequestMode,
  pullRequestInputsJson,
  pullRequestNaturalKey,
  pullRequestNaturalKeyJson,
  pullRequestNumber,
  pullRequestObservationsJson,
  pullRequestPreStateJson,
  pullRequestResultJson,
  pullRequestResultOf,
  pullRequestSnapshotJson,
  sameNaturalKey,
  samePullRequestIdentity,
} from "./src/composition/pull-request-records.ts";
export type {
  PullRequestCreateKey,
  PullRequestExpectation,
  PullRequestInputs,
  PullRequestMode,
  PullRequestNaturalKey,
  PullRequestObservations,
  PullRequestOutcome,
  PullRequestPreState,
  PullRequestRequest,
  PullRequestResult,
  PullRequestSnapshot,
  PullRequestUpdateKey,
} from "./src/composition/pull-request-records.ts";
export { admitPushEvidence } from "./src/composition/push-evidence.ts";
export {
  COMPOSITION_REGISTRATIONS,
  compositionDocumentation,
  useCompositionComponents,
} from "./src/composition/installation.ts";
export { ISSUE_API, IssueApi, NoIssueProvider } from "./src/issue/api.ts";
export type {
  IssueDetails,
  IssueInput,
  IssueOperation,
  IssueReadOptions,
  IssueReference,
  IssueUpsertOptions,
} from "./src/issue/api.ts";
export {
  ISSUE_TRACKER_CONTEXT,
  IssueTrackerContext,
  currentIssueTracker,
} from "./src/issue/context.ts";
export { ISSUE_EFFECT } from "./src/issue/effect-type.ts";
export {
  IssueAmbiguousError,
  IssueConflictError,
  IssueContentError,
  IssueProtocolError,
  IssueTrackerError,
  IssueUnavailableError,
} from "./src/issue/errors.ts";
export type { IssueTrackerReason } from "./src/issue/errors.ts";
export {
  canonicalIssueTarget,
  issueProviderName,
  resolveIssueDestination,
  withinIssueCeiling,
} from "./src/issue/tracker.ts";
export type { IssueDestination, IssueTracker } from "./src/issue/tracker.ts";
export { GIT_HOST_API, GitHost } from "./src/git-host/api.ts";
export type {
  GitHostApi,
  GitHostCall,
  GitHostPhase,
  GitHostPhaseDetails,
  GitHostProvider,
  GitHostRoutingRequest,
} from "./src/git-host/api.ts";
export {
  GitHostAmbiguousError,
  GitHostConflictError,
  GitHostProtocolError,
  GitHostProviderError,
  GitHostUnavailableError,
} from "./src/git-host/errors.ts";
export {
  completeGitHostEffectRequestJson,
  gitHostReconciliationRecordJson,
  parseCompleteGitHostEffectRequest,
  parseGitHostCompletion,
  parseGitHostEffectIdentity,
  parseGitHostObservation,
  parseGitHostReconciliationRecord,
  sameGitHostEffectRequest,
} from "./src/git-host/records.ts";
export type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostDecision,
  GitHostEffectIdentity,
  GitHostEffectRequest,
  GitHostObservation,
  GitHostReconciliationRecord,
} from "./src/git-host/records.ts";
export {
  GIT_HOST_EFFECT,
  reconcileGitHostEffect,
  withGitHostProvider,
} from "./src/git-host/effect.ts";
export {
  filteredRepositoryIdentity,
  parseRepositoryIdentity,
  repositoryIdentityJson,
  sameRepositoryIdentity,
} from "./src/composition/selection.ts";
export type { RepositoryIdentity } from "./src/composition/selection.ts";
