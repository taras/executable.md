import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * A statement that returns SQLite integers as `bigint` rather than throwing.
 *
 * A plain node:sqlite read raises a RangeError, including the stored value in
 * its message, when an INTEGER exceeds JavaScript's safe range. Adapter
 * parsers need to receive that value so they can refuse it without disclosing
 * it.
 */
export function reading(database: DatabaseSync, sql: string): StatementSync {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

/** One consistent SQLite snapshot, without advertising a caller-owned write transaction. */
export function readTransaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec("BEGIN");
  try {
    const value = body();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw error;
  }
}
