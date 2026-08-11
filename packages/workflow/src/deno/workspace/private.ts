import { type Api, createApi } from "@effectionx/context-api";
import { type Operation, type Result, scoped } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../../storage/api.ts";
import { WorkflowTransactionError } from "../../storage/errors.ts";
import type { WorkflowRunConnections, WorkflowRunTransactionToken } from "../connections.ts";
import { createDenoWorkspaceFilesystem, type DenoWorkspaceFilesystem } from "./filesystem.ts";
import { type StoredWorkspaceRoot } from "./manifest.ts";
import {
  captureWorkspaceRoot,
  type CaptureWorkspaceRootOptions,
  currentWorkspaceRoot,
  setCurrentWorkspaceRoot,
  verifyWorkspace,
} from "./root.ts";
import { restoreWorkspaceRoot, type RestoreWorkspaceRootOptions } from "./restore.ts";

export interface PrivateWorkspaceTransaction {
  readonly filesystem: DenoWorkspaceFilesystem;
  currentRoot(): Operation<string>;
  capture(options?: CaptureWorkspaceRootOptions): Operation<StoredWorkspaceRoot>;
  publish(rootId: string): Operation<void>;
  restore(rootId: string, options?: RestoreWorkspaceRootOptions): Operation<StoredWorkspaceRoot>;
}

interface PrivateWorkspaceApi {
  transact<T>(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
    body: (workspace: PrivateWorkspaceTransaction) => Operation<T>,
  ): Operation<T>;
  setClock(database: WorkflowRunDatabase, now: () => number): void;
  issueToken(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
  ): WorkflowRunTransactionToken;
  validateToken(database: WorkflowRunDatabase, token: WorkflowRunTransactionToken): void;
}

function unavailable(): never {
  throw new WorkflowTransactionError(
    "the WorkflowRun handle is not owned by the active Deno storage provider.",
  );
}

/**
 * What decorates the filesystem a Workspace transaction hands its body.
 *
 * Dependency injection, deliberately, rather than anything a scope can reach.
 * It is supplied once when the storage provider is installed — before any
 * document exists — and lives in that provider's closure. There is no context
 * name to reconstruct, nothing is handed to a descendant, and no module-scoped
 * hook accumulates: a component cannot observe the authoritative filesystem,
 * and cannot put anything in front of it.
 *
 * It exists because a mutation discarded part-way through cannot otherwise be
 * observed. A write creates the parent directories it needs and then writes the
 * file, and DOFS has no condition that stops between the two — a parent chain
 * that can be created is a chain the file can then be written into.
 */
export type WorkspaceFilesystemDecorator = (
  filesystem: DenoWorkspaceFilesystem,
) => DenoWorkspaceFilesystem;

export interface PrivateWorkspaceOptions {
  readonly decorateFilesystem?: WorkspaceFilesystemDecorator;
}

const PrivateWorkspace: Api<PrivateWorkspaceApi> = createApi<PrivateWorkspaceApi>(
  "executablemd.workflow.deno.workspace.private",
  {
    // deno-lint-ignore require-yield
    *transact<T>(
      _database: WorkflowRunDatabase,
      _transaction: WorkflowRunTransaction,
      _body: (workspace: PrivateWorkspaceTransaction) => Operation<T>,
    ): Operation<T> {
      return unavailable();
    },
    setClock(_database: WorkflowRunDatabase, _now: () => number): void {
      unavailable();
    },
    issueToken(
      _database: WorkflowRunDatabase,
      _transaction: WorkflowRunTransaction,
    ): WorkflowRunTransactionToken {
      return unavailable();
    },
    validateToken(_database: WorkflowRunDatabase, _token: WorkflowRunTransactionToken): void {
      unavailable();
    },
  },
);

export function usePrivateWorkspace(
  connections: WorkflowRunConnections,
  options: PrivateWorkspaceOptions = {},
): Operation<void> {
  const decorate = options.decorateFilesystem ?? ((filesystem) => filesystem);
  return PrivateWorkspace.around(
    {
      *transact<T>([database, transaction, body]: [
        WorkflowRunDatabase,
        WorkflowRunTransaction,
        (workspace: PrivateWorkspaceTransaction) => Operation<T>,
      ]): Operation<T> {
        const active = connections.authorizeTransaction(database, transaction);
        const connection = active.lease?.connection;
        if (connection === undefined) {
          return unavailable();
        }
        const authorize = () => {
          connections.authorizeTransaction(database, transaction);
        };
        const workspace: PrivateWorkspaceTransaction = {
          filesystem: decorate(createDenoWorkspaceFilesystem(connection, authorize)),

          // deno-lint-ignore require-yield
          *currentRoot(): Operation<string> {
            authorize();
            return currentWorkspaceRoot(connection.database, connection.path);
          },

          // deno-lint-ignore require-yield
          *capture(options = {}): Operation<StoredWorkspaceRoot> {
            authorize();
            return captureWorkspaceRoot(connection, active, options);
          },

          // deno-lint-ignore require-yield
          *publish(rootId: string): Operation<void> {
            authorize();
            setCurrentWorkspaceRoot(connection.database, rootId, connection.path);
          },

          // deno-lint-ignore require-yield
          *restore(rootId, options = {}): Operation<StoredWorkspaceRoot> {
            authorize();
            return restoreWorkspaceRoot(connection, active, rootId, options);
          },
        };

        const value = yield* scoped(function* () {
          return yield* body(workspace);
        });
        authorize();
        verifyWorkspace(connection.database, connection.dofs, connection.path);
        return value;
      },

      setClock([database, now]: [WorkflowRunDatabase, () => number]): void {
        connections.validateLease(database).connection.setClock(now);
      },

      issueToken([database, transaction]: [
        WorkflowRunDatabase,
        WorkflowRunTransaction,
      ]): WorkflowRunTransactionToken {
        return connections.issueToken(database, transaction);
      },

      validateToken([database, token]: [WorkflowRunDatabase, WorkflowRunTransactionToken]): void {
        connections.validateToken(database, token);
      },
    },
    { at: "min" },
  );
}

export function* transactWorkspaceRoots<T>(
  database: WorkflowRunDatabase,
  body: (workspace: PrivateWorkspaceTransaction) => Operation<T>,
): Operation<Result<T>> {
  return yield* database.transact(function* (transaction) {
    return yield* withPrivateWorkspaceTransaction(database, transaction, body);
  });
}

export function withPrivateWorkspaceTransaction<T>(
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
  body: (workspace: PrivateWorkspaceTransaction) => Operation<T>,
): Operation<T> {
  return PrivateWorkspace.operations.transact(database, transaction, body);
}

export function setPrivateWorkspaceClock(
  database: WorkflowRunDatabase,
  now: () => number,
): Operation<void> {
  return PrivateWorkspace.operations.setClock(database, now);
}

export function workflowRunTransactionToken(
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
): Operation<WorkflowRunTransactionToken> {
  return PrivateWorkspace.operations.issueToken(database, transaction);
}

export function validateWorkflowRunTransactionToken(
  database: WorkflowRunDatabase,
  token: WorkflowRunTransactionToken,
): Operation<void> {
  return PrivateWorkspace.operations.validateToken(database, token);
}
