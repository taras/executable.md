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
import { resource } from "effection";
import { establishJournalProvenance, type DurableStream } from "@executablemd/durable-streams";
import { useRemoteRunDatabase, type RemoteWorkspaceLink } from "./database.ts";
import { routeRemoteRunJournal } from "./journal-route.ts";

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
  const owners = new WeakMap<object, object>();
  return {
    claim(identity: object, run: object): void {
      owners.set(identity, run);
    },
    get(identity: object): object | undefined {
      return owners.get(identity);
    },
  };
})();

/**
 * One remote run, as one thing.
 *
 * The pieces a Workspace invocation needs — the database handle, the owner link
 * its reads and commits go through, the runtime adapters that materialize from
 * that owner, the routed journal and the provenance taken over it — describe
 * one run only when they came from the same one. Supplied separately they can
 * be recombined: pair run B's database with run A's link and journal, and if
 * both happen to start at the same root and anchor, one effect journals in A
 * and publishes its Workspace in B.
 *
 * So they are not supplied separately. This constructs them together and hands
 * back one opaque value. There is nothing to recombine, and nothing structural
 * to forge: the coordinator compares the object it was given, not the run id,
 * root or anchor inside it.
 */
export interface RemoteRun {
  /** The run's storage handle, for work that is not a Workspace effect. */
  readonly database: WorkflowRunDatabase;
  /**
   * The run's journal, routed so a Workspace publication lands in its
   * transaction. This exact stream is the one provenance was taken over.
   */
  readonly journal: DurableStream;
}

/** What only this module may read off a binding. */
interface BoundRun extends RemoteRun {
  readonly runtime: RemoteWorkspaceRuntime;
  readonly provenance: JournalProvenance;
}

/**
 * The private view of a binding, keyed by the binding itself.
 *
 * A `WeakSet` would answer "did this module make it"; this answers "and here is
 * what it was made from", without putting either on the value a host holds. A
 * second loaded copy of this module has its own map and cannot answer for one
 * of these, which is the loaded-copy contract.
 */
const bindings = (() => {
  const held = new WeakMap<RemoteRun, BoundRun>();
  return {
    bind(run: BoundRun): RemoteRun {
      const handle: RemoteRun = Object.freeze({ database: run.database, journal: run.journal });
      held.set(handle, run);
      return handle;
    },
    of(run: RemoteRun | undefined): BoundRun | undefined {
      return run === undefined ? undefined : held.get(run);
    },
  };
})();

/** What a host supplies to open one remote run. */
export interface RemoteRunOptions {
  /**
   * The one owner link this run's database, reads and commits go through.
   *
   * Deliberately one member. A separate read link could be another owner's,
   * and an invocation admitted from one run would commit to the other.
   */
  readonly link: RemoteWorkspaceLink;
  readonly files: RunnerFiles;
  readonly trees: TemporaryTrees;
  createFilesystem(at: HostPath, authorize: () => void): WorkspaceFilesystem;
  /** The run's ordinary journal, which this routes and takes provenance over. */
  readonly journal: DurableStream;
}

/**
 * Open one remote run: its database, its routed journal and its provenance.
 *
 * The database is created here from the same link the runtime reads through, so
 * "this runtime belongs to this handle" is true by construction rather than by
 * a check that could be passed with another handle.
 */
export function useRemoteRun(options: RemoteRunOptions): Operation<RemoteRun> {
  return resource(function* (provide) {
    const database = yield* useRemoteRunDatabase(
      options.link,
      yield* options.link.frontierSnapshot(),
    );
    const journal = routeRemoteRunJournal(database, options.journal);
    yield* provide(
      bindings.bind({
        database,
        journal,
        provenance: establishJournalProvenance(journal),
        runtime: {
          files: options.files,
          trees: options.trees,
          // A view of the same object the database and the commits came from,
          // not a second link: `frontier` names two different reads on the two
          // contracts, and materialization wants the coherent one.
          reads: readsOf(options.link),
          createFilesystem: options.createFilesystem,
        },
      }),
    );
  });
}

/** The read half of one owner link, presented the way materialization reads it. */
function readsOf(link: RemoteWorkspaceLink): RemoteReadLink {
  return {
    frontier: () => link.frontierSnapshot(),
    root: (workspaceRootId) => link.root(workspaceRootId),
    content: (workspaceRootId, request) => link.content(workspaceRootId, request),
    invocationSnapshot: () => link.invocationSnapshot(),
  };
}

interface ProviderApi {
  readonly provider: object | undefined;
}

const RemoteWorkspaceProvider: Api<ProviderApi> = createApi<ProviderApi>(
  "executablemd.workflow.remote.workspace.effect.provider",
  { provider: undefined },
);

interface Registration {
  open: boolean;
  readonly run: BoundRun;
}

const registrations = (() => {
  const held = new WeakMap<object, Registration>();
  return {
    register(run: BoundRun) {
      const selection = Object.freeze({});
      const registration: Registration = { open: true, run };
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

/** Install the runner's Workspace coordination for this run, in this scope. */
export function* useRemoteWorkspaceEffects(run: RemoteRun): Operation<void> {
  const bound = bindings.of(run);
  if (bound === undefined) {
    unavailable("this is not a remote run this build opened.");
  }
  const registration = registrations.register(bound);
  yield* ensure(registration.close);
  yield* RemoteWorkspaceProvider.around({ provider: () => registration.selection }, { at: "min" });
}

export function withRemoteWorkspaceEffects<T>(
  run: RemoteRun,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const selection = yield* RemoteWorkspaceProvider.operations.provider;
    const registration = selection === undefined ? undefined : registrations.get(selection);
    // The exact binding, not one that describes the same run. Two handles on
    // two owners can hold identical records; only one of them is this one.
    if (registration === undefined || registration.run !== bindings.of(run)) {
      return unavailable("no remote Workspace coordinator is installed for this run.");
    }
    return yield* withWorkspaceCoordinationProvider(coordinator(registration.run), operation);
  });
}

export function createRemoteWorkspaceEffect<T extends Json>(
  run: RemoteRun,
  description: EffectDescription,
  mutate: RemoteWorkspaceMutation<T>,
): DurableEffect<T> {
  const bound = bindings.of(run);
  if (bound === undefined) {
    unavailable("this is not a remote run this build opened.");
  }
  const execute = () => WorkspaceMutation.operations.run(bound.database, mutate);
  const executionIdentity = Object.freeze({});
  // Claimed for the binding rather than for a database, so an effect cannot be
  // created against one run and coordinated by another that holds it.
  workspaceEffectOwners.claim(executionIdentity, bound);
  return createOwnedDurableWorkspaceOperation(description, execute, executionIdentity);
}

function coordinator(run: BoundRun): WorkspaceCoordinationProvider {
  return {
    *run(authority: WorkspaceCoordinationAuthority): Operation<DurableResult> {
      let transacted;
      try {
        // Both against the same binding, so there is no pair of checks that a
        // recombination could satisfy one at a time.
        if (workspaceEffectOwners.get(authority.executionIdentity) !== run) {
          unavailable(
            "the live Workspace effect is missing, foreign, completed, or stale for this " +
              "remote run.",
          );
        }
        if (
          authority.journalProvenance === undefined ||
          authority.journalProvenance !== run.provenance
        ) {
          unavailable(
            "the live Workspace journal does not have the provenance of the selected remote run.",
          );
        }
        transacted = yield* invoke(run, authority);
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

function* invoke(run: BoundRun, authority: WorkspaceCoordinationAuthority) {
  const { runtime, database } = run;
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
    return yield* coordinateTransaction(run, transaction, route, snapshot, attempt, authority);
  });
}

function* coordinateTransaction(
  run: BoundRun,
  transaction: WorkflowRunTransaction,
  route: WorkspaceRoute,
  snapshot: RemoteInvocationSnapshot,
  attempt: Attempt,
  authority: WorkspaceCoordinationAuthority,
): Operation<DurableResult> {
  const { database, runtime } = run;
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
