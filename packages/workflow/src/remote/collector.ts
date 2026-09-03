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

import { call, ensure, Ok, type Operation, type Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { DurableStream } from "@executablemd/durable-streams";
import type { WorkflowRunTransaction } from "../storage/api.ts";

/** Why a transaction could not be run or committed. */
export type CollectorRefusal =
  | "nested-transaction"
  | "transaction-closed"
  | "operation-inside-body"
  | "too-many-events";

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

/** One closed intent, as the owner will receive it. */
export interface CommitIntent {
  readonly expectedWorkspaceRootId: string;
  readonly expectedJournalEventId: string | null;
  readonly events: readonly DurableEvent[];
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
  body: (transaction: WorkflowRunTransaction) => Operation<T>,
): Operation<Result<T>> {
  return call(function* (): Operation<Result<T>> {
    if (gate.open) {
      throw new RemoteTransactionError("nested-transaction");
    }
    const starting = yield* link.frontier();
    const appended: DurableEvent[] = [];
    let live = true;

    const journal: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        if (!live) {
          throw new RemoteTransactionError("transaction-closed");
        }
        // Read-your-writes: the starting prefix, then this transaction's own
        // appends, in order. A body that reads back what it just wrote sees it
        // even though the owner has not been told yet.
        return [...starting.events, ...appended];
      },
      *append(event: DurableEvent): Operation<void> {
        if (!live) {
          throw new RemoteTransactionError("transaction-closed");
        }
        if (appended.length >= MAX_EVENTS) {
          throw new RemoteTransactionError("too-many-events");
        }
        // Cloned on the way in, so a caller that keeps mutating the value it
        // handed over cannot change what this transaction will commit.
        appended.push(structuredClone(event));
      },
    };

    gate.open = true;
    let outcome: T;
    try {
      // Everything the body started tears down before the intent is built. A
      // failure or cancellation leaves through here without a commit, which is
      // what makes "no commit was sent" the same statement as "the body did not
      // finish".
      outcome = yield* call(() => body({ journal }));
    } finally {
      live = false;
      gate.open = false;
    }

    const committed = yield* link.commit({
      expectedWorkspaceRootId: starting.workspaceRootId,
      expectedJournalEventId: starting.journalEventId,
      events: appended,
    });
    if (!committed.ok) {
      return committed;
    }
    // Only now. `T` is the body's own value and never crossed the connection;
    // returning it before the owner committed would be a caller holding a
    // result for work that did not happen.
    return Ok(outcome);
  });
}

/** Discard a collector's work without sending it. */
export function abandon(gate: TransactionGate): Operation<void> {
  return ensure(() => {
    gate.open = false;
  });
}
