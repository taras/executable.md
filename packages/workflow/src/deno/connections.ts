import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";
import {
  claimDurableStreamProvenance,
  type DurableStream,
  type DurableStreamProvenance,
} from "@executablemd/durable-streams";
import { WorkflowTransactionError } from "../storage/errors.ts";
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
import {
  createSavepointManager,
  type SavepointManager,
  type SavepointObserver,
  type SavepointTransaction,
} from "./savepoints.ts";

export class ConnectionGeneration {
  #opaque = undefined;
}

export class TransactionIdentity {
  #opaque = undefined;
}

export class WorkflowRunTransactionToken {
  #opaque = undefined;
}

export interface RunConnectionLease {
  readonly connection: RunConnection;
  readonly generation: ConnectionGeneration;
  readonly path: string;
  readonly database: WorkflowRunDatabase;
  journalProvenance: DurableStreamProvenance | undefined;
  open: boolean;
}

export interface RunTransaction extends SavepointTransaction {
  readonly path: string;
  readonly generation: ConnectionGeneration;
  readonly identity: TransactionIdentity;
  readonly lease: RunConnectionLease | undefined;
  handle: WorkflowRunTransaction | undefined;
  open: boolean;
  failure: unknown | undefined;
}

export interface RunConnection {
  readonly path: string;
  readonly generation: ConnectionGeneration;
  readonly database: DatabaseSync;
  readonly dofs: CloudflareDatabase;
  readonly filesystem: WorkspaceFilesystem;
  readonly lock: ConnectionLock;
  readonly savepoints: SavepointManager;
  invalidateDofsCaches(): void;
  beginTransaction(lease?: RunConnectionLease): RunTransaction;
  bindTransaction(transaction: RunTransaction, handle: WorkflowRunTransaction): void;
  validateTransaction(transaction: RunTransaction): void;
  finishTransaction(transaction: RunTransaction): void;
  currentTransaction(): RunTransaction;
  setClock(now: () => number): void;
  close(): void;
}

export interface WorkflowRunConnections {
  at(path: string): RunConnection;
  registerLease(database: WorkflowRunDatabase, connection: RunConnection): RunConnectionLease;
  registerJournal(database: WorkflowRunDatabase, journal: DurableStream): void;
  closeLease(lease: RunConnectionLease): void;
  validateLease(database: WorkflowRunDatabase): RunConnectionLease;
  validateJournal(database: WorkflowRunDatabase, journal: DurableStream): void;
  authorizeTransaction(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
  ): RunTransaction;
  issueToken(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
  ): WorkflowRunTransactionToken;
  validateToken(database: WorkflowRunDatabase, token: WorkflowRunTransactionToken): RunTransaction;
  close(): void;
}

class SqliteStorage implements SQLStorageLike {
  readonly database: DatabaseSync;
  readonly connection: () => RunConnection;

  constructor(database: DatabaseSync, connection: () => RunConnection) {
    this.database = database;
    this.connection = connection;
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

function createConnection(path: string, observeSavepoint: SavepointObserver): RunConnection {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    database.close();
    throw error;
  }

  const generation = new ConnectionGeneration();
  let open = true;
  let active: RunTransaction | undefined;
  let installed: RunConnection | undefined;

  function validate(transaction: SavepointTransaction): void {
    if (!open || active !== transaction || !transaction.open) {
      throw new WorkflowTransactionError(
        "the caller-owned workflow transaction is missing, foreign, stale, or already finished.",
      );
    }
    if (active.path !== path || active.generation !== generation) {
      throw new WorkflowTransactionError(
        "the caller-owned workflow transaction does not belong to this connection generation.",
      );
    }
    if (active.failure !== undefined) {
      throw new WorkflowTransactionError(
        "the caller-owned workflow transaction cannot continue after a savepoint failure.",
      );
    }
  }

  const savepoints = createSavepointManager(
    database,
    {
      validate,
      poison(transaction, failure): void {
        if (active === transaction && transaction.open) {
          active.failure = failure;
        }
      },
      afterRollback(transaction): void {
        validate(transaction);
        if (installed === undefined) {
          throw new WorkflowConnectionStateError("the workflow connection is not installed");
        }
        installed.invalidateDofsCaches();
      },
    },
    observeSavepoint,
  );
  const storage = new SqliteStorage(database, () => {
    if (installed === undefined) {
      throw new WorkflowConnectionStateError("the workflow connection is not installed");
    }
    return installed;
  });
  const durableStorage: DurableObjectStorageLike = {
    sql: storage,
    transactionSync<T>(closure: () => T): T {
      const connection = storage.connection();
      return connection.savepoints.synchronous(connection.currentTransaction(), closure);
    },
  };
  const dofs = new CloudflareDatabase(durableStorage);
  let clock = Date.now;

  const connection: RunConnection = {
    path,
    generation,
    database,
    dofs,
    filesystem: new WorkspaceFilesystem(dofs, { now: () => clock() }),
    lock: createConnectionLock(),
    savepoints,

    beginTransaction(lease?: RunConnectionLease): RunTransaction {
      if (!open || active !== undefined) {
        throw new WorkflowTransactionError(
          "the authoritative workflow connection cannot open another transaction.",
        );
      }
      if (
        lease !== undefined &&
        (!lease.open || lease.connection !== connection || lease.generation !== generation)
      ) {
        throw new WorkflowTransactionError(
          "the workflow database lease is foreign, stale, or already closed.",
        );
      }
      const transaction: RunTransaction = {
        path,
        generation,
        identity: new TransactionIdentity(),
        lease,
        handle: undefined,
        open: true,
        failure: undefined,
      };
      active = transaction;
      return transaction;
    },

    bindTransaction(transaction: RunTransaction, handle: WorkflowRunTransaction): void {
      validate(transaction);
      if (transaction.lease === undefined || transaction.handle !== undefined) {
        throw new WorkflowTransactionError(
          "the caller-owned workflow transaction cannot be associated with this handle.",
        );
      }
      transaction.handle = handle;
    },

    invalidateDofsCaches(): void {
      clearResolveCache(dofs);
      clearBlobCache(dofs);
    },

    validateTransaction(transaction: RunTransaction): void {
      validate(transaction);
    },

    finishTransaction(transaction: RunTransaction): void {
      if (!open || active !== transaction || !transaction.open) {
        throw new WorkflowTransactionError(
          "the caller-owned workflow transaction is missing, foreign, stale, or already finished.",
        );
      }
      transaction.open = false;
      active = undefined;
    },

    currentTransaction(): RunTransaction {
      if (active === undefined) {
        throw new WorkflowTransactionError(
          "a DOFS savepoint needs an active caller-owned workflow transaction.",
        );
      }
      validate(active);
      return active;
    },

    setClock(now: () => number): void {
      clock = now;
    },

    close(): void {
      if (open) {
        open = false;
        if (active !== undefined) {
          active.open = false;
          active = undefined;
        }
        database.close();
      }
    },
  };
  installed = connection;
  return connection;
}

export class WorkflowConnectionStateError extends Error {
  override name = "WorkflowConnectionStateError";
}

export function createWorkflowRunConnections(
  observeSavepoint: SavepointObserver = () => {},
): WorkflowRunConnections {
  const entries = new Map<string, RunConnection>();
  const leases = new WeakMap<WorkflowRunDatabase, RunConnectionLease>();
  const tokens = new WeakMap<WorkflowRunTransactionToken, RunTransaction>();
  let open = true;

  function validateLease(database: WorkflowRunDatabase): RunConnectionLease {
    const lease = leases.get(database);
    if (
      !open ||
      lease === undefined ||
      !lease.open ||
      lease.connection.generation !== lease.generation ||
      lease.connection.path !== lease.path
    ) {
      throw new WorkflowTransactionError(
        "the WorkflowRun database handle is foreign, fabricated, stale, or already closed.",
      );
    }
    return lease;
  }

  function authorizeTransaction(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
  ): RunTransaction {
    const lease = validateLease(database);
    const active = lease.connection.currentTransaction();
    if (active.lease !== lease || active.handle !== transaction) {
      throw new WorkflowTransactionError(
        "the WorkflowRun transaction handle is missing, foreign, stale, or already finished.",
      );
    }
    return active;
  }

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
      const created = createConnection(canonical, observeSavepoint);
      entries.set(canonical, created);
      return created;
    },

    registerLease(database: WorkflowRunDatabase, connection: RunConnection): RunConnectionLease {
      if (!open || entries.get(connection.path) !== connection) {
        throw new WorkflowTransactionError(
          "the WorkflowRun database cannot lease a foreign or stale connection.",
        );
      }
      const lease: RunConnectionLease = {
        connection,
        generation: connection.generation,
        path: connection.path,
        database,
        journalProvenance: undefined,
        open: true,
      };
      leases.set(database, lease);
      return lease;
    },

    registerJournal(database: WorkflowRunDatabase, journal: DurableStream): void {
      const lease = validateLease(database);
      if (lease.journalProvenance !== undefined) {
        throw new WorkflowTransactionError(
          "the WorkflowRun database journal identity is already installed.",
        );
      }
      lease.journalProvenance = claimDurableStreamProvenance(journal);
    },

    closeLease(lease: RunConnectionLease): void {
      lease.open = false;
    },

    validateLease,

    validateJournal(database: WorkflowRunDatabase, journal: DurableStream): void {
      const provenance = validateLease(database).journalProvenance;
      if (provenance === undefined || !provenance.matches(journal)) {
        throw new WorkflowTransactionError(
          "the live Workspace journal is foreign to the selected WorkflowRun database.",
        );
      }
    },
    authorizeTransaction,

    issueToken(
      database: WorkflowRunDatabase,
      transaction: WorkflowRunTransaction,
    ): WorkflowRunTransactionToken {
      const active = authorizeTransaction(database, transaction);
      const token = new WorkflowRunTransactionToken();
      tokens.set(token, active);
      return token;
    },

    validateToken(
      database: WorkflowRunDatabase,
      token: WorkflowRunTransactionToken,
    ): RunTransaction {
      const lease = validateLease(database);
      const transaction = tokens.get(token);
      if (transaction === undefined || transaction.lease !== lease) {
        throw new WorkflowTransactionError(
          "the WorkflowRun transaction token is foreign, fabricated, or stale.",
        );
      }
      lease.connection.validateTransaction(transaction);
      return transaction;
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
