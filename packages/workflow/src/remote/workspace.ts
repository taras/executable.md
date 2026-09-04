/**
 * Running Workspace work on the runner, against a run the owner holds.
 *
 * The Deno coordinator opens a transaction, hands a mutation the authoritative
 * filesystem and the retained metadata, and commits both together. This is the
 * same shape with the storage somewhere else: the Workspace is a real directory
 * this invocation materialized from the exact admitted root, the metadata is a
 * detached snapshot of that same admitted state, and "commit" is one intent the
 * owner performs atomically or not at all.
 *
 * The ordering is the whole of the correctness argument, so it is written out
 * rather than implied:
 *
 * 1. The execution identity is claimed by one database before any effect is
 *    created, so a foreign or reused one cannot coordinate.
 * 2. One coherent snapshot is admitted: root, journal anchor and mappings
 *    together, because they are one state.
 * 3. The accepted tree and the disposable attempt are created *outside* the
 *    transaction, because the collector seals the attempt after the transaction
 *    body has torn down — an attempt scoped to the body would be gone by then.
 * 4. Inside the exact transaction callback, the route proves it starts from the
 *    admitted state. Drift refuses here, before the document runs and before
 *    anything is sent.
 * 5. The document runs once. A documented Workspace failure is the effect's own
 *    result and journals against the unchanged root; everything else is the run
 *    failing and publishes nothing.
 * 6. Only a successful result enlists the attempt and its staged deltas, and
 *    the publication is routed into this exact transaction's journal.
 * 7. The collector seals, sends, and transfers the tree only on the exact
 *    performed answer.
 */

import { type Api, createApi } from "@effectionx/context-api";
import {
  createOwnedDurableWorkspaceOperation,
  type WorkspaceCoordinationAuthority,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationProvider,
} from "../workspace/effect.ts";
import {
  type DurableEffect,
  type EffectDescription,
  type Json,
  type JournalProvenance,
  type Result as DurableResult,
  serializeError,
} from "@executablemd/durable-streams";
import { ensure, type Operation, scoped } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";
import { WorkflowTransactionError } from "../storage/errors.ts";
import type { WorkspaceFilesystem } from "../workspace/filesystem.ts";
import { isJournaledEffectFailure } from "../workspace/failure.ts";
import type { WorkspaceMetadata } from "../workspace/metadata.ts";
import type { AgentSessions } from "../storage/agent-session.ts";
import { activeWorkspaceRoute, type WorkspaceRoute } from "./database.ts";
import { createInvocationMappings } from "./mappings.ts";
import {
  type Attempt,
  type Materialization,
  useAttempt,
  useMaterialization,
} from "./invocation.ts";
import type { HostPath, RunnerFiles } from "./materialize.ts";
import type { RemoteReadLink } from "./read.ts";
import type { RemoteInvocationSnapshot } from "./records.ts";
import { withRemoteJournalRoute } from "./journal-route.ts";
import type { TemporaryTrees } from "./invocation.ts";

/**
 * What a Workspace mutation is given.
 *
 * The same two things the Deno coordinator hands one, plus the Agent-session
 * mappings, so one contract describes both hosts' work.
 */
export type RemoteWorkspaceMutation<T extends Json> = (
  filesystem: WorkspaceFilesystem,
  metadata: WorkspaceMetadata,
  agentSessions: AgentSessions,
) => Operation<T>;

/**
 * The host facts the coordinator cannot know.
 *
 * Where temporary trees come from, how bytes are written, and how a Workspace
 * filesystem is built over a directory. Supplied by a runtime-named adapter, so
 * nothing here names a host.
 */
export interface RemoteWorkspaceRuntime {
  readonly files: RunnerFiles;
  readonly trees: TemporaryTrees;
  readonly reads: RemoteReadLink;
  createFilesystem(at: HostPath, authorize: () => void): WorkspaceFilesystem;
}

interface WorkspaceMutationApi {
  run<T extends Json>(
    database: WorkflowRunDatabase,
    mutate: RemoteWorkspaceMutation<T>,
  ): Operation<T>;
}

function unavailable(reason: string): never {
  throw new WorkflowTransactionError(reason);
}

const WorkspaceMutation: Api<WorkspaceMutationApi> = createApi<WorkspaceMutationApi>(
  "executablemd.workflow.remote.workspace.effect.mutation",
  {
    // deno-lint-ignore require-yield
    *run<T extends Json>(): Operation<T> {
      return unavailable(
        "the Workspace effect is not bound to an active remote WorkflowRun transaction.",
      );
    },
  },
);

/**
 * Which database claimed which execution identity.
 *
 * A `WeakMap` keyed by the identity object, so the claim is the object itself
 * rather than anything written down. A second loaded copy of this module has
 * its own map and its own identities, and neither can answer for the other's.
 */
const workspaceEffectOwners = (() => {
  const owners = new WeakMap<object, WorkflowRunDatabase>();
  return {
    claim(identity: object, database: WorkflowRunDatabase): void {
      owners.set(identity, database);
    },
    get(identity: object): WorkflowRunDatabase | undefined {
      return owners.get(identity);
    },
  };
})();

interface Registration {
  open: boolean;
  readonly runtime: RemoteWorkspaceRuntime;
  readonly provenance: JournalProvenance;
}

interface ProviderApi {
  readonly provider: object | undefined;
}

const RemoteWorkspaceProvider: Api<ProviderApi> = createApi<ProviderApi>(
  "executablemd.workflow.remote.workspace.effect.provider",
  { provider: undefined },
);

const registrations = (() => {
  const held = new WeakMap<object, Registration>();
  return {
    register(runtime: RemoteWorkspaceRuntime, provenance: JournalProvenance) {
      const selection = Object.freeze({});
      const registration: Registration = { open: true, runtime, provenance };
      held.set(selection, registration);
      return {
        selection,
        close(): void {
          registration.open = false;
          held.delete(selection);
        },
      };
    },
    get(selection: object): Registration | undefined {
      const registration = held.get(selection);
      return registration?.open === true ? registration : undefined;
    },
  };
})();

/**
 * Install the runner's Workspace coordination for this scope.
 *
 * The provenance is the one the run's journal was established with. It is held
 * here rather than compared structurally, because two journals can describe the
 * same events and only one of them is this run's.
 */
export function* useRemoteWorkspaceEffects(
  runtime: RemoteWorkspaceRuntime,
  provenance: JournalProvenance,
): Operation<void> {
  const registration = registrations.register(runtime, provenance);
  yield* ensure(registration.close);
  yield* RemoteWorkspaceProvider.around({ provider: () => registration.selection }, { at: "min" });
}

export function withRemoteWorkspaceEffects<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const selection = yield* RemoteWorkspaceProvider.operations.provider;
    const registration = selection === undefined ? undefined : registrations.get(selection);
    if (registration === undefined) {
      return unavailable("no remote Workspace coordinator is installed for this run.");
    }
    return yield* withWorkspaceCoordinationProvider(coordinator(database, registration), operation);
  });
}

export function createRemoteWorkspaceEffect<T extends Json>(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  mutate: RemoteWorkspaceMutation<T>,
): DurableEffect<T> {
  const execute = () => WorkspaceMutation.operations.run(database, mutate);
  const executionIdentity = Object.freeze({});
  workspaceEffectOwners.claim(executionIdentity, database);
  return createOwnedDurableWorkspaceOperation(description, execute, executionIdentity);
}

function coordinator(
  database: WorkflowRunDatabase,
  registration: Registration,
): WorkspaceCoordinationProvider {
  return {
    *run(authority: WorkspaceCoordinationAuthority): Operation<DurableResult> {
      let transacted;
      try {
        if (workspaceEffectOwners.get(authority.executionIdentity) !== database) {
          unavailable(
            "the live Workspace effect is missing, foreign, completed, or stale for this " +
              "WorkflowRun database.",
          );
        }
        if (
          authority.journalProvenance === undefined ||
          authority.journalProvenance !== registration.provenance
        ) {
          unavailable(
            "the live Workspace journal does not have the provenance of the selected WorkflowRun.",
          );
        }
        transacted = yield* invoke(database, registration, authority);
      } catch (error) {
        throw yield* authority.activateFailure(error);
      }
      if (!transacted.ok) {
        throw yield* authority.activateFailure(transacted.error);
      }
      return transacted.value;
    },
  };
}

function* invoke(
  database: WorkflowRunDatabase,
  registration: Registration,
  authority: WorkspaceCoordinationAuthority,
) {
  const { runtime } = registration;
  const reject = (reason: string): never => unavailable(reason);
  const snapshot = yield* runtime.reads.invocationSnapshot();

  // Outside the transaction, deliberately. The collector seals the attempt
  // after the transaction body and everything it started have torn down, so an
  // attempt owned by the body would already be gone when its proposal is taken.
  const materialization: Materialization = yield* useMaterialization(
    runtime.files,
    runtime.trees,
    runtime.reads,
    snapshot.workspaceRootId,
    reject,
  );
  const attempt: Attempt = yield* useAttempt(
    runtime.files,
    runtime.trees,
    runtime.reads,
    materialization,
    reject,
  );

  return yield* database.transact(function* (transaction) {
    const route = yield* activeWorkspaceRoute(database, transaction);
    if (route === undefined) {
      unavailable(
        "the live Workspace coordinator is not inside this WorkflowRun's active transaction.",
      );
    }
    // Before the document runs, and before anything is sent. If the run moved
    // between the snapshot and this transaction, everything admitted describes
    // a state this commit would not be against.
    if (
      route.anchor.workspaceRootId !== snapshot.workspaceRootId ||
      route.anchor.journalEventId !== snapshot.journalEventId
    ) {
      unavailable(
        "this Workspace invocation was admitted from a state this run has since moved past.",
      );
    }
    return yield* coordinateTransaction(
      database,
      transaction,
      route,
      runtime,
      snapshot,
      attempt,
      authority,
    );
  });
}

function* coordinateTransaction(
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
  route: WorkspaceRoute,
  runtime: RemoteWorkspaceRuntime,
  snapshot: RemoteInvocationSnapshot,
  attempt: Attempt,
  authority: WorkspaceCoordinationAuthority,
): Operation<DurableResult> {
  return yield* scoped(function* () {
    let live = true;
    // The capabilities exist while this invocation does and no longer. A
    // filesystem or mapping view captured for later is asking about a
    // Workspace that has already been committed or discarded.
    yield* ensure(() => {
      live = false;
    });
    const authorize = (): void => {
      if (!live) {
        unavailable("this Workspace capability is completed, cancelled, or stale.");
      }
    };
    const mappings = createInvocationMappings(snapshot, authorize);
    const filesystem = runtime.createFilesystem(attempt.at, authorize);

    let result: DurableResult;
    try {
      const value = yield* scoped(function* () {
        yield* WorkspaceMutation.around(
          {
            *run([candidate, mutate]): Operation<Json> {
              if (candidate !== database) {
                unavailable(
                  "the Workspace effect is not bound to an active remote WorkflowRun transaction.",
                );
              }
              return yield* mutate(filesystem, mappings.metadata, mappings.agentSessions);
            },
          },
          { at: "min" },
        );
        return yield* authority.execute();
      });
      result = { status: "ok", value };
      // Only a successful result publishes a Workspace. The attempt is named
      // rather than captured: the collector seals it after this body tears
      // down, so what the owner decides is the tree as it finally is.
      route.enlist(attempt, mappings.deltas());
    } catch (error) {
      if (!isJournaledEffectFailure(error)) {
        throw error;
      }
      // The effect's own outcome. Nothing is enlisted, so the commit carries
      // only this row and the root stays exactly where it was.
      result = { status: "err", error: serializeError(error) };
    }

    yield* withRemoteJournalRoute(database, transaction, authority.publish(result));
    return result;
  });
}
