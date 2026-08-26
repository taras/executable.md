/**
 * @module
 *
 * Workflow runs for Executable.md.
 *
 * A workflow run is a run of one immutable definition — a Git object and the
 * path of the root document inside it — from one resolved base, recorded
 * durably before the root document is imported so later document executions
 * and durable effects share one explicit identity. The run itself is retained,
 * so another process can find it by its public id and continue from durable
 * data rather than from whoever happened to be holding the journal.
 *
 * ```ts
 * import { workflowInstallation } from "@executablemd/workflow";
 * import { executeInstalled } from "@executablemd/core/host";
 *
 * const execution = yield* executeInstalled(
 *   { path: "./workflow.md", stream },
 *   [workflowInstallation({ base: "main" })],
 * );
 * ```
 *
 * A run's durable record lives behind the Workflow Run Storage Api, which
 * names no provider. The Deno host installs its own from
 * `@executablemd/workflow/deno`; nothing here imports it, and nothing here
 * imports SQLite, Deno or any other host.
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
 * once, or refuses. Prompt is not one of these effects and keeps its Agent
 * provider contract.
 *
 * `withGitHostProvider()` installs the provider that answers those phases. A
 * provider need not implement every kind: a plain Git server may support
 * `git-push` and refuse pull requests and issues. Routing is one contextual
 * operation that carries no completion authority — middleware may inspect,
 * narrow or refuse a request, and nothing it can hold or combine can answer
 * one.
 */

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
export { getWorkflowRun, retainedWorkflowInstallation, workflowInstallation } from "./src/run.ts";
export { workflowBundleInstallation, WorkflowBundleHistoryError } from "./src/bundle.ts";
export type { WorkflowRun } from "./src/run.ts";
export { useWorkflowServiceDenial, WorkflowServiceDeniedError } from "./src/service-denial.ts";

export { RepositoryComposition } from "./src/composition/api.ts";
export type { RepositoryCompositionApi } from "./src/composition/api.ts";
export { currentRepository, RepositoryContext } from "./src/composition/context.ts";
export type { RepositoryContextApi } from "./src/composition/context.ts";
export {
  GitCompositionProviderError,
  GitOperationError,
  GitOperationProtocolError,
  PullRequestAuthorityError,
  RepositoryCompositionError,
  RepositoryCompositionProtocolError,
  RepositoryCompositionProviderError,
  RepositoryStaleStateError,
  WorktreeCompositionError,
} from "./src/composition/errors.ts";
export type {
  GitFailureReason,
  PullRequestAuthorityReason,
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
  filteredRepositoryIdentity,
  GIT_PUSH,
  gitPushInputsJson,
  gitPushNaturalKeyJson,
  gitPushObservationsJson,
  gitPushPreStateJson,
  gitPushRepositoryIdentityJson,
  gitPushResultJson,
  parseGitPushInputs,
  parseGitPushNaturalKey,
  parseGitPushObservations,
  parseGitPushPreState,
  parseGitPushRecord,
  parseGitPushRepositoryIdentity,
  parseGitPushResult,
  PUSH_REMOTE,
  pushExpectation,
  refspecFor,
  sameRepositoryIdentity,
} from "./src/composition/git-push-records.ts";
export type {
  GitPushExpectation,
  GitPushInputs,
  GitPushNaturalKey,
  GitPushObservations,
  GitPushOutcome,
  GitPushPreState,
  GitPushRepositoryIdentity,
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
export { useCompositionComponents } from "./src/composition/installation.ts";

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

export { WorkspaceCoordination, WorkspaceCoordinationProviderError } from "./src/workspace/api.ts";
export type { WorkspaceCoordinationApi } from "./src/workspace/api.ts";
export { createDurableWorkspaceOperation } from "./src/workspace/effect.ts";

export { WorkflowRunStorage, WorkflowStorageProviderError } from "./src/storage/api.ts";
export type {
  CreateWorkflowRunRequest,
  JournalEntry,
  WorkflowRunDatabase,
  WorkflowRunStorageApi,
  WorkflowRunTransaction,
} from "./src/storage/api.ts";

export { WorkflowLifecycle, WorkflowLifecycleProviderError } from "./src/lifecycle/api.ts";
export type {
  ExecutorAcquisition,
  ExecutorLock,
  WorkflowDeletion,
  WorkflowForkLineage,
  WorkflowLifecycleApi,
  WorkflowLifecycleSnapshot,
} from "./src/lifecycle/api.ts";
export { gitBlobIdentity } from "./src/artifact/source.ts";
export type { WorkflowExportRequest, WorkflowExportResult } from "./src/lifecycle/export.ts";
export type {
  DetachedXmdArtifact,
  VerifiedXmdArtifact,
  XmdArtifactDefinitionClosure,
  XmdArtifactDefinitionComponent,
  XmdArtifactDefinitionRoot,
  XmdArtifactFrontier,
} from "./src/artifact/types.ts";
export { readEventSource } from "./src/lifecycle/history.ts";
export type { InheritedEventProvenance, WorkflowHistoryEntry } from "./src/lifecycle/history.ts";
export { classifyForkability } from "./src/lifecycle/forkability.ts";
export {
  forkJournal,
  forkRunRecordEvent,
  isRootImportEvent,
  isRunRecordEvent,
  selectForkPrefix,
} from "./src/fork.ts";
export type { ForkCandidate, ForkSelection } from "./src/fork.ts";
export type {
  Forkability,
  ForkabilityCandidate,
  ForkabilityContext,
  ForkBlocker,
  ForkBlockerCode,
} from "./src/lifecycle/forkability.ts";

export {
  definitionComponents,
  definitionToJson,
  parseWorkflowDefinition,
} from "./src/storage/definition.ts";
export type {
  GitWorkflowDefinitionV1,
  WorkflowComponentEntry,
  WorkflowDefinition,
} from "./src/storage/definition.ts";

export { conflictingFields } from "./src/storage/compatibility.ts";

export {
  canonicalJson,
  parseStopReasonInput,
  parseWorkflowRunStatus,
  parseWorkflowStopReason,
  WORKFLOW_RUN_STATUSES,
} from "./src/storage/record.ts";
export type {
  DefinitionRetrieval,
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  StoredRunState,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "./src/storage/record.ts";

export {
  WorkflowDatabaseClosedError,
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowDefinitionError,
  WorkflowDocumentExecutionError,
  WorkflowIncompleteVersionOneError,
  WorkflowInspectionRecoveryError,
  WorkflowRecordMalformedError,
  WorkflowRequestError,
  WorkflowRunConflictError,
  WorkflowRunIdMismatchError,
  WorkflowRunLocationMismatchError,
  WorkflowRunNotFoundError,
  WorkflowSchemaVersionError,
  WorkflowStorageError,
  WorkflowTransactionError,
} from "./src/storage/errors.ts";

export {
  ELICITATION_REQUEST_KIND,
  SUSPENSION_ORIGIN,
  useWorkflowElicitation,
} from "./src/suspension/elicitation.ts";
export { SUSPENSION_REQUEST, suspendFor, suspensionId } from "./src/suspension/suspend.ts";
export {
  parseSuspensionRequest,
  WorkflowSuspension,
  WorkflowSuspensionProviderError,
  WorkflowSuspensionRequestError,
} from "./src/suspension/api.ts";
export type { WorkflowSuspensionApi, WorkflowSuspensionRequest } from "./src/suspension/api.ts";
export { SUSPENSION_ANSWER } from "./src/suspension/answer.ts";
export {
  WorkflowAnswerDeliveryError,
  WorkflowInputDelivery,
  WorkflowInputDeliveryProviderError,
} from "./src/suspension/delivery.ts";
export type {
  WorkflowAnswerDelivery,
  WorkflowAnswerRetention,
  WorkflowInputDeliveryApi,
} from "./src/suspension/delivery.ts";
