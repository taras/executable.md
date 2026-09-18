/**
 * @module
 *
 * Workflow runs for Executable.md.
 *
 * A workflow run is a run of one immutable definition, recorded durably before
 * the root document is imported so later document executions and durable
 * effects share one explicit identity. The run itself is retained, so another
 * process can find it by its public id and continue from durable data rather
 * than from whoever happened to be holding the journal.
 *
 * A definition is one of two things. Version 1 is a Git object and the path of
 * the root document inside it, run from one resolved base; its Markdown lives
 * in a repository, and a trusted host supplies the reader that fetches it.
 * Version 2 is a **source bundle**: the exact bytes themselves, addressed by
 * portable logical paths and retained with the run. A source-bundle run needs
 * no repository to start, resume, replay or export — which is what lets a file
 * outside Git, an untracked file, and a file edited since its last commit each
 * be one immutable definition the moment it is retained.
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
 * operation that settles no completion — middleware may inspect,
 * narrow or refuse a request, and nothing it can hold or combine can answer
 * one.
 */

export { getWorkflowRun, retainedWorkflowInstallation } from "./src/run.ts";
/**
 * How a trusted host states what its own run is.
 *
 * The generic constructor behind both installations above: a host supplies the
 * durable description, whether a successful record is required, how the run is
 * allocated when nothing is recorded yet, and what a recorded run has to agree
 * with. Everything the run is then held to stays in this package.
 */
export { createWorkflowRunInstallation } from "./src/run.ts";
export type { WorkflowRunPreparation } from "./src/run.ts";
export { workflowBundleInstallation, WorkflowBundleHistoryError } from "./src/bundle.ts";
export type { WorkflowRun } from "./src/run.ts";
export { isGitWorkflowRun, workflowRunValue } from "./src/journal.ts";
/**
 * The version-1 description and the two refusals a Git run is held to.
 *
 * Published because `@executablemd/git` states what a Git-defined run is, and
 * this package still owns what that statement is compared against. The
 * description names the exact retained identity released builds wrote; the two
 * refusals are the exact words a disagreement travels in.
 */
export { baseMismatch, describeGitWorkflowRun, retainedRunMismatch } from "./src/journal.ts";
export type { GitWorkflowRunV1, SourceBundleWorkflowRunV2 } from "./src/journal.ts";
export { useWorkflowServiceDenial, WorkflowServiceDeniedError } from "./src/service-denial.ts";

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

export { isGitWorkflowRunCreation } from "./src/lifecycle/execution.ts";
export type {
  GitWorkflowRunCreationV1,
  SourceBundleWorkflowRunCreationV2,
  WorkflowRunCreation,
} from "./src/lifecycle/execution.ts";
export type {
  GitDefinitionSourceClosureV1,
  GitDefinitionSourceComponentV1,
  GitDefinitionSourceRootV1,
  GitRetainedDefinitionSourcesV1,
  LegacyWorkflowSourceReader,
  RetainedDefinitionSources,
  SourceBundleRetainedDefinitionSourcesV2,
  SourceBundleRetainedSourceV2,
} from "./src/lifecycle/source.ts";

export { WorkflowLifecycle, WorkflowLifecycleProviderError } from "./src/lifecycle/api.ts";
export type {
  ExecutorAcquisition,
  ExecutorLock,
  WorkflowDeletion,
  WorkflowForkLineage,
  WorkflowInspectionSnapshot,
  WorkflowLifecycleApi,
  WorkflowLifecycleSnapshot,
} from "./src/lifecycle/api.ts";
// The export request, its result and the boundary it names. The retained record
// shapes an artifact also carries are DOFS and SQLite rows, so they are the
// Deno entrypoint's to publish rather than this one's.
export type {
  WorkflowExportRequest,
  WorkflowExportResult,
  XmdArtifactFrontier,
} from "./src/lifecycle/export.ts";
export type {
  WorkflowArtifactHistory,
  WorkflowArtifactIdentity,
  WorkflowArtifactSnapshot,
} from "./src/lifecycle/artifact.ts";
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
  definitionTargetPath,
  definitionToJson,
  isGitWorkflowDefinition,
  isSourceBundleWorkflowDefinition,
  parseWorkflowDefinition,
} from "./src/storage/definition.ts";
export type {
  GitWorkflowDefinitionV1,
  WorkflowComponentEntry,
  WorkflowDefinition,
} from "./src/storage/definition.ts";

export {
  decodeSourceText,
  parseSourceBundleDefinition,
  sourceBundleComponents,
  sourceBundleDefinitionToJson,
  sourceBundleHash,
  sourceContentHash,
  verifySourceBundleDefinition,
  verifySourceBundleSnapshot,
} from "./src/storage/source-bundle.ts";
export type {
  SourceBundleComponentV2,
  SourceBundleEntryV2,
  SourceBundleIdentityV2,
  SourceBundleSnapshotEntryV2,
  SourceBundleWorkflowDefinitionV2,
} from "./src/storage/source-bundle.ts";

export { parseJsonValue } from "./src/storage/members.ts";
export { conflictingFields } from "./src/storage/compatibility.ts";
export type {
  GitWorkflowRunComparisonV1,
  SourceBundleWorkflowRunComparisonV2,
  WorkflowRunComparison,
} from "./src/storage/compatibility.ts";

export {
  canonicalJson,
  isGitWorkflowRunRecord,
  parseStopReasonInput,
  parseWorkflowRunStatus,
  parseWorkflowStopReason,
  WORKFLOW_RUN_STATUSES,
} from "./src/storage/record.ts";
export type {
  DefinitionRetrieval,
  GitWorkflowRunRecordV1,
  SourceBundleWorkflowRunRecordV2,
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  StoredRunState,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "./src/storage/record.ts";

export {
  LegacyWorkflowSourceMismatchError,
  LegacyWorkflowSourceReaderUnavailableError,
  LegacyWorkflowSourceUnavailableError,
  WorkflowDatabaseClosedError,
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowDefinitionCorruptError,
  WorkflowDefinitionError,
  WorkflowDefinitionSourceMissingError,
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
