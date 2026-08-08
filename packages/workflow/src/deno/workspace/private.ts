import { type Operation, type Result } from "effection";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { workflowRunConnection } from "../database.ts";
import { createDenoWorkspaceFilesystem, type DenoWorkspaceFilesystem } from "./filesystem.ts";
import { type StoredWorkspaceRoot } from "./manifest.ts";
import {
  captureWorkspaceRoot,
  type CaptureWorkspaceRootOptions,
  currentWorkspaceRoot,
  verifyWorkspace,
} from "./root.ts";
import { restoreWorkspaceRoot, type RestoreWorkspaceRootOptions } from "./restore.ts";

export interface PrivateWorkspaceTransaction {
  readonly filesystem: DenoWorkspaceFilesystem;
  currentRoot(): Operation<string>;
  capture(options?: CaptureWorkspaceRootOptions): Operation<StoredWorkspaceRoot>;
  restore(rootId: string, options?: RestoreWorkspaceRootOptions): Operation<StoredWorkspaceRoot>;
}

export function* transactWorkspaceRoots<T>(
  database: WorkflowRunDatabase,
  body: (workspace: PrivateWorkspaceTransaction) => Operation<T>,
): Operation<Result<T>> {
  const connection = workflowRunConnection(database);
  return yield* database.transact(function* () {
    const workspace: PrivateWorkspaceTransaction = {
      filesystem: createDenoWorkspaceFilesystem(connection),

      // deno-lint-ignore require-yield
      *currentRoot(): Operation<string> {
        return currentWorkspaceRoot(connection.database, connection.path);
      },

      // deno-lint-ignore require-yield
      *capture(options = {}): Operation<StoredWorkspaceRoot> {
        return captureWorkspaceRoot(connection, options);
      },

      // deno-lint-ignore require-yield
      *restore(rootId, options = {}): Operation<StoredWorkspaceRoot> {
        return restoreWorkspaceRoot(connection, rootId, options);
      },
    };
    const value = yield* body(workspace);
    verifyWorkspace(connection.database, connection.dofs, connection.path);
    return value;
  });
}

export function setPrivateWorkspaceClock(database: WorkflowRunDatabase, now: () => number): void {
  workflowRunConnection(database).setClock(now);
}
