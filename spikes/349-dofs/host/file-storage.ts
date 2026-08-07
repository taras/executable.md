import { DatabaseSync, type StatementSync } from "node:sqlite";
// @ts-types="./types/dofs.d.ts"
import type {
  DurableObjectStorageLike,
  SQLCursorLike,
} from "@cloudflare/dofs";

class Cursor<Row extends object> implements SQLCursorLike<Row> {
  #rows: Row[];
  constructor(rows: Row[]) {
    this.#rows = rows;
  }
  toArray(): Row[] {
    return this.#rows;
  }
}

// File-backed DurableObjectStorageLike over node:sqlite. Mirrors dofs's own
// SQLiteTestStorage (vendor/dofs/src/testing.ts) — prepared-statement cache,
// binding normalization, BEGIN/COMMIT/ROLLBACK — but opens a real database
// file, which is the entire difference between a unit-test fixture and a
// persistent local workspace.
export class FileSQLiteStorage implements DurableObjectStorageLike {
  #db: DatabaseSync;
  #cache = new Map<string, StatementSync>();
  readonly sql: {
    exec: <Row extends object>(
      query: string,
      ...bindings: unknown[]
    ) => SQLCursorLike<Row>;
  };

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.sql = {
      exec: <Row extends object>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> => {
        let statement = this.#cache.get(query);
        if (statement === undefined) {
          statement = this.#db.prepare(query);
          this.#cache.set(query, statement);
        }
        const normalized = bindings.map(toSQLiteValue);
        const rows: Row[] = [];
        for (const row of statement.all(...normalized)) {
          if (isRow<Row>(row)) {
            rows.push(row);
          }
        }
        return new Cursor(rows);
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = closure();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#cache.clear();
    this.#db.close();
  }
}

type SQLiteValue = null | number | bigint | string | Uint8Array;

function toSQLiteValue(value: unknown): SQLiteValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new TypeError(
    `FileSQLiteStorage cannot bind value of type ${typeof value}`,
  );
}

function isRow<Row extends object>(value: unknown): value is Row {
  return typeof value === "object" && value !== null;
}
