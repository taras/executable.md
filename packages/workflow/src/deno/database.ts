/**
 * One run's open database, and the transaction a caller can hold.
 *
 * Every operation here runs on one connection, one at a time, inside a
 * transaction. SQLite is reached synchronously but the operations built on it
 * are not, so the adapter serializes the connection rather than relying on
 * callers to take turns with it. A standalone append and a caller's
 * multi-statement transaction reach SQLite through the same insertion routine,
 * so there is no second write path to keep in agreement with the first.
 *
 * ## Enlistment travels with the caller
 *
 * `transact()` hands its body a `WorkflowRunTransaction`, and that object — not
 * the database — is what joins work to the transaction. Work that never
 * received one cannot enlist by accident, so an append happening elsewhere
 * waits for its own turn and commits on its own rather than being rolled back
 * with a failure it had nothing to do with.
 *
 * A scope-local marker records which database this scope holds a transaction
 * on. That is how a nested `transact()` is refused, and how an operation
 * called from inside a transaction body is refused rather than waiting for a
 * transaction its own caller is holding open. The marker is structural and the
 * savepoint that goes with it is a contextual operation; both live in
 * `transaction.ts`.
 *
 * ## Lifetime
 *
 * The handle belongs to the scope that opened it. When that scope ends its
 * lease closes, and every later call answers with a closed-handle failure. The
 * provider owns the authoritative physical connection for its own scope.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure, Err, Ok, type Operation, resource, type Result, scoped } from "effection";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import type { JournalEntry, WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";
import {
  WorkflowDatabaseClosedError,
  WorkflowDatabaseCorruptError,
  WorkflowDocumentExecutionError,
  WorkflowRequestError,
  WorkflowTransactionError,
} from "../storage/errors.ts";
import { parseJsonValue } from "../storage/members.ts";
import {
  canonicalJson,
  type DefinitionRetrieval,
  type DocumentExecutionCompletion,
  type DocumentExecutionRecord,
  parseDocumentExecutionCompletion,
  parseStoredRunState,
  type StoredRunState,
  type WorkflowRunRecord,
} from "../storage/record.ts";
import { insertJournalEvent, readJournalEntries } from "./journal.ts";
import type { RunConnection } from "./connections.ts";
import {
  ActiveTransaction,
  enclosing,
  holdsTransactionOn,
  useTransactionSavepoints,
} from "./transaction.ts";
import { readDocumentExecution, readRetrieval, readRunRecord, stopReasonColumns } from "./rows.ts";
import { reading } from "./reading.ts";
import { isSqliteForeignKeyConstraint, translateSqliteError } from "./schema.ts";

const SELECT_RUN = "SELECT * FROM workflow_run WHERE id = 1";
const UPDATE_RUN_STATE = `UPDATE workflow_run
  SET status = ?, stop_reason_kind = ?, stop_reason_code = ?, stop_reason_event_id = ?,
      updated_at = ?
  WHERE id = 1`;
const SELECT_RETRIEVAL = "SELECT * FROM definition_retrieval WHERE id = 1";
const UPSERT_RETRIEVAL = `INSERT INTO definition_retrieval (id, metadata, revision, updated_at)
  VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE
  SET metadata = excluded.metadata, revision = excluded.revision,
      updated_at = excluded.updated_at`;
const DELETE_RETRIEVAL = "DELETE FROM definition_retrieval WHERE id = 1";
const INSERT_EXECUTION = "INSERT INTO document_executions (execution_id, started_at) VALUES (?, ?)";
const FINISH_EXECUTION = `UPDATE document_executions
  SET stopped_at = ?, stop_status = ?, stop_reason_kind = ?, stop_reason_code = ?,
      stop_reason_event_id = ?
  WHERE execution_id = ? AND stopped_at IS NULL`;
const SELECT_EXECUTION = "SELECT * FROM document_executions WHERE execution_id = ?";
const SELECT_EXECUTIONS = "SELECT * FROM document_executions ORDER BY sequence ASC";

/** What opening needs from whoever found the file and checked its schema. */
export interface OpenConnection {
  readonly connection: RunConnection;
  readonly record: WorkflowRunRecord;
}

/**
 * Open a scope-owned lease on a run's provider-owned database connection.
 */
export function openWorkflowRunDatabase(
  connection: OpenConnection,
): Operation<WorkflowRunDatabase> {
  return resource(function* (provide) {
    const handle = createHandle(connection);
    yield* ensure(() => {
      handle.close();
    });
    yield* provide(handle.database);
  });
}

interface Handle {
  readonly database: WorkflowRunDatabase;
  close(): void;
}

const DENO_CONNECTION = Symbol("executablemd.workflow.deno.connection");

interface DenoWorkflowRunDatabase extends WorkflowRunDatabase {
  readonly [DENO_CONNECTION]: RunConnection;
}

export function workflowRunConnection(database: WorkflowRunDatabase): RunConnection {
  if (!isDenoWorkflowRunDatabase(database)) {
    throw new WorkflowTransactionError(
      "the WorkflowRun database is not owned by this Deno storage provider.",
    );
  }
  return database[DENO_CONNECTION];
}

function isDenoWorkflowRunDatabase(
  database: WorkflowRunDatabase,
): database is DenoWorkflowRunDatabase {
  return DENO_CONNECTION in database;
}

function createHandle(connection: OpenConnection): Handle {
  const { database, path, lock } = connection.connection;

  let closed = false;
  let record = connection.record;
  let retrieval = readRetrievalRow(database);

  /** Whether this scope may reach the database at all, and why not. */
  function* admit(): Operation<Result<void>> {
    if (closed) {
      return Err(new WorkflowDatabaseClosedError(record.runId));
    }
    if (yield* holdsTransactionOn(path)) {
      return Err(
        new WorkflowTransactionError(
          "this scope is inside a transaction on the same workflow run database, and an " +
            "operation outside that transaction cannot run until it commits. Use the " +
            "transaction handed to the body, or move the operation outside it.",
        ),
      );
    }
    return Ok();
  }

  /** One turn at the connection, inside a transaction of its own. */
  function* write<T>(body: () => T): Operation<Result<T>> {
    const admitted = yield* admit();
    if (!admitted.ok) {
      return admitted;
    }
    return yield* scoped(function* (): Operation<Result<T>> {
      yield* lock.hold();
      return inTransaction(database, path, body);
    });
  }

  /** One turn at the connection, reading only. */
  function* read<T>(body: () => T): Operation<Result<T>> {
    const admitted = yield* admit();
    if (!admitted.ok) {
      return admitted;
    }
    return yield* scoped(function* (): Operation<Result<T>> {
      yield* lock.hold();
      try {
        return Ok(body());
      } catch (error) {
        return Err(translateSqliteError(error, path));
      }
    });
  }

  function* transact<T>(
    body: (transaction: WorkflowRunTransaction) => Operation<T>,
  ): Operation<Result<T>> {
    if (closed) {
      return Err(new WorkflowDatabaseClosedError(record.runId));
    }
    if (yield* holdsTransactionOn(path)) {
      return Err(
        new WorkflowTransactionError(
          "a transaction on this workflow run database is already open in this scope. " +
            "Nesting one inside another would commit or roll back work the outer " +
            "transaction has not finished deciding about.",
        ),
      );
    }

    return yield* scoped(function* (): Operation<Result<T>> {
      yield* lock.hold();

      try {
        database.exec("BEGIN IMMEDIATE");
      } catch (error) {
        return Err(translateSqliteError(error, path));
      }

      const transaction = { open: true };
      connection.connection.transactionOpen = true;
      let committed = false;

      // Registered after the lock, so teardown rolls back while the connection
      // is still ours and releases it only once that is done.
      yield* ensure(() => {
        transaction.open = false;
        connection.connection.transactionOpen = false;
        if (!committed) {
          rollback(database);
          connection.connection.invalidateDofsCaches();
        }
      });

      // The chain, not just this path: a transaction on another run nested
      // inside this one must not hide that this one is held.
      yield* ActiveTransaction.set(yield* enclosing(path));
      yield* useTransactionSavepoints(connection.connection.savepoints, () => transaction.open);

      try {
        // The body runs in a scope of its own, so everything it started —
        // spawned children, resources — has finished tearing down before
        // anything is committed. Cleanup appends through the same transaction
        // and belongs inside it; committing while a child was still unwinding
        // would let that append autocommit on its own, published whatever the
        // transaction went on to decide.
        const value = yield* scoped(function* () {
          return yield* body({
            journal: enlistedJournal(database, transaction, path),
          });
        });

        // Closed before the commit, not after: nothing may append to a
        // transaction whose contents are already decided.
        transaction.open = false;
        connection.connection.transactionOpen = false;
        database.exec("COMMIT");
        committed = true;
        return Ok(value);
      } catch (error) {
        transaction.open = false;
        connection.connection.transactionOpen = false;
        return Err(translateSqliteError(error, path));
      }
    });
  }

  const journal: DurableStream = {
    *readAll(): Operation<DurableEvent[]> {
      const entries = yield* mustSucceed(read(() => readJournalEntries(database)));
      return entries.map((entry) => entry.event);
    },

    *append(event: DurableEvent): Operation<void> {
      yield* mustSucceed(write(() => insertJournalEvent(database, event)));
    },
  };

  const handle: DenoWorkflowRunDatabase = {
    [DENO_CONNECTION]: connection.connection,

    get record() {
      return record;
    },

    get retrieval() {
      return retrieval;
    },

    journal,

    transact,

    *readJournalEntries(): Operation<Result<JournalEntry[]>> {
      return yield* read(() => readJournalEntries(database));
    },

    *replaceRetrievalMetadata(metadata: Json | undefined): Operation<Result<void>> {
      if (metadata === undefined) {
        const cleared = yield* write(() => {
          database.prepare(DELETE_RETRIEVAL).run();
        });
        if (!cleared.ok) {
          return cleared;
        }
        retrieval = undefined;
        return Ok();
      }

      let canonical: string;
      try {
        canonical = canonicalJson(parseJsonValue(metadata, "$", retrievalFailure));
      } catch (error) {
        return Err(error);
      }

      const written = yield* write(() => {
        // Read inside the transaction, not from this handle's snapshot. Two
        // handles opened before either replacement both hold no retrieval, and
        // would both write revision one — the second losing the first.
        // Revisions count replacements since the metadata was last cleared;
        // clearing removes the row, and the next replacement starts over.
        const stored = readRetrievalRow(database);
        database.prepare(UPSERT_RETRIEVAL).run(canonical, (stored?.revision ?? 0) + 1, now());
        return readRetrievalRow(database);
      });
      if (!written.ok) {
        return written;
      }
      retrieval = written.value;
      return Ok();
    },

    *beginDocumentExecution(): Operation<Result<DocumentExecutionRecord>> {
      const executionId = randomUUID();
      const startedAt = now();
      return yield* write(() => {
        database.prepare(INSERT_EXECUTION).run(executionId, startedAt);
        return readExecution(database, executionId);
      });
    },

    *finishDocumentExecution(
      offered: DocumentExecutionCompletion,
    ): Operation<Result<DocumentExecutionRecord>> {
      const checked = parseDocumentExecutionCompletion(offered);
      if (!checked.ok) {
        return checked;
      }
      const completion = checked.value;
      const columns = stopReasonColumns(completion.reason);
      const stoppedAt = now();

      return yield* write(() => {
        const changed = runStopReasonStatement(
          () =>
            database
              .prepare(FINISH_EXECUTION)
              .run(
                stoppedAt,
                completion.status,
                columns.kind,
                columns.code,
                columns.eventId,
                completion.executionId,
              ),
          path,
        );
        if (changed.changes === 0) {
          throw new WorkflowDocumentExecutionError(completion.executionId);
        }
        return readExecution(database, completion.executionId);
      });
    },

    *readDocumentExecutions(): Operation<Result<DocumentExecutionRecord[]>> {
      return yield* read(() =>
        reading(database, SELECT_EXECUTIONS).all().map(readDocumentExecution),
      );
    },

    *updateRunState(offered: StoredRunState): Operation<Result<WorkflowRunRecord>> {
      const checked = parseStoredRunState(offered);
      if (!checked.ok) {
        return checked;
      }
      const state = checked.value;
      const columns = stopReasonColumns(state.reason);
      const updatedAt = now();

      const written = yield* write(() => {
        runStopReasonStatement(
          () =>
            database
              .prepare(UPDATE_RUN_STATE)
              .run(state.status, columns.kind, columns.code, columns.eventId, updatedAt),
          path,
        );
        return readRunRow(database, path);
      });
      if (!written.ok) {
        return written;
      }
      record = written.value;
      return Ok(record);
    },
  };

  return {
    database: handle,
    close() {
      closed = true;
    },
  };
}

/**
 * The journal a transaction body appends through.
 *
 * Insertion only: the transaction that opened before the body ran is what
 * decides whether these rows survive, and nothing here commits.
 */
function enlistedJournal(
  database: DatabaseSync,
  transaction: { open: boolean },
  path: string,
): DurableStream {
  return {
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      assertOpen(transaction);
      try {
        return readJournalEntries(database).map((entry) => entry.event);
      } catch (error) {
        throw translateSqliteError(error, path);
      }
    },

    // deno-lint-ignore require-yield
    *append(event: DurableEvent): Operation<void> {
      assertOpen(transaction);
      try {
        insertJournalEvent(database, event);
      } catch (error) {
        throw translateSqliteError(error, path);
      }
    },
  };
}

function assertOpen(transaction: { open: boolean }): void {
  if (!transaction.open) {
    throw new WorkflowTransactionError(
      "this transaction has already finished, so nothing more can be appended through it. " +
        "A handle kept past the end of the body it was given commits nothing.",
    );
  }
}

/** A `DurableStream` reports a failure by raising it, so unwrap and throw. */
function* mustSucceed<T>(operation: Operation<Result<T>>): Operation<T> {
  const result = yield* operation;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function inTransaction<T>(database: DatabaseSync, path: string, body: () => T): Result<T> {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    return Err(translateSqliteError(error, path));
  }
  try {
    const value = body();
    database.exec("COMMIT");
    return Ok(value);
  } catch (error) {
    rollback(database);
    return Err(translateSqliteError(error, path));
  }
}

function runStopReasonStatement<T>(body: () => T, path: string): T {
  try {
    return body();
  } catch (error) {
    if (isSqliteForeignKeyConstraint(error)) {
      throw new WorkflowRequestError(
        "the stop reason names a journal event this run does not hold. A journal reason " +
          "points at an event that has already been appended and filtered.",
      );
    }
    throw translateSqliteError(error, path);
  }
}

/**
 * Roll back without reporting a failure of its own.
 *
 * A rollback that fails because no transaction is open has already achieved
 * what it was for, and raising here would replace the failure the caller is
 * being told about with one about the cleanup.
 */
function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    return;
  }
}

function retrievalFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `the retrieval metadata is not a JSON value: ${reason} at ${path}`,
  );
}

/**
 * The run the singleton row describes, for whoever opened the file.
 *
 * A database that has already said it is a version-1 workflow run, and then
 * has no run in it, disagrees with itself. That is damage rather than a file
 * belonging to somebody else.
 */
export function readRunRow(database: DatabaseSync, path: string): WorkflowRunRecord {
  const row = reading(database, SELECT_RUN).get();
  if (row === undefined) {
    throw new WorkflowDatabaseCorruptError(path, "it holds no workflow run");
  }
  return readRunRecord(row);
}

function readRetrievalRow(database: DatabaseSync): DefinitionRetrieval | undefined {
  const row = reading(database, SELECT_RETRIEVAL).get();
  return row === undefined ? undefined : readRetrieval(row);
}

function readExecution(database: DatabaseSync, executionId: string): DocumentExecutionRecord {
  const row = reading(database, SELECT_EXECUTION).get(executionId);
  if (row === undefined) {
    throw new WorkflowDocumentExecutionError(executionId);
  }
  return readDocumentExecution(row);
}

function now(): string {
  return new Date().toISOString();
}
