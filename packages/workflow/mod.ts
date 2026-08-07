/**
 * @module
 *
 * Workflow runs for Executable.md.
 *
 * A workflow run ties one run to a single pinned starting commit, recorded
 * durably before the root document is imported, so later document executions
 * and durable effects share one explicit identity.
 *
 * ```ts
 * import { useWorkflow } from "@executablemd/workflow";
 * import { execute } from "@executablemd/core";
 *
 * yield* useWorkflow({ base: "main" });
 * const execution = yield* execute({ path: "./workflow.md", stream });
 * ```
 */

export { Git, GitRevisionError, revParse } from "./src/git.ts";
export type { GitApi } from "./src/git.ts";
export { getWorkflowRun, useWorkflow } from "./src/run.ts";
export type { WorkflowRun } from "./src/run.ts";
