// Real-DB DurableObjectStorageLike for unit tests. Backed by Node's
// built-in node:sqlite running an in-memory database. Workers' DO SQL
// surface is a subset of this, so anything that works here works on
// the real platform too.
//
// This module imports node:sqlite at the top level and therefore
// cannot be loaded under workerd. RecordingStorage — the
// pure-JS fixture that also lives in dofs's testing surface
// — has moved to ./testing-recording.ts so it can be imported
// from workerd-runnable tests. We re-export it here so existing
// `import { RecordingStorage } from "@cloudflare/dofs/testing"`
// call sites keep working under node.

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { DurableObjectStorageLike, SQLCursorLike } from "./types.js";

export type { ExecutedStatement } from "./testing-recording.js";
export { RecordingStorage } from "./testing-recording.js";

class TestCursor<Row extends object> implements SQLCursorLike<Row> {
  private readonly rows: Row[];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  toArray(): Row[] {
    return this.rows;
  }
}

export class SQLiteTestStorage implements DurableObjectStorageLike {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  readonly sql: {
    exec: <Row extends object>(query: string, ...bindings: unknown[]) => SQLCursorLike<Row>;
  };

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        // node:sqlite refuses statements with trailing whitespace through
        // prepare(); also we cache prepared statements per unique query
        // string to keep the fixture fast.
        const key = query;
        let stmt = this.cache.get(key);
        if (stmt === undefined) {
          stmt = this.db.prepare(query);
          this.cache.set(key, stmt);
        }
        const normalizedBindings = bindings.map(toSQLiteValue);
        const rows = (stmt.all(...(normalizedBindings as never[])) as Row[]) ?? [];
        return new TestCursor<Row>(rows);
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = closure();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    // StatementSync instances are released when the database closes.
    this.cache.clear();
    this.db.close();
  }
}

// node:sqlite is strict about input shapes: it accepts strings, numbers,
// bigints, null, and Uint8Array but not undefined, Buffer subclasses
// other than Uint8Array, or booleans. Normalize.
function toSQLiteValue(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  throw new TypeError(`SQLiteTestStorage cannot bind value of type ${typeof value}`);
}
