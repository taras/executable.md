import { type Api, createApi } from "@effectionx/context-api";
import {
  type ActivateDurabilityFailure,
  type DurableEffect,
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

export type WorkspaceEffectPhase =
  | "transaction-open"
  | "before-mutation"
  | "mutation-complete"
  | "mutation-rolled-back"
  | "root-published"
  | "before-publication"
  | "publication-complete"
  | "before-commit";

interface WorkspaceEffectPhaseApi {
  reach(phase: WorkspaceEffectPhase): Operation<void>;
}

export const WorkspaceEffectPhases: Api<WorkspaceEffectPhaseApi> =
  createApi<WorkspaceEffectPhaseApi>("executablemd.workflow.deno.workspace.effect.phases", {
    // deno-lint-ignore require-yield
    *reach(_phase: WorkspaceEffectPhase): Operation<void> {
      return undefined;
    },
  });

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
  yield* WorkspaceEffectPhases.operations.reach("transaction-open");
  yield* WorkspaceEffectPhases.operations.reach("before-mutation");

  let result: DurableResult;
  try {
    const value = yield* savepoint(runMutation(database, workspace, execute));
    yield* WorkspaceEffectPhases.operations.reach("mutation-complete");
    result = { status: "ok", value };
    yield* workspace.capture({ publish: true });
    yield* WorkspaceEffectPhases.operations.reach("root-published");
  } catch (error) {
    if (!isJournalableWorkspaceFailure(error)) {
      throw error;
    }
    result = { status: "err", error: serializeError(error) };
    yield* WorkspaceEffectPhases.operations.reach("mutation-rolled-back");
  }

  yield* WorkspaceEffectPhases.operations.reach("before-publication");
  yield* withEnlistedJournalRoute(database, transaction, token, publish(result));
  yield* WorkspaceEffectPhases.operations.reach("publication-complete");
  yield* WorkspaceEffectPhases.operations.reach("before-commit");
  return result;
}

function coordinator(database: WorkflowRunDatabase): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: DurableResult) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
    ): Operation<DurableResult> {
      let transacted;
      try {
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

export function useDenoWorkspaceEffectCoordination(
  connections: WorkflowRunConnections,
): Operation<void> {
  return DenoWorkspaceCoordination.around(
    {
      *bind<T>([database, operation]: [WorkflowRunDatabase, Operation<T>]): Operation<T> {
        connections.validateLease(database);
        return yield* scoped(function* () {
          const selected = coordinator(database);
          yield* WorkspaceCoordination.around(
            {
              *run<Candidate extends Json>([execute, publish, activateFailure]: [
                () => Operation<Candidate>,
                (result: DurableResult) => Operation<void>,
                ActivateDurabilityFailure,
              ]): Operation<DurableResult> {
                return yield* selected.run(execute, publish, activateFailure);
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

export function withDenoWorkspaceEffectCoordination<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
): Operation<T> {
  return DenoWorkspaceCoordination.operations.bind(database, operation);
}

export function createDenoWorkspaceOperation<T extends Json>(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  mutate: DenoWorkspaceMutation<T>,
): DurableEffect<T> {
  return createDurableWorkspaceOperation(description, () =>
    WorkspaceMutation.operations.run(database, mutate),
  );
}
