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
import {
  establishJournalProvenance,
  type DurableEvent,
  type DurableStream,
  type JournalProvenance,
  type Json,
} from "@executablemd/durable-streams";
import type { JournalEntry, WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";
import {
  WorkflowDatabaseClosedError,
  WorkflowRecordMalformedError,
  WorkflowRequestError,
  WorkflowStorageError,
  WorkflowTransactionError,
} from "../storage/errors.ts";
import { parseJsonValue } from "../storage/members.ts";
import type {
  DefinitionRetrieval,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";
import { createTransactionGate, type OwnerLink, transactRemotely } from "./collector.ts";
import type {
  EnlistAnswer,
  EnlistMappings,
  EnlistWorkspace,
  TransactionAnchor,
} from "./collector.ts";
import type { RemoteContent, RemoteContentRequest, RemoteFrontierSnapshot } from "./read.ts";
import type { RemoteRetainedAnswer } from "./answer-link.ts";
import type { RemoteInvocationSnapshot } from "./records.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import type { WorkspaceRootManifest } from "../workspace/root-manifest.ts";
import { routeRemoteRunJournal } from "./journal-route.ts";

/** What a remote handle needs to answer everything the interface asks. */
export interface RemoteRunLink extends OwnerLink {
  /** A fresh coherent frontier, for a read that must not use a snapshot. */
  frontierSnapshot(): Operation<RemoteFrontierSnapshot>;
  /**
   * What this run retains for one wait, if it retains anything.
   *
   * On the acquisition's own authority, because it is read to be spent: an
   * execution asks what it may publish, only the executor may publish, and the
   * owner requires that acquisition to hold an open execution before it says
   * anything. The request event is named because a wait's identifier is
   * derivable and the event it was published as is not.
   */
  pendingAnswer(
    suspensionId: string,
    requestEventId: string,
  ): Operation<Result<RemoteRetainedAnswer | undefined>>;
  /** Replace or clear the retrieval metadata, and answer with the result. */
  replaceRetrieval(
    expectedWorkspaceRootId: string,
    metadata: string | null,
  ): Operation<Result<DefinitionRetrieval | undefined>>;
  /** Every document execution, as one anchored snapshot. */
  readExecutions(): Operation<Result<DocumentExecutionRecord[]>>;
}

/**
 * Everything one remote run is reached through, as one value.
 *
 * The Workspace reads and the commits are the same authority, so they are the
 * same object. Carried as two — a link and a read link a caller supplies
 * separately — they can be taken from two owners: an invocation would then
 * execute against one run's retained mappings and content and commit the
 * result to another, and if the two began at the same root and anchor nothing
 * downstream could notice. There is no such pair to make.
 */
export interface RemoteWorkspaceLink extends RemoteRunLink {
  /**
   * Find this run on its owner, or create it exactly once.
   *
   * On the link rather than beside it. An opener supplied separately could
   * have been admitted for another owner, and a create authorized by one owner
   * would then return a handle that reads and commits through the other.
   * Opening and operating are the same authority, so they are the same object.
   */
  open(
    runId: string,
    creation: CreateWorkflowRunRequest | null,
  ): Operation<Result<RemoteFrontierSnapshot>>;
  /** The one coherent admitted state a Workspace invocation begins from. */
  invocationSnapshot(): Operation<RemoteInvocationSnapshot>;
  root(workspaceRootId: string): Operation<WorkspaceRootManifest>;
  content(workspaceRootId: string, request: RemoteContentRequest): Operation<RemoteContent>;
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
  /** How this transaction retains mappings with no Workspace proposal. */
  readonly enlistMappings: EnlistMappings;
  /** Where this transaction began, so a coordinator can prove it has not drifted. */
  readonly anchor: TransactionAnchor;
  /**
   * How this transaction spends a retained answer.
   *
   * On the same route, and reachable on the same terms: an answer claim that
   * cannot prove it holds this exact database and this exact live transaction
   * cannot spend anything, which is what keeps a wait from being ended outside
   * the transaction that publishes its answer.
   */
  readonly consume: EnlistAnswer;
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
 * A failure this interface can return, whatever it arrived as.
 *
 * The adapter beneath has already translated what it knows about; anything else
 * reaching here is the body's own error, which is carried as it is. A value
 * that is not an error at all becomes one rather than travelling as a thrown
 * string nobody can act on.
 */
function failure(error: unknown): Error {
  return error instanceof Error ? error : new WorkflowTransactionError(String(error));
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

/** What one handle was opened from, for a host that has to prove it was. */
export interface RemoteRunOrigin {
  /** The exact link this handle reads, writes and commits through. */
  readonly link: RemoteRunLink;
  /** The provenance taken over this handle's routed journal. */
  readonly provenance: JournalProvenance;
}

/**
 * What each handle was opened from.
 *
 * Held beside the handle rather than on it: `WorkflowRunDatabase` is the same
 * interface both hosts implement, and a link or a witness on it would be a
 * capability every caller of either could reach. A `WeakMap` keyed by the exact
 * handle answers only for a handle this module built, and a second loaded copy
 * cannot answer for one of these at all.
 *
 * What a host does with the answer is compare it — by object identity, to the
 * connection it holds — so a handle from another client, or a look-alike with
 * the same run id and root, is refused before an effect exists.
 */
const origins = (() => {
  const held = new WeakMap<WorkflowRunDatabase, RemoteRunOrigin>();
  return {
    remember(database: WorkflowRunDatabase, origin: RemoteRunOrigin): void {
      held.set(database, origin);
    },
    of(database: WorkflowRunDatabase): RemoteRunOrigin | undefined {
      return held.get(database);
    },
  };
})();

/** What this handle was opened from, if this module opened it. */
export function remoteRunOrigin(database: WorkflowRunDatabase): RemoteRunOrigin | undefined {
  return origins.of(database);
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

    /**
     * One turn at the handle, for an ordinary operation.
     *
     * A member that returns `Result` answers with the failure rather than
     * raising it, so a link that raised is caught here. Cancellation is not a
     * failure and is left to unwind as control flow.
     */
    function* turn<T>(body: () => Operation<Result<T>>): Operation<Result<T>> {
      const admitted = yield* admit();
      if (!admitted.ok) {
        return admitted;
      }
      return yield* turns.take(function* (): Operation<Result<T>> {
        try {
          return yield* body();
        } catch (error) {
          return Err(failure(error));
        }
      });
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
        try {
          return yield* transactRemotely(
            link,
            gate,
            function* (transaction, enlist, anchor, consume, enlistMappings) {
              // The marker and the route are installed for the body's scope
              // alone. Outside it neither exists, so a retained transaction
              // object reaches nothing and an unrelated scope is not mistaken for
              // a nested one.
              yield* ActiveTransaction.set({
                handle,
                enclosing: yield* ActiveTransaction.get(),
              });
              yield* ActiveRoute.set({
                database: handle,
                transaction,
                enlist,
                enlistMappings,
                anchor,
                consume,
              });
              return yield* body(transaction);
            },
          );
        } catch (error) {
          // A body that raised, or a resource of its that failed to tear down,
          // is a failed transaction rather than a raised one: the interface
          // answers with a `Result`, and nothing was committed.
          return Err(failure(error));
        }
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
        return routed;
      },

      transact,

      *readJournalEntries(): Operation<Result<JournalEntry[]>> {
        return yield* turn(function* () {
          const snapshot = yield* link.frontierSnapshot();
          return Ok(snapshot.entries.map((entry) => Object.freeze({ ...entry })));
        });
      },

      *replaceRetrievalMetadata(metadata: Json | undefined): Operation<Result<void>> {
        let encoded: string | null;
        try {
          // Parsed by the same rules a stored value is held to, then encoded
          // canonically. A value that is not JSON at all never becomes a
          // request: refusing it here is what "no request" means.
          encoded =
            metadata === undefined
              ? null
              : canonical(parseJsonValue(metadata, "$", retrievalFailure));
        } catch (error) {
          return Err(failure(error));
        }
        const replaced = yield* turn(function* () {
          const snapshot = yield* link.frontierSnapshot();
          return yield* link.replaceRetrieval(snapshot.workspaceRootId, encoded);
        });
        if (!replaced.ok) {
          return replaced;
        }
        // The answer has to describe the replacement that was asked for. An
        // owner that returned different metadata would otherwise install the
        // location a later fetch of the definition would use.
        const answered = replaced.value;
        if (encoded === null) {
          if (answered !== undefined) {
            return Err(contradiction());
          }
        } else if (answered === undefined || canonical(answered.metadata) !== encoded) {
          return Err(contradiction());
        }
        // Only this handle, and only after its own successful replacement. The
        // owner's revision and time are what is recorded; nothing is invented
        // here.
        retrieval = answered;
        return Ok();
      },

      *readDocumentExecutions(): Operation<Result<DocumentExecutionRecord[]>> {
        return yield* turn(() => link.readExecutions());
      },
    };

    // The same shape the local handle has: what a caller runs its document on
    // is the routed journal, so a Workspace effect's publication lands inside
    // the transaction that made the change rather than beside it, and the
    // provenance a coordinator compares is taken over that exact stream. Built
    // here because here is where the handle exists — a caller that assembled
    // the pair itself could pair one run's journal with another's storage.
    const routed: DurableStream = routeRemoteRunJournal(handle, ordinary);
    origins.remember(
      handle,
      Object.freeze({ link, provenance: establishJournalProvenance(routed) }),
    );

    yield* ensure(() => {
      closed = true;
    });
    yield* provide(handle);
  });
}

/** How a malformed retrieval value is reported, before anything is sent. */
function retrievalFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `this retrieval metadata is not a JSON value storage can keep at ${path}: ${reason}.`,
  );
}

/** An answer that does not describe the replacement it answered. */
function contradiction(): WorkflowStorageError {
  return new WorkflowRecordMalformedError(
    "retrieval this run's owner returned",
    "it does not describe the replacement that was asked for",
  );
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
