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
 * ## External forge effects
 *
 * A forge — whatever service holds branches, pull requests and issues — owns
 * state no local transaction can enclose, so pushing, opening a pull request
 * and filing an issue all face the same question after an interruption: did the
 * previous attempt already succeed? `reconcileForgeEffect()` answers it once,
 * for all of them. A live attempt observes under an identity derived from the
 * run and the expansion, then adopts a proven compatible completion, performs a
 * proven absence exactly once, or refuses. `withForgeProvider()` installs the
 * provider that answers those phases; the provider is selected contextually and
 * completes nothing on that surface's authority.
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
  RepositoryCompositionError,
  RepositoryCompositionProtocolError,
  RepositoryCompositionProviderError,
  RepositoryStaleStateError,
  WorktreeCompositionError,
} from "./src/composition/errors.ts";
export type {
  GitFailureReason,
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
export { GitComposition } from "./src/composition/git-api.ts";
export type { GitCompositionApi } from "./src/composition/git-api.ts";
export {
  gitSwitchResultJson,
  parseGitCheckoutIdentity,
  parseGitCheckoutState,
  parseGitSwitchResult,
} from "./src/composition/git-records.ts";
export type {
  GitCheckoutIdentity,
  GitCheckoutState,
  GitSwitchRequest,
  GitSwitchResult,
} from "./src/composition/git-records.ts";
export { useCompositionComponents } from "./src/composition/installation.ts";

export { Forge } from "./src/forge/api.ts";
export type { ForgeApi, ForgeProvider } from "./src/forge/api.ts";
export {
  ForgeAmbiguousError,
  ForgeConflictError,
  ForgeProtocolError,
  ForgeProviderError,
  ForgeUnavailableError,
} from "./src/forge/errors.ts";
export {
  completeForgeEffectRequestJson,
  forgeReconciliationRecordJson,
  parseCompleteForgeEffectRequest,
  parseForgeCompletion,
  parseForgeEffectIdentity,
  parseForgeObservation,
  parseForgeReconciliationRecord,
  sameCompleteForgeEffectRequest,
} from "./src/forge/records.ts";
export type {
  CompleteForgeEffectRequest,
  ForgeCompletion,
  ForgeDecision,
  ForgeEffectIdentity,
  ForgeEffectRequest,
  ForgeObservation,
  ForgeReconciliationRecord,
} from "./src/forge/records.ts";
export { reconcileForgeEffect, withForgeProvider } from "./src/forge/effect.ts";

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
  WorkflowLifecycleApi,
  WorkflowLifecycleSnapshot,
} from "./src/lifecycle/api.ts";
export { readEventSource } from "./src/lifecycle/history.ts";
export type { WorkflowHistoryEntry } from "./src/lifecycle/history.ts";

export { definitionToJson, parseWorkflowDefinition } from "./src/storage/definition.ts";
export type { GitWorkflowDefinitionV1, WorkflowDefinition } from "./src/storage/definition.ts";

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

export { SUSPENSION_REQUEST, suspendFor, suspensionId } from "./src/suspension/suspend.ts";
export {
  parseSuspensionRequest,
  WorkflowSuspension,
  WorkflowSuspensionProviderError,
  WorkflowSuspensionRequestError,
} from "./src/suspension/api.ts";
export type { WorkflowSuspensionApi, WorkflowSuspensionRequest } from "./src/suspension/api.ts";
