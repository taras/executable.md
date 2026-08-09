import { type Api, createApi } from "@effectionx/context-api";
import {
  type DurableEffect,
  type EffectDescription,
  type Json,
  type Result as DurableResult,
  serializeError,
} from "@executablemd/durable-streams";
import { ensure, type Operation, scoped } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../../storage/api.ts";
import { WorkflowTransactionError } from "../../storage/errors.ts";
import {
  createOwnedDurableWorkspaceOperation,
  type WorkspaceCoordinationAuthority,
  type WorkspaceCoordinationInvocation,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationInvocation,
  withWorkspaceCoordinationProvider,
} from "../../workspace/effect.ts";
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

const workspaceEffectOwners = (() => {
  const owners = new WeakMap<object, WorkflowRunDatabase>();
  return {
    claim(execute: object, database: WorkflowRunDatabase): void {
      owners.set(execute, database);
    },

    get(execute: object): WorkflowRunDatabase | undefined {
      return owners.get(execute);
    },
  };
})();

interface WorkspaceEffectProviderApi {
  readonly provider: object | undefined;
}

interface WorkspaceEffectProviderRegistration {
  open: boolean;
  readonly connections: WorkflowRunConnections;
}

const WorkspaceEffectProvider: Api<WorkspaceEffectProviderApi> =
  createApi<WorkspaceEffectProviderApi>("executablemd.workflow.deno.workspace.effect.provider", {
    provider: undefined,
  });

const workspaceEffectProviders = (() => {
  const providers = new WeakMap<object, WorkspaceEffectProviderRegistration>();

  return {
    register(connections: WorkflowRunConnections): {
      selection: object;
      close: () => void;
    } {
      const selection = Object.freeze({});
      const registration: WorkspaceEffectProviderRegistration = { open: true, connections };
      providers.set(selection, registration);
      return {
        selection,
        close(): void {
          registration.open = false;
          providers.delete(selection);
        },
      };
    },

    get(selection: object): WorkflowRunConnections | undefined {
      const registration = providers.get(selection);
      return registration?.open ? registration.connections : undefined;
    },
  };
})();

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
): WorkspaceCoordinationProvider {
  return {
    *run(invocation: WorkspaceCoordinationInvocation): Operation<DurableResult> {
      return yield* withWorkspaceCoordinationInvocation(
        invocation,
        function* (authority: WorkspaceCoordinationAuthority): Operation<DurableResult> {
          let transacted;
          try {
            if (workspaceEffectOwners.get(authority.executionIdentity) !== database) {
              throw new WorkflowTransactionError(
                "the live Workspace effect is missing, foreign, completed, or stale for this WorkflowRun database.",
              );
            }
            connections.validateJournal(database, authority.publicationIdentity);
            transacted = yield* database.transact(function* (transaction) {
              return yield* withPrivateWorkspaceTransaction(database, transaction, (workspace) =>
                coordinateTransaction(
                  database,
                  transaction,
                  workspace,
                  authority.execute,
                  authority.publish,
                ),
              );
            });
          } catch (error) {
            throw authority.activateFailure(error);
          }
          if (!transacted.ok) {
            throw authority.activateFailure(transacted.error);
          }
          return transacted.value;
        },
      );
    },
  };
}

export function* useWorkspaceEffects(connections: WorkflowRunConnections): Operation<void> {
  const registration = workspaceEffectProviders.register(connections);
  yield* ensure(registration.close);
  yield* WorkspaceEffectProvider.around({ provider: () => registration.selection }, { at: "min" });
}

export function withWorkspaceEffects<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const selection = yield* WorkspaceEffectProvider.operations.provider;
    const connections =
      selection === undefined ? undefined : workspaceEffectProviders.get(selection);
    if (connections === undefined) {
      return unavailable();
    }
    connections.validateLease(database);
    return yield* withWorkspaceCoordinationProvider(coordinator(connections, database), operation);
  });
}

export function createWorkspaceProofEffect<T extends Json>(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  mutate: DenoWorkspaceMutation<T>,
): DurableEffect<T> {
  const execute = () => WorkspaceMutation.operations.run(database, mutate);
  const executionIdentity = Object.freeze({});
  workspaceEffectOwners.claim(executionIdentity, database);
  return createOwnedDurableWorkspaceOperation(description, execute, executionIdentity);
}
