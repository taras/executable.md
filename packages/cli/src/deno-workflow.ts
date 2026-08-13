/**
 * The Deno workflow host — where `xmd workflow` keeps runs, and what it attaches.
 *
 * This is the only module in the CLI that names the local run store. SQLite,
 * DOFS and the path a run lives at are all behind `@executablemd/workflow/deno`,
 * and the shared command module reaches none of them: it asks a `WorkflowHost`
 * to open storage and to attach a run's Workspace, and this is what Deno and the
 * compiled binary supply. The binary is Deno too, so both entrypoints install
 * this one rather than each carrying a copy.
 *
 * Runs live beneath `~/.xmd/runs` by default. `XMD_WORKFLOW_RUNS` names a
 * different absolute directory, which is how a test — or a caller keeping one
 * project's runs apart from another's — works without the real user state
 * directory being involved at all.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Operation } from "effection";
import { env as readEnv } from "@executablemd/runtime";
import {
  useWorkflowLifecycle,
  useWorkflowRunHost,
  withWorkflowWorkspace,
} from "@executablemd/workflow/deno";
import type { WorkflowExecutionAuthority } from "@executablemd/workflow/deno";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import type { WorkflowHost } from "./workflow.ts";

/** Where a run lives when nothing says otherwise. */
export const DEFAULT_RUN_STORAGE_ROOT: string = join(homedir(), ".xmd", "runs");

/** The variable that names a different run store. Absolute, or it is refused. */
export const RUN_STORAGE_ROOT_ENV = "XMD_WORKFLOW_RUNS";

export function* useDenoWorkflowHost(): Operation<WorkflowHost> {
  const configured = yield* readEnv(RUN_STORAGE_ROOT_ENV);
  const root =
    configured === undefined || configured === "" ? DEFAULT_RUN_STORAGE_ROOT : configured;
  return {
    useRunHost(): Operation<WorkflowExecutionAuthority> {
      return useWorkflowRunHost({ root });
    },
    useLifecycle(): Operation<void> {
      return useWorkflowLifecycle({ root });
    },
    attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      return withWorkflowWorkspace(database, operation);
    },
  };
}
