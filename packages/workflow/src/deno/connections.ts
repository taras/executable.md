import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { ensure, resource } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";
import {
  establishJournalProvenance,
  type DurableEvent,
  type DurableStream,
  type JournalProvenance,
} from "@executablemd/durable-streams";
import type { Operation } from "effection";
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
  releaseConnectionCoordination,
  takeConnectionCoordination,
} from "./recovery-coordination.ts";
import type { AdvisoryLockFile } from "./advisory-lock.ts";
import {
  createSavepointManager,
  type SavepointManager,
  type SavepointObserver,
  type SavepointTransaction,
} from "./savepoints.ts";

/**
 * The connections one host owns, for as long as it owns them.
 *
 * One authoritative connection per database is a storage invariant rather than a
 * convenience: the DOFS layer caches against it, and Workspace effect
 * transactions run serially on it. Storage and lifecycle write to the same
 * databases, so the host creates this once and hands the same registry to both
 * rather than letting either open a second writer.
 *
 * Passed explicitly. It carries operations, so it is not context data, and
 * "whichever installs first creates it" would have made one installer's
 * savepoint observation and hooks depend on installation order.
 *
 * It is coordination and nothing more: what may advance a run is the executor
 * lease, which every mutating transaction validates for itself.
 */
export function useWorkflowRunConnections(
  observeSavepoint: SavepointObserver = () => {},
  hooks: WorkflowRunConnectionHooks = {},
): Operation<WorkflowRunConnections> {
  return resource<WorkflowRunConnections>(function* (provide) {
    const connections = createWorkflowRunConnections(observeSavepoint, hooks);
    yield* ensure(() => {
      connections.close();
    });
    yield* provide(connections);
  });
}

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
  journalProvenance: JournalProvenance | undefined;
  open: boolean;
}

export interface RunTransaction extends SavepointTransaction {
  readonly path: string;
  readonly generation: ConnectionGeneration;
  readonly identity: TransactionIdentity;
  readonly lease: RunConnectionLease | undefined;
  /**
   * The opaque id of every event appended through this transaction, in order.
   *
   * A `DurableStream` carries events and not their identities, so an append
   * answers with nothing. A caller that has to name the event it just appended
   * — to retain something against it in this same transaction — reads its id
   * from here rather than asking the journal what is last, which would be
   * position standing in for identity.
   *
   * Uncommitted, like everything else on a transaction. A rollback takes the
   * rows and this list with it.
   */
  readonly appended: string[];
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
  at(path: string): Operation<RunConnection>;
  registerLease(database: WorkflowRunDatabase, connection: RunConnection): RunConnectionLease;
  registerJournal(database: WorkflowRunDatabase, journal: DurableStream): void;
  closeLease(lease: RunConnectionLease): void;
  validateLease(database: WorkflowRunDatabase): RunConnectionLease;
  validateJournalProvenance(
    database: WorkflowRunDatabase,
    provenance: JournalProvenance | undefined,
  ): void;
  afterRoutedJournalAppend(database: WorkflowRunDatabase, event: DurableEvent): Operation<void>;
  beforeCommit(database: WorkflowRunDatabase): Operation<void>;
  authorizeTransaction(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
  ): RunTransaction;
  issueToken(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
  ): WorkflowRunTransactionToken;
  validateToken(database: WorkflowRunDatabase, token: WorkflowRunTransactionToken): RunTransaction;
  /** Close and forget one run's connection, so its file can be removed. */
  close(path?: string): void;
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

function createConnection(
  path: string,
  observeSavepoint: SavepointObserver,
  coordination: AdvisoryLockFile,
): RunConnection {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    // Reads a page, and reading a page is what makes SQLite notice a rollback
    // journal a lost host left behind and put it back. The pragmas above settle
    // connection behavior without touching the file, so a connection that
    // stopped at them would have proven nothing about the state it is about to
    // write to. The caller holds recovery coordination across this line.
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
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
        appended: [],
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
        // Released only now: while this connection existed it could recover the
        // pair at any read, so it owned the pair for exactly that long.
        releaseConnectionCoordination(coordination);
      }
    },
  };
  installed = connection;
  return connection;
}

export class WorkflowConnectionStateError extends Error {
  override name = "WorkflowConnectionStateError";
}

export interface WorkflowRunConnectionHooks {
  afterRoutedJournalAppend?(database: WorkflowRunDatabase, event: DurableEvent): Operation<void>;
  beforeCommit?(database: WorkflowRunDatabase): Operation<void>;
}

// deno-lint-ignore require-yield
function* noop(): Operation<void> {
  return undefined;
}

export function createWorkflowRunConnections(
  observeSavepoint: SavepointObserver = () => {},
  hooks: WorkflowRunConnectionHooks = {},
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
    *at(path: string): Operation<RunConnection> {
      if (!open) {
        throw new WorkflowConnectionStateError("the workflow storage provider has closed");
      }
      const canonical = resolve(path);
      const existing = entries.get(canonical);
      if (existing !== undefined) {
        return existing;
      }
      // Taken for as long as the connection lives, not merely while it opens:
      // any later read through it can be the one that recovers a hot journal.
      const coordination = yield* takeConnectionCoordination(canonical);
      try {
        if (!open) {
          throw new WorkflowConnectionStateError("the workflow storage provider has closed");
        }
        // Asked again after the wait: another caller on this host may have
        // opened the same database while this one waited, and one authoritative
        // connection per database is what this registry exists to keep.
        const raced = entries.get(canonical);
        if (raced !== undefined) {
          releaseConnectionCoordination(coordination);
          return raced;
        }
        const created = createConnection(canonical, observeSavepoint, coordination);
        entries.set(canonical, created);
        return created;
      } catch (error) {
        releaseConnectionCoordination(coordination);
        throw error;
      }
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
          "the WorkflowRun database journal provenance is already installed.",
        );
      }
      lease.journalProvenance = establishJournalProvenance(journal);
    },

    closeLease(lease: RunConnectionLease): void {
      lease.open = false;
    },

    validateLease,

    validateJournalProvenance(
      database: WorkflowRunDatabase,
      provenance: JournalProvenance | undefined,
    ): void {
      const selected = validateLease(database).journalProvenance;
      if (selected === undefined || selected !== provenance) {
        throw new WorkflowTransactionError(
          "the live Workspace journal does not have the provenance of the selected WorkflowRun.",
        );
      }
    },

    afterRoutedJournalAppend(database: WorkflowRunDatabase, event: DurableEvent): Operation<void> {
      validateLease(database);
      return hooks.afterRoutedJournalAppend?.(database, event) ?? noop();
    },

    beforeCommit(database: WorkflowRunDatabase): Operation<void> {
      validateLease(database);
      return hooks.beforeCommit?.(database) ?? noop();
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

    close(path?: string): void {
      if (path !== undefined) {
        const canonical = resolve(path);
        const entry = entries.get(canonical);
        if (entry !== undefined) {
          entry.close();
          entries.delete(canonical);
        }
        return;
      }
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
