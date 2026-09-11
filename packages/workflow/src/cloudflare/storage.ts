/**
 * A Durable Object's storage, as the vendored DOFS layer expects to see it.
 *
 * The vendor describes storage structurally — `sql.exec()` answering a cursor
 * whose rows are a caller-chosen `object` subtype — while the runtime types the
 * same call concretely as `Record<string, SqlStorageValue>`. The two are
 * compatible in fact and not in the type system, so this is the one place the
 * shapes are reconciled, rather than every call site asserting it.
 *
 * Nothing is converted: the cursor is drained with `toArray()` exactly where
 * the caller asks for it, because Cloudflare's SQL cursor does not survive an
 * `await` and draining it late would read a different result than the query
 * asked for.
 */

import type {
  DurableObjectStorageLike,
  SQLCursorLike,
  SQLStorageLike,
} from "../../vendor/cloudflare-computer-dofs/generated/types.d.ts";

/** The subset of the runtime's storage this adapter uses. */
export interface OwnerStorage {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(closure: () => T): T;
}

/**
 * Present one Durable Object's storage as the vendored DOFS storage shape.
 *
 * `transactionSync` is deliberately *not* forwarded here. The owner opens
 * exactly one real transaction of its own and enlists DOFS inside it; a wrapper
 * that forwarded this method would let a nested call reach the runtime, which
 * refuses transaction statements from `sql.exec()`.
 */
export function dofsStorage(storage: OwnerStorage): DurableObjectStorageLike {
  const sql: SQLStorageLike = {
    exec<Row extends object = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SQLCursorLike<Row> {
      const rows = storage.sql.exec(query, ...bindings).toArray();
      return {
        toArray(): Row[] {
          return rows as Row[];
        },
      };
    },
  };
  return { sql };
}
