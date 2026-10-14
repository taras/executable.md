/**
 * Expose bound SQL statements and raw rows for feature-owned parsers, without
 * handing features the database, executor lease, transaction or journal. Every call
 * rechecks the issuing transaction's authorization, including lease and database.
 *
 * Read views require SQLite's authorizer: `get` and `all` can otherwise execute
 * `INSERT`, `UPDATE` or `DELETE … RETURNING`. Only SQLITE_SELECT, SQLITE_READ and
 * SQLITE_FUNCTION are admitted; an adapter without authorizer support refuses.
 *
 * Install the authorizer around both compilation and execution, then remove it in
 * finally. The read is synchronous, so no coroutine interleaves on the connection;
 * keeping authorization through execution also covers SQLite's automatic schema
 * recompilation.
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
