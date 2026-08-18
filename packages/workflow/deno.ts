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
  WorkflowRunCreation,
} from "./src/lifecycle/execution.ts";
export type { WorkflowLifecycleOptions } from "./src/deno/lifecycle.ts";
export { hashRunId, workflowRunLock, workflowRunPath } from "./src/deno/path.ts";
export { APPLICATION_ID, SCHEMA_VERSION } from "./src/deno/schema.ts";
export { withWorkflowWorkspace } from "./src/deno/workspace/host.ts";
export type { WorkflowWorkspaceOptions } from "./src/deno/workspace/host.ts";
export { WORKSPACE_REPOSITORY, WORKSPACE_WORKTREE } from "./src/deno/composition/provider.ts";
export type {
  CompositionObserver,
  CompositionProviderOptions,
} from "./src/deno/composition/provider.ts";
export { denoRepositoryHost } from "./src/deno/composition/host.ts";
export type { GitInvocation, GitOutcome, RepositoryHost } from "./src/deno/composition/host.ts";
export { WORKSPACE_FILE } from "./src/deno/workspace/files.ts";
export { WORKSPACE_ROOT } from "./src/deno/workspace/logical-path.ts";
export { createSuspensionController } from "./src/deno/suspension.ts";
export type {
  SuspensionController,
  SuspensionControllerOptions,
  SuspensionNotice,
} from "./src/deno/suspension.ts";
