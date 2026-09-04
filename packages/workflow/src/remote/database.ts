/**
 * One run's storage, when the run is owned somewhere else.
 *
 * The same handle the local host hands out, backed by a connection instead of a
 * file. Everything the interface promises has to be true here for the same
 * reasons it is true there — a snapshot is a snapshot, a transaction commits or
 * it does not, and a closed handle is closed — and the differences are all
 * beneath it: there is no connection to hold open across a callback, so the
 * body runs on the runner and only what it enlisted crosses.
 *
 * Two mechanisms keep operations in order and they solve different problems.
 * A *turn* serializes work so two operations do not interleave on one handle;
 * unrelated work waits and then proceeds. A *marker* records that this scope is
 * inside a transaction on this handle, so a nested transaction — or an ordinary
 * operation called from inside the body — is refused immediately rather than
 * waiting for a turn its own caller is holding and will not release. A queue
 * alone would deadlock that case; a flag alone would mistake unrelated work for
 * nested work.
 *
 * The handle is a lease. Closing it ends this handle and nothing else: the
 * connection may be owned by an outer scope and shared with other handles, and
 * a lease that closed it would end a run somebody else was still reading.
 */

import {
  createContext,
  createSignal,
  ensure,
  Err,
  Ok,
  type Context,
  type Operation,
  type Result,
  resource,
} from "effection";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import type { JournalEntry, WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";
import { WorkflowDatabaseClosedError, WorkflowTransactionError } from "../storage/errors.ts";
import type {
  DefinitionRetrieval,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";
import { createTransactionGate, type OwnerLink, transactRemotely } from "./collector.ts";
import type { EnlistWorkspace } from "./collector.ts";
import type { RemoteFrontierSnapshot } from "./read.ts";

/** What a remote handle needs to answer everything the interface asks. */
export interface RemoteRunLink extends OwnerLink {
  /** A fresh coherent frontier, for a read that must not use a snapshot. */
  frontierSnapshot(): Operation<RemoteFrontierSnapshot>;
  /** Replace or clear the retrieval metadata, and answer with the result. */
  replaceRetrieval(
    expectedWorkspaceRootId: string,
    metadata: string | null,
  ): Operation<Result<DefinitionRetrieval | undefined>>;
  /** Every document execution, as one anchored snapshot. */
  readExecutions(): Operation<Result<DocumentExecutionRecord[]>>;
}

/**
 * Which handles this scope is inside a transaction on.
 *
 * Structural and inert, exactly like the local provider's: it can only ever
 * cause an operation to be refused, never authorize one. A chain rather than a
 * single handle, because transactions on *different* runs may nest and
 * recording only the innermost would hide the outer one.
 */
interface OpenTransaction {
  readonly handle: object;
  readonly enclosing: OpenTransaction | undefined;
}

const ActiveTransaction: Context<OpenTransaction | undefined> = createContext<
  OpenTransaction | undefined
>("executablemd.workflow.remote.transaction", undefined);

function* holdsTransactionOn(handle: object): Operation<boolean> {
  let active = yield* ActiveTransaction.get();
  while (active !== undefined) {
    if (active.handle === handle) {
      return true;
    }
    active = active.enclosing;
  }
  return false;
}

/**
 * The route a Workspace coordinator reaches the active transaction through.
 *
 * Bound to one exact handle and one exact transaction object, and live only
 * inside that transaction body's descendant scope. D3c installs a coordinator
 * over it; nothing about a document execution or its provenance is decided
 * here, and no placeholder for either is invented.
 */
export interface WorkspaceRoute {
  readonly database: WorkflowRunDatabase;
  readonly transaction: WorkflowRunTransaction;
  readonly enlist: EnlistWorkspace;
}

const ActiveRoute: Context<WorkspaceRoute | undefined> = createContext<WorkspaceRoute | undefined>(
  "executablemd.workflow.remote.workspace-route",
  undefined,
);

/**
 * The enlistment route for this exact database and transaction, if it is live.
 *
 * Answers nothing for a foreign database, a substituted or stale transaction
 * object, or a scope outside the body — which is the whole point: a coordinator
 * that has drifted from the transaction it belongs to must not be able to
 * publish into it.
 */
export function* activeWorkspaceRoute(
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
): Operation<WorkspaceRoute | undefined> {
  const route = yield* ActiveRoute.get();
  if (route === undefined || route.database !== database || route.transaction !== transaction) {
    return undefined;
  }
  return route;
}

/**
 * What a `DurableStream` member does with a result.
 *
 * The interface splits these deliberately: a member returning `Result` answers
 * with the failure, and a stream member raises it. Both describe the same
 * condition.
 */
function* raising<T>(result: Result<T>): Operation<T> {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** One handle's cooperative turn, so two operations never interleave on it. */
interface Turns {
  take<T>(body: () => Operation<T>): Operation<T>;
}

function createTurns(): Turns {
  const waiting = createSignal<void, never>();
  const holder = { held: false };
  return {
    *take<T>(body: () => Operation<T>): Operation<T> {
      while (holder.held) {
        // Someone else has the handle. Wait to be told it is free rather than
        // polling, and check again, because several may be waiting and only one
        // of them can take the turn that was just released.
        const released = yield* waiting;
        yield* released.next();
      }
      holder.held = true;
      try {
        return yield* body();
      } finally {
        holder.held = false;
        waiting.send();
      }
    },
  };
}

/** Open one scope-owned lease on a run whose storage is somewhere else. */
export function useRemoteRunDatabase(
  link: RemoteRunLink,
  frontier: RemoteFrontierSnapshot,
): Operation<WorkflowRunDatabase> {
  return resource(function* (provide) {
    let closed = false;
    let record: WorkflowRunRecord = frontier.record;
    let retrieval: DefinitionRetrieval | undefined = frontier.retrieval;
    const turns = createTurns();
    const gate = createTransactionGate();

    /** Whether this scope may reach the handle at all, and why not. */
    function* admit(): Operation<Result<void>> {
      if (closed) {
        return Err(new WorkflowDatabaseClosedError(record.runId));
      }
      if (yield* holdsTransactionOn(handle)) {
        return Err(
          new WorkflowTransactionError(
            "this scope is inside a transaction on the same workflow run database, and an " +
              "operation outside that transaction cannot run until it commits. Use the " +
              "transaction handed to the body, or move the operation outside it.",
          ),
        );
      }
      return Ok();
    }

    /** One turn at the handle, for an ordinary operation. */
    function* turn<T>(body: () => Operation<Result<T>>): Operation<Result<T>> {
      const admitted = yield* admit();
      if (!admitted.ok) {
        return admitted;
      }
      return yield* turns.take(body);
    }

    const ordinary: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return yield* raising(
          yield* turn(function* () {
            const snapshot = yield* link.frontierSnapshot();
            return Ok(snapshot.entries.map((entry) => structuredClone(entry.event)));
          }),
        );
      },

      *append(event: DurableEvent): Operation<void> {
        // One journal-only transaction through the same commit path a caller's
        // transaction uses. A second insertion route would be a second thing to
        // keep in agreement with the first.
        yield* raising(
          yield* transact(function* (transaction) {
            yield* transaction.journal.append(event);
          }),
        );
      },
    };

    function* transact<T>(
      body: (transaction: WorkflowRunTransaction) => Operation<T>,
    ): Operation<Result<T>> {
      if (closed) {
        return Err(new WorkflowDatabaseClosedError(record.runId));
      }
      if (yield* holdsTransactionOn(handle)) {
        return Err(
          new WorkflowTransactionError(
            "a transaction on this workflow run database is already open in this scope. " +
              "Nesting one inside another would commit or roll back work the outer " +
              "transaction has not finished deciding about.",
          ),
        );
      }
      return yield* turns.take(function* (): Operation<Result<T>> {
        return yield* transactRemotely(link, gate, function* (transaction, enlist) {
          // The marker and the route are installed for the body's scope alone.
          // Outside it neither exists, so a retained transaction object reaches
          // nothing and an unrelated scope is not mistaken for a nested one.
          yield* ActiveTransaction.set({
            handle,
            enclosing: yield* ActiveTransaction.get(),
          });
          yield* ActiveRoute.set({ database: handle, transaction, enlist });
          return yield* body(transaction);
        });
      });
    }

    const handle: WorkflowRunDatabase = {
      get record(): WorkflowRunRecord {
        return record;
      },

      get retrieval(): DefinitionRetrieval | undefined {
        return retrieval;
      },

      get journal(): DurableStream {
        return ordinary;
      },

      transact,

      *readJournalEntries(): Operation<Result<JournalEntry[]>> {
        return yield* turn(function* () {
          const snapshot = yield* link.frontierSnapshot();
          return Ok(snapshot.entries.map((entry) => Object.freeze({ ...entry })));
        });
      },

      *replaceRetrievalMetadata(metadata: Json | undefined): Operation<Result<void>> {
        const replaced = yield* turn(function* () {
          const snapshot = yield* link.frontierSnapshot();
          return yield* link.replaceRetrieval(
            snapshot.workspaceRootId,
            metadata === undefined ? null : canonical(metadata),
          );
        });
        if (!replaced.ok) {
          return replaced;
        }
        // Only this handle, and only after its own successful replacement. The
        // owner's revision and time are what is recorded; nothing is invented
        // here.
        retrieval = replaced.value;
        return Ok();
      },

      *readDocumentExecutions(): Operation<Result<DocumentExecutionRecord[]>> {
        return yield* turn(() => link.readExecutions());
      },
    };

    yield* ensure(() => {
      closed = true;
    });
    yield* provide(handle);
  });
}

/**
 * The canonical encoding of one retrieval metadata value.
 *
 * Sorted keys and no incidental whitespace, so two callers writing the same
 * metadata write the same bytes and a comparison of what is stored means what
 * it appears to mean.
 */
function canonical(value: Json): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const members: Record<string, Json> = {};
  const names = Object.keys(value);
  names.sort();
  for (const key of names) {
    const held = (value as Record<string, Json>)[key];
    if (held !== undefined) {
      members[key] = sorted(held);
    }
  }
  return members;
}
