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
  type WorkspaceEffectExecution,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationProvider,
} from "../../workspace/effect.ts";
import type { WorkflowRunConnections } from "../connections.ts";
import { withEnlistedJournalRoute } from "../journal-route.ts";
import { currentWorkspaceRoot, retainedWorkspaceRoots } from "./root.ts";
import { savepoint } from "../transaction.ts";
import { isJournaledEffectFailure } from "./errors.ts";
import type { DenoWorkspaceFilesystem } from "./filesystem.ts";
import { guardedWorkflowWorkspaceStorage, type WorkflowWorkspaceStorage } from "./storage.ts";
import { gatedOperation, guardedWorkflowWorkspaceFilesystem, revocation } from "./guard.ts";
import {
  type PrivateWorkspaceTransaction,
  withPrivateWorkspaceTransaction,
  workflowRunTransactionToken,
} from "./private.ts";

/**
 * What a Workspace mutation is given.
 *
 * The authoritative filesystem first, because most mutations are only about
 * bytes. The run's own storage follows it, in the same transaction, so a
 * mutation that needs both commits both or neither.
 *
 * Three members and no more. There is no database connection here, no lease, no
 * journal route and no transaction token: what a feature owns is the meaning of
 * the rows it writes, and everything that decides whether those rows may be
 * written at all stays on Workflow's side of this call.
 */
export interface WorkflowWorkspaceTransaction {
  readonly filesystem: DenoWorkspaceFilesystem;
  /**
   * This run's storage, for as long as the mutation that received it is running.
   *
   * Revoked when the callback returns, before the root is captured and
   * published. A view a mutation kept is therefore an object that answers
   * nothing rather than a way into the transaction that is still open around it.
   */
  readonly storage: WorkflowWorkspaceStorage;
  /**
   * Run `body` inside a nested savepoint of this same transaction.
   *
   * What lets a mutation discard an attempt without discarding the effect. A
   * failure rolls back everything the body wrote — bytes and rows together —
   * and propagates, leaving this transaction open and still able to publish the
   * failed result the attempt became. Bound to this transaction rather than
   * resolved from the scope, so it is the mutation's own savepoint and ends
   * with the mutation.
   */
  savepoint<T>(body: Operation<T>): Operation<T>;
}

/** What a feature performs inside one Workspace effect's transaction. */
export type WorkflowWorkspaceMutation<T extends Json> = (
  transaction: WorkflowWorkspaceTransaction,
) => Operation<T>;

interface WorkspaceMutationApi {
  run<T extends Json>(
    database: WorkflowRunDatabase,
    mutate: WorkflowWorkspaceMutation<T>,
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
      _mutate: WorkflowWorkspaceMutation<T>,
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
          WorkflowWorkspaceMutation<Candidate>,
        ]): Operation<Candidate> {
          if (candidate !== database) {
            return unavailable();
          }
          // Ended on every path out, including a refusal that becomes this
          // effect's failed durable outcome: the transaction stays open past
          // this call to capture and publish a root, and a view that outlived
          // the callback would still be inside it.
          const gate = revocation();
          try {
            return yield* mutate({
              // The filesystem is wrapped rather than handed over: it is the
              // one capability here that writes, and a mutation that kept it
              // would be holding a live writer inside a transaction that is
              // still capturing and publishing a root.
              filesystem: guardedWorkflowWorkspaceFilesystem(workspace.filesystem, gate.held),
              storage: guardedWorkflowWorkspaceStorage(workspace.storage, gate.held),
              savepoint<Nested>(body: Operation<Nested>): Operation<Nested> {
                return gatedOperation(gate.held, () => workspace.savepoint(body));
              },
            });
          } finally {
            gate.revoke();
          }
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
    if (!isJournaledEffectFailure(error)) {
      throw error;
    }
    // No `publish` on this path, deliberately: a failed effect leaves the
    // Workspace root exactly where it found it, and the savepoint above has
    // already taken back whatever the attempt had written.
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
    *run(execution: WorkspaceEffectExecution): Operation<DurableResult> {
      let transacted;
      try {
        if (workspaceEffectOwners.get(execution.executionIdentity) !== database) {
          throw new WorkflowTransactionError(
            "the live Workspace effect is missing, foreign, completed, or stale for this WorkflowRun database.",
          );
        }
        connections.validateJournalProvenance(database, execution.journalProvenance);
        transacted = yield* database.transact(function* (transaction) {
          return yield* withPrivateWorkspaceTransaction(database, transaction, (workspace) =>
            coordinateTransaction(
              database,
              transaction,
              workspace,
              execution.execute,
              execution.publish,
            ),
          );
        });
      } catch (error) {
        throw yield* execution.activateFailure(error);
      }
      if (!transacted.ok) {
        throw yield* execution.activateFailure(transacted.error);
      }
      return transacted.value;
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

/**
 * Which Workspace roots this run has, and which one it is on right now.
 *
 * Read through the same lease the run's Workspace effects are bound to, so what
 * it answers is this run's authoritative storage rather than anything a scope
 * could put in front of it. Deliberately the two facts and nothing else: a
 * caller that needs a ceiling gets the ceiling, not a connection it could take
 * the rest of the run apart with.
 *
 * Read outside a transaction on purpose. This is a ceiling stated before a
 * fragment is admitted, and opening a transaction to state it would nest inside
 * the ones the admitted observations go on to open.
 */
export function* workspaceRootSelection(
  database: WorkflowRunDatabase,
): Operation<{ roots: string[]; current: string }> {
  const selection = yield* WorkspaceEffectProvider.operations.provider;
  const connections = selection === undefined ? undefined : workspaceEffectProviders.get(selection);
  if (connections === undefined) {
    return unavailable();
  }
  const lease = connections.validateLease(database);
  const { database: storage, path } = lease.connection;
  return {
    roots: retainedWorkspaceRoots(storage),
    current: currentWorkspaceRoot(storage, path),
  };
}

/**
 * One durable effect performed inside this run's Workspace transaction.
 *
 * The trusted boundary a feature outside this package reaches: it states what
 * the effect is and what to do, and Workflow supplies the authenticated lease,
 * the transaction and savepoint, the Workspace capture and publication, the
 * journal enlistment and the rollback. A mutation that refuses leaves the
 * Workspace root exactly where it found it.
 */
export function createWorkflowWorkspaceEffect<T extends Json>(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  mutate: WorkflowWorkspaceMutation<T>,
): DurableEffect<T> {
  const execute = () => WorkspaceMutation.operations.run(database, mutate);
  const executionIdentity = Object.freeze({});
  workspaceEffectOwners.claim(executionIdentity, database);
  return createOwnedDurableWorkspaceOperation(description, execute, executionIdentity);
}
