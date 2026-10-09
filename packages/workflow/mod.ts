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
 * A definition is the exact bytes themselves, addressed by portable logical
 * paths and retained with the run. That is what lets a file outside Git, an
 * untracked file, and a file edited since its last commit each be one
 * immutable definition the moment it is retained — and it is why nothing here
 * reaches a repository for source. Starting, resuming, forking and exporting
 * all read the run's own store, so there is no source capability for a host to
 * supply and no definition whose bytes live anywhere but in the run.
 *
 * `retainedWorkflowInstallation()` resolves no base and names no Git feature,
 * and that is now a statement about what a run needs rather than only about
 * this package's imports.
 *
 * ```ts
 * import { retainedWorkflowInstallation } from "@executablemd/workflow";
 * import { executeInstalled } from "@executablemd/core/host";
 *
 * const execution = yield* executeInstalled(
 *   { path: "./workflow.md", stream },
 *   [retainedWorkflowInstallation(run)],
 * );
 * ```
 *
 * A run's durable record lives behind the Workflow Run Storage Api, which
 * names no provider. The Deno host installs its own from
 * `@executablemd/workflow/deno`; nothing here imports it, and nothing here
 * imports SQLite, Deno or any other host.
 *
 * ## What this package no longer owns
 *
 * Repository composition, the Git capability, issue and pull-request contracts
 * and the Git-host reconciliation engine belong to `@executablemd/git`, which
 * imports this package's public extension boundaries rather than the other way
 * round. A run's history still holds their retained records, and this package
 * still reads enough of one to decide whether a checkpoint can be forked — as
 * compatibility data, named by the strings a released build wrote.
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
export { workflowRunValue } from "./src/journal.ts";
/**
 * The retained run value, and the refusal a run that is not it travels in.
 *
 * The description names the exact retained identity a run writes; the refusal
 * is the exact words a disagreement with it travels in.
 */
export { describeWorkflowRun, retainedRunMismatch } from "./src/journal.ts";
export type { WorkflowRun } from "./src/journal.ts";
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

export type { WorkflowRunCreation } from "./src/lifecycle/execution.ts";
export type { RetainedDefinitionSources, RetainedSource } from "./src/lifecycle/source.ts";

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
  parseWorkflowDefinition,
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
  SourceBundleComponent,
  SourceBundleEntry,
  SourceBundleIdentity,
  SourceBundleSnapshotEntry,
  WorkflowDefinition,
} from "./src/storage/source-bundle.ts";

export { parseJsonValue } from "./src/storage/members.ts";
export { conflictingFields } from "./src/storage/compatibility.ts";
export type { WorkflowRunComparison } from "./src/storage/compatibility.ts";

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
  WorkflowDefinitionCorruptError,
  WorkflowDefinitionError,
  WorkflowDefinitionSourceMissingError,
  WorkflowDocumentExecutionError,
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
