import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { Database as CloudflareDatabase } from "../../vendor/cloudflare-computer-dofs/generated/storage.js";
import { WorkspaceFilesystem } from "../../vendor/cloudflare-computer-dofs/generated/fs/filesystem.js";
import { clearBlobCache } from "../../vendor/cloudflare-computer-dofs/generated/fs/blobCache.js";
import { clearResolveCache } from "../../vendor/cloudflare-computer-dofs/generated/fs/resolveCache.js";
import type {
  DurableObjectStorageLike,
  SQLCursorLike,
  SQLStorageLike,
} from "../../vendor/cloudflare-computer-dofs/generated/types.d.ts";
import { type ConnectionLock, createConnectionLock } from "./lock.ts";
import { createSavepointManager, type SavepointManager } from "./savepoints.ts";

export interface RunConnection {
  readonly path: string;
  readonly database: DatabaseSync;
  readonly dofs: CloudflareDatabase;
  readonly filesystem: WorkspaceFilesystem;
  readonly lock: ConnectionLock;
  readonly savepoints: SavepointManager;
  transactionOpen: boolean;
  invalidateDofsCaches(): void;
  setClock(now: () => number): void;
  close(): void;
}

export interface WorkflowRunConnections {
  at(path: string): RunConnection;
  close(): void;
}

class SqliteStorage implements SQLStorageLike {
  readonly database: DatabaseSync;
  readonly savepoints: () => SavepointManager;

  constructor(database: DatabaseSync, savepoints: () => SavepointManager) {
    this.database = database;
    this.savepoints = savepoints;
  }

  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SQLCursorLike<Row> {
    const statement = this.database.prepare(query);
    const rows = Reflect.apply(statement.all, statement, bindings);
    return {
      toArray(): Row[] {
        return rows;
      },
    };
  }
}

function createConnection(path: string): RunConnection {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    database.close();
    throw error;
  }

  let open = true;
  const connection: {
    savepoints: SavepointManager | undefined;
    transactionOpen: boolean;
  } = { savepoints: undefined, transactionOpen: false };
  const storage = new SqliteStorage(database, () => {
    const savepoints = connection.savepoints;
    if (savepoints === undefined) {
      throw new WorkflowConnectionStateError("the savepoint manager is not installed");
    }
    return savepoints;
  });
  const durableStorage: DurableObjectStorageLike = {
    sql: storage,
    transactionSync<T>(closure: () => T): T {
      return storage.savepoints().synchronous(closure);
    },
  };
  const dofs = new CloudflareDatabase(durableStorage);
  const savepoints = createSavepointManager(database, () => connection.transactionOpen);
  connection.savepoints = savepoints;
  let clock = Date.now;

  return {
    path,
    database,
    dofs,
    filesystem: new WorkspaceFilesystem(dofs, { now: () => clock() }),
    lock: createConnectionLock(),
    savepoints,
    get transactionOpen() {
      return connection.transactionOpen;
    },
    set transactionOpen(value: boolean) {
      connection.transactionOpen = value;
    },
    invalidateDofsCaches(): void {
      clearResolveCache(dofs);
      clearBlobCache(dofs);
    },
    setClock(now: () => number): void {
      clock = now;
    },
    close() {
      if (open) {
        open = false;
        database.close();
      }
    },
  };
}

export class WorkflowConnectionStateError extends Error {
  override name = "WorkflowConnectionStateError";
}

export function createWorkflowRunConnections(): WorkflowRunConnections {
  const entries = new Map<string, RunConnection>();
  let open = true;

  return {
    at(path: string): RunConnection {
      if (!open) {
        throw new WorkflowConnectionStateError("the workflow storage provider has closed");
      }
      const canonical = resolve(path);
      const existing = entries.get(canonical);
      if (existing !== undefined) {
        return existing;
      }
      const created = createConnection(canonical);
      entries.set(canonical, created);
      return created;
    },

    close(): void {
      if (!open) {
        return;
      }
      open = false;
      for (const entry of entries.values()) {
        entry.close();
      }
      entries.clear();
    },
  };
}
