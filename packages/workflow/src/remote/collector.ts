/**
 * `transact()` for a run whose storage is somewhere else.
 *
 * A Durable Object commits synchronously and cannot hold a transaction open
 * across a network wait, so the obvious reading — open a remote transaction,
 * run the caller's body, commit — is not available. What is available is that
 * the body does not need the transaction to be open while it runs. It needs to
 * read the starting history, it needs its writes to go somewhere, and it needs
 * all of them to land together or not at all.
 *
 * So the callback runs here, in a runner-owned scope, against a collector. The
 * starting frontier is read once through an ordinary bounded request that opens
 * and closes its own read on the owner. Journal appends go into a local buffer
 * that `readAll()` reads back after the starting prefix, so the body sees its
 * own writes. Nothing is sent while the body is running. When the body and
 * everything it started have torn down successfully, one closed intent goes to
 * the owner, which revalidates and applies it inside its one transaction.
 *
 * The callback is never serialized, interpreted, or run inside the owner. It is
 * ordinary code doing ordinary work; only what it *enlisted* crosses the
 * connection. That is what makes arbitrary control flow safe here — nothing
 * tries to infer what the body did.
 */

import { call, ensure, Ok, type Operation, type Result, scoped } from "effection";
import type { RetainedMapping, WorkspacePublication } from "./publication.ts";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { DurableStream } from "@executablemd/durable-streams";
import type { WorkflowRunTransaction } from "../storage/api.ts";

/** Why a transaction could not be run or committed. */
export type CollectorRefusal =
  | "nested-transaction"
  | "publication-already-enlisted"
  | "too-many-mappings"
  | "transaction-closed"
  | "operation-inside-body"
  | "too-many-events"
  | "events-too-large"
  | "malformed-event";

export class RemoteTransactionError extends Error {
  override name = "RemoteTransactionError";

  constructor(readonly refusal: CollectorRefusal) {
    super(`this remote transaction cannot proceed (${refusal})`);
  }
}

/** The starting state a transaction is proposed against. */
export interface StartingFrontier {
  readonly workspaceRootId: string;
  readonly journalEventId: string | null;
  readonly events: readonly DurableEvent[];
}

/**
 * One closed intent, as the owner will receive it.
 *
 * Everything the transaction decided, and nothing it did not. `publication` is
 * absent for a transaction that only appended to the journal — a real case, and
 * inventing a Workspace change to make the shape uniform would publish a root
 * nobody asked for.
 */
export interface CommitIntent {
  readonly expectedWorkspaceRootId: string;
  readonly expectedJournalEventId: string | null;
  readonly events: readonly DurableEvent[];
  readonly publication: WorkspacePublication | null;
  readonly mappings: readonly RetainedMapping[];
}

/**
 * What a Workspace operation enlisted, if one did.
 *
 * At most one per transaction. Two would be two Workspaces proposed for one
 * commit, and the owner would have to choose — which is a decision nobody is
 * entitled to make on the run's behalf.
 */
export interface WorkspaceEnlistment {
  readonly publication: WorkspacePublication;
  readonly mappings: readonly RetainedMapping[];
}

/** What the collector needs from the connection. */
export interface OwnerLink {
  /** One bounded read that opens and closes its own owner-side read. */
  frontier(): Operation<StartingFrontier>;
  /** One closed intent, applied atomically or not at all. */
  commit(intent: CommitIntent): Operation<Result<void>>;
}

/** The most events one intent may carry. */
const MAX_EVENTS = 4096;

/** The most serialized bytes one intent may carry. */
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

/** The most retained mapping changes one intent may carry. */
const MAX_MAPPINGS = 256;

/**
 * Admit one event and detach it from whoever handed it over.
 *
 * Cloning on the way in is not enough on its own: a caller that reads an event
 * back and mutates what it received would otherwise change what this
 * transaction commits. So every crossing — in, out, and into the intent — is a
 * fresh copy, and the collector's own array is never handed to anybody.
 */
function admitEvent(event: DurableEvent): DurableEvent {
  if (event === null || typeof event !== "object") {
    throw new RemoteTransactionError("malformed-event");
  }
  if (!("type" in event) || typeof event.type !== "string") {
    throw new RemoteTransactionError("malformed-event");
  }
  try {
    return structuredClone(event);
  } catch {
    // A value that cannot be cloned cannot be sent either.
    throw new RemoteTransactionError("malformed-event");
  }
}

/** The serialized size of what has been collected so far. */
function serializedBytes(events: readonly DurableEvent[]): number {
  return new TextEncoder().encode(JSON.stringify(events)).length;
}

/**
 * Whether a transaction is open on this handle.
 *
 * Scope-local rather than global: two runs may transact at once, and what must
 * not happen is a second transaction — or an ordinary operation — on the *same*
 * handle from inside a body. That is the same refusal the local provider makes,
 * and for the same reason: work that never received the transaction handle
 * would otherwise commit on its own, outside the unit of work it appears to be
 * part of.
 */
export interface TransactionGate {
  open: boolean;
}

export function createTransactionGate(): TransactionGate {
  return { open: false };
}

/** Refuse an ordinary same-handle operation while a body is running. */
export function requireNoOpenTransaction(gate: TransactionGate): void {
  if (gate.open) {
    throw new RemoteTransactionError("operation-inside-body");
  }
}

/**
 * Run `body` against a collector, then submit what it enlisted.
 *
 * The body may compute, suspend and perform runner-owned effects. None of that
 * is reduced to an intent and none of it executes on the owner; only mutations
 * made through the transaction handle enter the collector.
 */
export function transactRemotely<T>(
  link: OwnerLink,
  gate: TransactionGate,
  body: (transaction: WorkflowRunTransaction, enlist: EnlistWorkspace) => Operation<T>,
): Operation<Result<T>> {
  return call(function* (): Operation<Result<T>> {
    // Taken synchronously, before the first suspension. Checking and then
    // suspending in `frontier()` would let two calls on one handle both pass
    // the check and act from the same starting frontier.
    if (gate.open) {
      throw new RemoteTransactionError("nested-transaction");
    }
    gate.open = true;
    // Released once, and only after nothing from this transaction can still
    // affect the handle — which is after the commit answer, not after the body.
    // Between those two the outcome is undecided, and later work must not run
    // as though it had been decided.
    try {
      return yield* run();
    } finally {
      gate.open = false;
    }

    function* run(): Operation<Result<T>> {
      const starting = yield* link.frontier();
      const appended: DurableEvent[] = [];
      let live = true;

      const journal: DurableStream = {
        *readAll(): Operation<DurableEvent[]> {
          if (!live) {
            throw new RemoteTransactionError("transaction-closed");
          }
          // Read-your-writes, as fresh copies. The starting prefix then this
          // transaction's own appends, in order.
          return [...starting.events, ...appended].map((event) => structuredClone(event));
        },
        *append(event: DurableEvent): Operation<void> {
          if (!live) {
            throw new RemoteTransactionError("transaction-closed");
          }
          if (appended.length >= MAX_EVENTS) {
            throw new RemoteTransactionError("too-many-events");
          }
          const admitted = admitEvent(event);
          if (serializedBytes([...appended, admitted]) > MAX_EVENT_BYTES) {
            throw new RemoteTransactionError("events-too-large");
          }
          appended.push(admitted);
        },
      };

      let enlisted: WorkspaceEnlistment | undefined;
      /**
       * How a Workspace operation puts its result into this transaction.
       *
       * Private: it is handed to the body rather than reachable from the
       * database, so work that never received it cannot publish a Workspace by
       * accident. Detached on the way in, because the caller still holds the
       * arrays and records it passed and a proposal that changed after it was
       * admitted would not be the proposal the identity was computed over.
       */
      const enlist: EnlistWorkspace = (proposal: WorkspaceEnlistment): void => {
        if (!live) {
          throw new RemoteTransactionError("transaction-closed");
        }
        if (enlisted !== undefined) {
          throw new RemoteTransactionError("publication-already-enlisted");
        }
        if (proposal.mappings.length > MAX_MAPPINGS) {
          throw new RemoteTransactionError("too-many-mappings");
        }
        enlisted = detach(proposal);
      };

      let outcome: T;
      try {
        // A scope of its own, closed here. Everything the body started —
        // spawned children, resources — has finished tearing down before the
        // intent is built, so "no commit was sent" and "the body did not
        // finish" are one statement. `call()` alone would let a resource whose
        // teardown fails surface its failure after the commit had already gone
        // out, which is the one ordering that cannot be taken back.
        outcome = yield* scoped(() => body({ journal }, enlist));
      } finally {
        // The handle is closed before the commit goes out, so a retained
        // transaction object refuses while the handle-level gate is still held.
        live = false;
      }

      const committed = yield* link.commit({
        expectedWorkspaceRootId: starting.workspaceRootId,
        expectedJournalEventId: starting.journalEventId,
        // A private snapshot. The collector's own array never leaves.
        events: appended.map((event) => structuredClone(event)),
        publication: enlisted?.publication ?? null,
        mappings: enlisted?.mappings ?? [],
      });
      if (!committed.ok) {
        return committed;
      }
      // Only now. `T` is the body's own value and never crossed the connection.
      return Ok(outcome);
    }
  });
}

/** How a Workspace operation enlists its one publication in the active transaction. */
export type EnlistWorkspace = (proposal: WorkspaceEnlistment) => void;

/**
 * A copy nobody else holds a reference into.
 *
 * The caller keeps whatever it passed, and may go on using it. What the intent
 * carries has to be what was admitted at the moment it was admitted — a
 * publication whose inventory or manifest changed afterwards would not be the
 * one its identity was computed over.
 */
function detach(proposal: WorkspaceEnlistment): WorkspaceEnlistment {
  return Object.freeze({
    publication: Object.freeze({
      proposedWorkspaceRootId: proposal.publication.proposedWorkspaceRootId,
      proposedManifest: proposal.publication.proposedManifest,
      content: Object.freeze(
        proposal.publication.content.map((piece) => Object.freeze({ ...piece })),
      ),
    }),
    mappings: Object.freeze(
      proposal.mappings.map((mapping) =>
        Object.freeze({ ...mapping, record: Object.freeze({ ...mapping.record }) }),
      ),
    ) as readonly RetainedMapping[],
  });
}

/** Discard a collector's work without sending it. */
export function abandon(gate: TransactionGate): Operation<void> {
  return ensure(() => {
    gate.open = false;
  });
}
