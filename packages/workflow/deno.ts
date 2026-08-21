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
export { withWorkflowWorkspace } from "./src/deno/workspace/host.ts";
export type { WorkflowWorkspaceOptions } from "./src/deno/workspace/host.ts";
export {
  WORKSPACE_GIT_ADD,
  WORKSPACE_GIT_SWITCH,
  WORKSPACE_REPOSITORY,
  WORKSPACE_WORKTREE,
} from "./src/deno/composition/provider.ts";
export type {
  CompositionObserver,
  CompositionProviderOptions,
} from "./src/deno/composition/provider.ts";
export { denoRepositoryHost } from "./src/deno/composition/host.ts";
export {
  GITHUB,
  parseGitHubIssueTarget,
  recognizesGitHubUrl,
  useGitHubIssues,
} from "./src/deno/issue/github.ts";
export type { GitHubIssuesOptions } from "./src/deno/issue/github.ts";
export type { GitInvocation, GitOutcome, RepositoryHost } from "./src/deno/composition/host.ts";
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

/**
 * The provider-owned credential helper: its assembly, and its internal mode.
 *
 * Exported so a runtime entrypoint can state what it is and offer the mode, not
 * so anyone can call it. The mode appears in no help and in no public grammar,
 * is dispatched before anything public is parsed, and can acquire nothing on its
 * own.
 */
export {
  HELPER_MODE,
  helperCommand,
  launcherName,
  launcherProgram,
  isCredentialHelperMode,
  runCredentialHelper,
} from "./src/deno/composition/credential-helper.ts";
export type {
  HelperAssembly,
  HelperPlatform,
  HelperRuntime,
} from "./src/deno/composition/credential-helper.ts";
