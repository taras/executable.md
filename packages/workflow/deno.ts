/**
 * @module
 *
 * The Deno host's workflow-run storage.
 *
 * Keeping this behind its own entrypoint is what lets the shared package stay
 * provider-neutral. SQLite, run-id hashing, filesystem paths and Deno's own
 * behavior live here and nowhere above; `@executablemd/workflow` names none of
 * them, so another host can implement the same contract without this module
 * being loaded at all.
 *
 * ```ts
 * import { useWorkflowRunStorage } from "@executablemd/workflow/deno";
 * import { WorkflowRunStorage } from "@executablemd/workflow";
 *
 * yield* useWorkflowRunStorage({ root: runsDirectory });
 *
 * const opened = yield* WorkflowRunStorage.operations.create({
 *   runId,
 *   definition,
 *   base: "main",
 *   props: {},
 * });
 * ```
 */

export { useWorkflowRunStorage } from "./src/deno/provider.ts";
export type { WorkflowRunStorageOptions } from "./src/deno/provider.ts";
export { useWorkflowLifecycle } from "./src/deno/lifecycle.ts";
export { useWorkflowRunHost } from "./src/deno/run-host.ts";
export type { WorkflowRunHostOptions } from "./src/deno/run-host.ts";
export { isGitWorkflowRunCreation } from "./src/lifecycle/execution.ts";
export type {
  GitWorkflowRunCreationV1,
  SourceBundleWorkflowRunCreationV2,
  WorkflowBeginRequest,
  WorkflowExecutionTransitions,
  WorkflowExecutionBegun,
  WorkflowForkRequest,
  WorkflowForkSelection,
  WorkflowRunCreation,
} from "./src/lifecycle/execution.ts";
export type { WorkflowLifecycleOptions } from "./src/deno/lifecycle.ts";
/**
 * How a host reads a retained definition's Markdown back, and the closure it
 * returns.
 *
 * Published here rather than from the package root because these describe what
 * this adapter retains: a closure is checked against DOFS and SQLite rows, and
 * the reader is installed into this provider. The encoding stays private —
 * nothing that reads or writes a container is exported from any entrypoint.
 */
export { gitBlobIdentity } from "./src/deno/artifact/source.ts";
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
export type {
  DetachedXmdArtifact,
  VerifiedXmdArtifact,
  XmdArtifactDefinitionClosure,
  XmdArtifactDefinitionComponent,
  XmdArtifactDefinitionRoot,
} from "./src/deno/artifact/types.ts";
export {
  hashRunId,
  workflowForkStaging,
  workflowRunLock,
  workflowRunPath,
} from "./src/deno/path.ts";
export { APPLICATION_ID, SCHEMA_VERSION } from "./src/deno/schema.ts";
/**
 * The advisory file lock this adapter coordinates run ownership through.
 *
 * Published because a feature that keeps its own checkouts beside a run needs
 * the same mutual exclusion this package uses for executors, and two lock
 * implementations over one directory would be two answers to who holds it.
 */
export { useAdvisoryLock } from "./src/deno/advisory-lock.ts";
export type { AdvisoryLockFile } from "./src/deno/advisory-lock.ts";
// The narrow one, under the name a host already knows. The function beside it
// in `workspace/host.ts` accepts the leaf substitutions a suite needs — the Git
// subprocess, the temporary directory, the Git-host transport — and a
// `RepositoryHost` sees every `GitInvocation`, attachment included. A package
// that could install one could read the credential this adapter is holding, so
// none of that crosses this entrypoint; the suites that need it import from
// source, inside the package.
export { withWorkflowWorkspace } from "./src/deno/workspace/published.ts";
/**
 * One durable effect inside this run's Workspace transaction.
 *
 * The boundary a feature outside this package performs a Workspace-coordinated
 * mutation through. It receives the authoritative filesystem and a storage view
 * valid only while it runs; the lease, the transaction and savepoint, the root
 * capture and publication, the journal enlistment and the rollback are this
 * package's and are not projected through it.
 */
export { createWorkflowWorkspaceEffect } from "./src/deno/workspace/effect.ts";
export type {
  WorkflowWorkspaceMutation,
  WorkflowWorkspaceTransaction,
} from "./src/deno/workspace/effect.ts";
/**
 * Reading the Workspace, at the current root or at one this run retains.
 *
 * The other half of the same boundary, for work that exports a checkout or
 * proves a record still describes what is there. It journals nothing, publishes
 * nothing, and can write neither bytes nor rows; a retained root is
 * materialized inside a rollback-only savepoint this package owns and is always
 * taken back.
 */
export { readWorkflowWorkspace } from "./src/deno/workspace/inspect.ts";
export type {
  WorkflowWorkspaceReadOptions,
  WorkflowWorkspaceReads,
  WorkflowWorkspaceSnapshot,
} from "./src/deno/workspace/inspect.ts";
export type {
  WorkflowWorkspaceParameter,
  WorkflowWorkspaceReadStorage,
  WorkflowWorkspaceRow,
  WorkflowWorkspaceStorage,
} from "./src/deno/workspace/storage.ts";
/**
 * The Workspace filesystem a mutation writes through, under names a package
 * outside this one can spell.
 */
export type {
  DenoWorkspaceEntry as WorkflowWorkspaceEntry,
  DenoWorkspaceFilesystem as WorkflowWorkspaceFilesystem,
  DenoWorkspaceStat as WorkflowWorkspaceStat,
} from "./src/deno/workspace/filesystem.ts";
/**
 * Whether a failure is the effect's own durable outcome or the run failing.
 *
 * The base class is what a feature extends to declare that its refusal is
 * publishable; the predicate is how that feature tells a Workspace condition it
 * may journal from infrastructure it may not. Both are generic: neither knows
 * what any feature's refusal means.
 */
export {
  JournaledEffectFailure,
  isJournalableWorkspaceFailure,
} from "./src/deno/workspace/errors.ts";
/**
 * What a host declares to the execution so an authored workflow document has
 * `<Evaluate>`: its implementation names durable work after its own invocation,
 * so canonical execution builds it from the claimant it minted.
 */
export { evaluationProfile } from "./src/deno/workspace/evaluate.ts";
export type { GeneratedEvaluationOptions } from "./src/deno/workspace/evaluate.ts";
export type { WorkflowWorkspaceOptions } from "./src/deno/workspace/published.ts";
export type {
  WorkflowAgentAttachment,
  WorkflowAgentInstaller,
  WorkflowWorkspaceAttachment,
  WorkflowWorkspaceInstaller,
} from "./src/deno/workspace/host.ts";
export {
  providerSessionDirectory,
  removeProviderSessions,
  useEmptyDirectory,
  useProviderSessions,
  workflowProviderSessions,
} from "./src/deno/provider-sessions.ts";
export type { ProviderSessionPaths } from "./src/deno/provider-sessions.ts";
export {
  agentSessionKey,
  resolveAgentSession,
  WorkflowAgentSessionError,
} from "./src/deno/workspace/agent-sessions.ts";
export type {
  AgentSessionIdentity,
  AgentSessionRecord,
  AgentSessionResolution,
  ProviderAssertion,
} from "./src/deno/workspace/agent-sessions.ts";
export { transactAgentSessions } from "./src/deno/workspace/private.ts";
export type { AgentSessions } from "./src/deno/workspace/agent-sessions.ts";
export { createWorkflowPromptPublisher } from "./src/deno/agent-publication.ts";
export type {
  RetainedSessionKey,
  WorkflowPromptPublisherOptions,
} from "./src/deno/agent-publication.ts";
export { transactAgentPromptCheckpoints } from "./src/deno/workspace/private.ts";
export type {
  AgentPromptCheckpoints,
  AgentPromptCheckpointRecord,
} from "./src/deno/workspace/agent-checkpoints.ts";
export { WORKSPACE_FILE } from "./src/deno/workspace/files.ts";
export { WORKSPACE_ROOT } from "./src/deno/workspace/logical-path.ts";
export { useWorkflowInputDelivery } from "./src/deno/delivery.ts";
export type { WorkflowInputDeliveryOptions } from "./src/deno/delivery.ts";
export { createSuspensionController } from "./src/deno/suspension.ts";
export type {
  SuspensionController,
  SuspensionControllerOptions,
  SuspensionNotice,
} from "./src/deno/suspension.ts";
