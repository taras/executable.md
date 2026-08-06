// Opens the DOFS workspace this spike executes against. The database file is
// the workspace identity and the only filesystem source of truth; #349 proves
// its persistence and isolation properties.

import { DatabaseSync, type StatementSync } from "node:sqlite";
// @ts-types="./types/dofs.d.ts"
import { Database, initializeSchema } from "@cloudflare/dofs";
import type {
  DurableObjectStorageLike,
  SQLCursorLike,
} from "./types/dofs.d.ts";
import { WorkspaceFsShim } from "./workspace-fs.ts";

class Cursor<Row extends object> implements SQLCursorLike<Row> {
  #rows: Row[];
  constructor(rows: Row[]) {
    this.#rows = rows;
  }
  toArray(): Row[] {
    return this.#rows;
  }
}

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
      exec: <Row extends object>(query: string, ...bindings: unknown[]) => {
        let statement = this.#cache.get(query);
        if (statement === undefined) {
          statement = this.#db.prepare(query);
          this.#cache.set(query, statement);
        }
        const rows: Row[] = [];
        for (const row of statement.all(...bindings.map(toSQLiteValue))) {
          if (typeof row === "object" && row !== null) {
            rows.push(row as Row);
          }
        }
        return new Cursor(rows);
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const value = closure();
      this.#db.exec("COMMIT");
      return value;
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
  throw new TypeError(`cannot bind value of type ${typeof value}`);
}

export interface OpenWorkspace {
  fs: WorkspaceFsShim;
  storage: FileSQLiteStorage;
  db: Database;
}

export function openWorkspace(dbPath: string): OpenWorkspace {
  const storage = new FileSQLiteStorage(dbPath);
  const db = new Database(storage);
  initializeSchema(db, Date.now);
  return { fs: new WorkspaceFsShim(db), storage, db };
}
