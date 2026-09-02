/**
 * The one real transaction an owner commit runs inside.
 *
 * A Durable Object's SQLite accepts exactly one shape of transaction: the
 * runtime's own `transactionSync()`, entered once. It refuses `BEGIN`, `COMMIT`
 * and `SAVEPOINT` through `sql.exec()`, and it refuses a reentrant
 * `transactionSync()`. The vendored DOFS `Database` does not know that — asked
 * to transact while it believes a transaction is already open, it falls back to
 * `SAVEPOINT`, and every DOFS filesystem primitive opens a transaction of its
 * own on the way in.
 *
 * So the owner enters the real transaction itself and hands DOFS a wrapper
 * whose `transactionSync` runs its callback directly. Inside the real
 * callback that is not a weaker promise: the outer transaction is already
 * open, so a body that returns has had its work applied to the same
 * transaction, and a body that throws unwinds through the real callback and
 * Cloudflare rolls the whole thing back.
 *
 * That substitution is only safe because the owner does not use a DOFS
 * savepoint as a recovery boundary. The runner has already performed the live
 * Workspace work against disposable materialization; what reaches the owner is
 * a complete proposal. The owner commits all of it or, treating any validation
 * or application failure as infrastructure failure, none of it.
 *
 * The wrapper is created for one callback and refuses use outside it, so
 * nothing can retain it and reach the storage later. Its DOFS caches are built
 * fresh for the same reason: a resolution or blob cache populated from
 * uncommitted rows must not survive a rollback or be read by a later
 * operation.
 */

import { Database as DofsDatabase } from "../../vendor/cloudflare-computer-dofs/generated/storage.js";
import { clearBlobCache } from "../../vendor/cloudflare-computer-dofs/generated/fs/blobCache.js";
import { clearResolveCache } from "../../vendor/cloudflare-computer-dofs/generated/fs/resolveCache.js";
import { dofsStorage, type OwnerStorage } from "./storage.ts";

/** Using an enlistment after its transaction returned. */
export class OwnerTransactionClosedError extends Error {
  override name = "OwnerTransactionClosedError";

  constructor() {
    super(
      "this owner transaction has finished; a DOFS enlistment is valid only inside the callback that created it.",
    );
  }
}

/** Opening an owner transaction inside one. */
export class OwnerTransactionNestedError extends Error {
  override name = "OwnerTransactionNestedError";

  constructor() {
    super(
      "an owner transaction is already open; Durable Object storage admits exactly one, and a second would reach SAVEPOINT.",
    );
  }
}

/** What the body of an owner transaction is given. */
export interface OwnerTransaction {
  /** The DOFS database, enlisted in this transaction and valid only inside it. */
  readonly dofs: DofsDatabase;
}

/** Whether an owner transaction is currently open on this object. */
let open = false;

/**
 * Run `body` inside one real `ctx.storage.transactionSync()`.
 *
 * `body` must complete synchronously. Nothing may await, suspend, hold a
 * cursor, wait on a WebSocket or reach the runner from inside it: the runtime
 * requires the callback to finish before it can commit, and a value that
 * arrived later would be applied to a transaction nobody is holding.
 */
export function ownerTransaction<T>(
  storage: OwnerStorage,
  body: (transaction: OwnerTransaction) => T,
): T {
  if (open) {
    throw new OwnerTransactionNestedError();
  }
  open = true;
  try {
    return storage.transactionSync(() => {
      let live = true;
      const dofs = new DofsDatabase(dofsStorage(storage));
      // Fresh caches for this transaction alone. They are keyed by database, so
      // an entry populated from rows this transaction may roll back would
      // otherwise outlive it and be read by a later operation.
      clearResolveCache(dofs);
      clearBlobCache(dofs);
      // The substitution: DOFS believes it is opening a transaction, and runs
      // in the one already open. Reentrancy inside DOFS becomes ordinary
      // nesting of plain function calls, which is what the runtime allows.
      Object.defineProperty(dofs, "transactionSync", {
        value: <R>(closure: () => R): R => {
          if (!live) {
            throw new OwnerTransactionClosedError();
          }
          return closure();
        },
        configurable: false,
        writable: false,
      });
      try {
        return body({ dofs });
      } finally {
        live = false;
        clearResolveCache(dofs);
        clearBlobCache(dofs);
      }
    });
  } finally {
    open = false;
  }
}
