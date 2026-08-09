import { type Api, createApi } from "@effectionx/context-api";
import {
  type ActivateDurabilityFailure,
  type DurableEffect,
  type DurableStream,
  type EffectDescription,
  type Json,
  type LiveDurableOperationCoordinator,
  type Result as DurableResult,
  serializeError,
} from "@executablemd/durable-streams";
import { type Operation, scoped } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../../storage/api.ts";
import { WorkflowTransactionError } from "../../storage/errors.ts";
import { WorkspaceCoordination } from "../../workspace/api.ts";
import { createDurableWorkspaceOperation } from "../../workspace/effect.ts";
import type { WorkflowRunConnections } from "../connections.ts";
import { withEnlistedJournalRoute } from "../journal-route.ts";
import { savepoint } from "../transaction.ts";
import { isJournalableWorkspaceFailure } from "./errors.ts";
import type { DenoWorkspaceFilesystem } from "./filesystem.ts";
import {
  type PrivateWorkspaceTransaction,
  withPrivateWorkspaceTransaction,
  workflowRunTransactionToken,
} from "./private.ts";

export type DenoWorkspaceMutation<T extends Json> = (
  filesystem: DenoWorkspaceFilesystem,
) => Operation<T>;

interface WorkspaceMutationApi {
  run<T extends Json>(
    database: WorkflowRunDatabase,
    mutate: DenoWorkspaceMutation<T>,
  ): Operation<T>;
}

function unavailable(): never {
  throw new WorkflowTransactionError(
    "the Workspace effect is not bound to this active Deno WorkflowRun transaction.",
  );
}

const WorkspaceMutation: Api<WorkspaceMutationApi> = createApi<WorkspaceMutationApi>(
  "executablemd.workflow.deno.workspace.effect.mutation",
  {
    // deno-lint-ignore require-yield
    *run<T extends Json>(
      _database: WorkflowRunDatabase,
      _mutate: DenoWorkspaceMutation<T>,
    ): Operation<T> {
      return unavailable();
    },
  },
);

const workspaceEffectOwner = Symbol.for("executablemd.workflow.deno.workspace.effect.owner");

interface DenoWorkspaceCoordinationApi {
  bind<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T>;
}

const DenoWorkspaceCoordination: Api<DenoWorkspaceCoordinationApi> =
  createApi<DenoWorkspaceCoordinationApi>(
    "executablemd.workflow.deno.workspace.effect.coordination",
    {
      // deno-lint-ignore require-yield
      *bind<T>(_database: WorkflowRunDatabase, _operation: Operation<T>): Operation<T> {
        return unavailable();
      },
    },
  );

function* runMutation<T extends Json>(
  database: WorkflowRunDatabase,
  workspace: PrivateWorkspaceTransaction,
  execute: () => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    yield* WorkspaceMutation.around(
      {
        *run<Candidate extends Json>([candidate, mutate]: [
          WorkflowRunDatabase,
          DenoWorkspaceMutation<Candidate>,
        ]): Operation<Candidate> {
          if (candidate !== database) {
            return unavailable();
          }
          return yield* mutate(workspace.filesystem);
        },
      },
      { at: "min" },
    );
    return yield* execute();
  });
}

function* coordinateTransaction<T extends Json>(
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
  workspace: PrivateWorkspaceTransaction,
  execute: () => Operation<T>,
  publish: (result: DurableResult) => Operation<void>,
): Operation<DurableResult> {
  const token = yield* workflowRunTransactionToken(database, transaction);

  let result: DurableResult;
  try {
    const value = yield* savepoint(runMutation(database, workspace, execute));
    result = { status: "ok", value };
    const root = yield* workspace.capture();
    yield* workspace.publish(root.rootId);
  } catch (error) {
    if (!isJournalableWorkspaceFailure(error)) {
      throw error;
    }
    result = { status: "err", error: serializeError(error) };
  }

  yield* withEnlistedJournalRoute(database, transaction, token, publish(result));
  return result;
}

function coordinator(
  connections: WorkflowRunConnections,
  database: WorkflowRunDatabase,
): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: DurableResult) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
      stream: DurableStream,
    ): Operation<DurableResult> {
      let transacted;
      try {
        if (Reflect.get(execute, workspaceEffectOwner) !== database) {
          throw new WorkflowTransactionError(
            "the live Workspace effect is missing, foreign, completed, or stale for this WorkflowRun database.",
          );
        }
        connections.validateJournal(database, stream);
        transacted = yield* database.transact(function* (transaction) {
          return yield* withPrivateWorkspaceTransaction(database, transaction, (workspace) =>
            coordinateTransaction(database, transaction, workspace, execute, publish),
          );
        });
      } catch (error) {
        throw activateFailure(error);
      }
      if (!transacted.ok) {
        throw activateFailure(transacted.error);
      }
      return transacted.value;
    },
  };
}

export function useWorkspaceEffects(connections: WorkflowRunConnections): Operation<void> {
  return DenoWorkspaceCoordination.around(
    {
      *bind<T>([database, operation]: [WorkflowRunDatabase, Operation<T>]): Operation<T> {
        connections.validateLease(database);
        return yield* scoped(function* () {
          const selected = coordinator(connections, database);
          yield* WorkspaceCoordination.around(
            {
              *run<Candidate extends Json>([execute, publish, activateFailure, stream]: [
                () => Operation<Candidate>,
                (result: DurableResult) => Operation<void>,
                ActivateDurabilityFailure,
                DurableStream,
              ]): Operation<DurableResult> {
                return yield* selected.run(execute, publish, activateFailure, stream);
              },
            },
            { at: "min" },
          );
          return yield* operation;
        });
      },
    },
    { at: "min" },
  );
}

export function withWorkspaceEffects<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
): Operation<T> {
  return DenoWorkspaceCoordination.operations.bind(database, operation);
}

export function createWorkspaceProofEffect<T extends Json>(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  mutate: DenoWorkspaceMutation<T>,
): DurableEffect<T> {
  const execute = () => WorkspaceMutation.operations.run(database, mutate);
  Object.defineProperty(execute, workspaceEffectOwner, {
    configurable: false,
    enumerable: false,
    value: database,
    writable: false,
  });
  return createDurableWorkspaceOperation(description, execute);
}
