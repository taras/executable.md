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
export type {
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
export type { WorkflowDefinitionSourceReader } from "./src/deno/artifact/source.ts";
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
// The narrow one, under the name a host already knows. The function beside it
// in `workspace/host.ts` accepts the leaf substitutions a suite needs — the Git
// subprocess, the temporary directory, the Git-host transport — and a
// `RepositoryHost` sees every `GitInvocation`, attachment included. A package
// that could install one could read the credential this adapter is holding, so
// none of that crosses this entrypoint; the suites that need it import from
// source, inside the package.
export {
  GITHUB as GITHUB_PULL_REQUEST_PROVIDER,
  parseGitHubPullRequestUrl,
  pullRequestAllowed,
  recognizesGitHubPullRequestUrl,
  useGitHubPullRequests,
} from "./src/deno/composition/pull-request-reads.ts";
export type { GitHubPullRequestsOptions } from "./src/deno/composition/pull-request-reads.ts";
export { withWorkflowWorkspace } from "./src/deno/workspace/published.ts";
/**
 * What a host declares to the execution so an authored workflow document has
 * `<Evaluate>`: its implementation names durable work after its own invocation,
 * so canonical execution builds it from the claimant it minted.
 */
export { evaluationComponents } from "./src/deno/workspace/evaluate.ts";
export type { GeneratedEvaluationOptions } from "./src/deno/workspace/evaluate.ts";
export type { WorkflowWorkspaceOptions } from "./src/deno/workspace/published.ts";
export type { WorkflowAgentAttachment, WorkflowAgentInstaller } from "./src/deno/workspace/host.ts";
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
