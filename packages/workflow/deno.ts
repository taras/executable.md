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
export { withWorkflowWorkspace } from "./src/deno/workspace/published.ts";
export type { WorkflowWorkspaceOptions } from "./src/deno/workspace/published.ts";
export type { WorkflowAgentAttachment, WorkflowAgentInstaller } from "./src/deno/workspace/host.ts";
export {
  providerSessionDirectory,
  providerSessionPaths,
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
export { transactWorkspaceRoots } from "./src/deno/workspace/private.ts";
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
