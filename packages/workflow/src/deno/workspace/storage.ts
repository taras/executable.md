/**
 * The storage one Workspace transaction or inspection may reach.
 *
 * A generic view rather than a table-shaped one. Workflow owns the database,
 * the executor lease, the transaction and the journal; what a feature owns is
 * the meaning of its own rows, and this is the narrowest surface that lets it
 * keep that meaning without holding any of the rest. Statements are the
 * caller's, parameters are bound rather than interpolated, and a read comes
 * back as the stored row for the caller's own parser to read — nothing here
 * knows what a column means.
 *
 * ## Why a read view is not merely a view without `run`
 *
 * Because SQLite does not agree that `get` and `all` only read. `INSERT INTO
 * workspace_repositories (…) VALUES (…) RETURNING name` is a statement that
 * returns rows, and `StatementSync.all()` runs it and commits the insertion.
 * The same is true of `UPDATE … RETURNING` and `DELETE … RETURNING`. Removing
 * `run` from an interface removes a spelling, not a capability.
 *
 * So a read view proves the statement reads before it executes, and SQLite is
 * what proves it. Each read compiles under an authorizer that admits
 * `SQLITE_SELECT`, `SQLITE_READ` and `SQLITE_FUNCTION` and refuses every other
 * action, so an insertion, an update, a deletion, a schema change or a pragma
 * is rejected during compilation — before a row is touched. A lexical check for
 * a leading `SELECT` would be the wrong tool twice over: it would admit
 * `WITH x AS (INSERT …)` and it would be a parser this package would then own.
 *
 * The authorizer is a property of the connection, so it is installed around one
 * read and removed in a `finally`. Nothing can run between those two points: a
 * read is synchronous from the call to the returned rows, and this runtime does
 * not interleave another coroutine inside it. It stays installed across
 * execution as well as compilation, because SQLite recompiles a statement by
 * itself when the schema changes underneath it, and a recompilation is exactly
 * the moment the check must still be there.
 *
 * An adapter that offers no authorizer cannot support a read view, and this
 * refuses to build one rather than handing back a view that would allow what it
 * says it forbids.
 *
 * Every call re-authorizes against the transaction as well. The view is built
 * inside an active transaction and closes over that transaction's own check, so
 * a retained view whose transaction has ended, whose lease has moved, or whose
 * database is not the one that issued it refuses rather than reaching SQLite.
 */

import { constants, type DatabaseSync, type StatementSync } from "node:sqlite";
import { WorkflowTransactionError } from "../../storage/errors.ts";
import { reading } from "../reading.ts";

/** A value SQLite binds to one statement parameter. */
export type WorkflowWorkspaceParameter = null | number | bigint | string | Uint8Array;

/**
 * One stored row, exactly as it is stored.
 *
 * `unknown` per column on purpose: a caller that knows what the column means
 * parses it, and one that does not cannot mistake a cast for a check. Integers
 * arrive as `bigint`, so a value outside JavaScript's safe range reaches the
 * parser that has to refuse it instead of raising inside the read.
 */
export type WorkflowWorkspaceRow = Readonly<Record<string, unknown>>;

/** The reads an inspection performs against this run's storage. */
export interface WorkflowWorkspaceReadStorage {
  get(
    sql: string,
    ...parameters: readonly WorkflowWorkspaceParameter[]
  ): WorkflowWorkspaceRow | undefined;
  all(sql: string, ...parameters: readonly WorkflowWorkspaceParameter[]): WorkflowWorkspaceRow[];
}

/** The same reads, and the writes a durable mutation performs beside them. */
export interface WorkflowWorkspaceStorage extends WorkflowWorkspaceReadStorage {
  run(sql: string, ...parameters: readonly WorkflowWorkspaceParameter[]): void;
}

function sqliteConstant(name: string): number | undefined {
  const value = Reflect.get(constants, name);
  return typeof value === "number" ? value : undefined;
}

/** The actions compiling a read performs, and the answer to everything else. */
const READ_ACTIONS: ReadonlySet<number> = new Set(
  ["SQLITE_SELECT", "SQLITE_READ", "SQLITE_FUNCTION"].flatMap((name) => {
    const action = sqliteConstant(name);
    return action === undefined ? [] : [action];
  }),
);

const SQLITE_OK = sqliteConstant("SQLITE_OK");
const SQLITE_DENY = sqliteConstant("SQLITE_DENY");

function unsupported(): never {
  throw new WorkflowTransactionError(
    "this Deno node:sqlite adapter cannot prove a statement only reads, so there is no " +
      "read-only Workspace view to give. A view that could not refuse a write would allow " +
      "exactly what it says it forbids.",
  );
}

/**
 * Compile and run one statement with writing refused.
 *
 * The authorizer is removed however the read ends, so a failure inside it
 * leaves the connection the way every other caller expects to find it.
 */
function readOnly<T>(database: DatabaseSync, use: () => T): T {
  const install = Reflect.get(database, "setAuthorizer");
  if (typeof install !== "function" || SQLITE_OK === undefined || SQLITE_DENY === undefined) {
    return unsupported();
  }
  Reflect.apply(install, database, [
    (action: number) => (READ_ACTIONS.has(action) ? SQLITE_OK : SQLITE_DENY),
  ]);
  try {
    return use();
  } finally {
    Reflect.apply(install, database, [null]);
  }
}

function readingStatement(database: DatabaseSync, sql: string): StatementSync {
  return reading(database, sql);
}

/** A view of this run's storage that may only read, valid while `authorize` says so. */
export function createWorkflowWorkspaceReadStorage(
  database: DatabaseSync,
  authorize: () => void,
): WorkflowWorkspaceReadStorage {
  return {
    get(sql, ...parameters) {
      authorize();
      return readOnly(database, () => readingStatement(database, sql).get(...parameters));
    },

    all(sql, ...parameters) {
      authorize();
      return readOnly(database, () => readingStatement(database, sql).all(...parameters));
    },
  };
}

/** A view of this run's storage, valid for as long as `authorize` says it is. */
export function createWorkflowWorkspaceStorage(
  database: DatabaseSync,
  authorize: () => void,
): WorkflowWorkspaceStorage {
  return {
    get(sql, ...parameters) {
      authorize();
      return readingStatement(database, sql).get(...parameters);
    },

    all(sql, ...parameters) {
      authorize();
      return readingStatement(database, sql).all(...parameters);
    },

    run(sql, ...parameters) {
      authorize();
      database.prepare(sql).run(...parameters);
    },
  };
}

/**
 * The same storage, ended when the callback it was made for returns.
 *
 * Synchronous throughout, so a gate checked at the call is a gate checked at
 * execution — unlike the filesystem beside it, which hands back operations.
 */
export function guardedWorkflowWorkspaceStorage(
  storage: WorkflowWorkspaceStorage,
  held: () => void,
): WorkflowWorkspaceStorage {
  return {
    get(sql, ...parameters) {
      held();
      return storage.get(sql, ...parameters);
    },

    all(sql, ...parameters) {
      held();
      return storage.all(sql, ...parameters);
    },

    run(sql, ...parameters) {
      held();
      storage.run(sql, ...parameters);
    },
  };
}

/** The reading half of the same storage, held to its own callback. */
export function guardedWorkflowWorkspaceReadStorage(
  storage: WorkflowWorkspaceReadStorage,
  held: () => void,
): WorkflowWorkspaceReadStorage {
  return {
    get(sql, ...parameters) {
      held();
      return storage.get(sql, ...parameters);
    },

    all(sql, ...parameters) {
      held();
      return storage.all(sql, ...parameters);
    },
  };
}
