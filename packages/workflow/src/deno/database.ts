/**
 * One run's open database.
 *
 * Every operation here runs on one connection, one at a time, inside a
 * transaction of its own. SQLite is reached synchronously but the operations
 * built on it are not, so the adapter serializes the connection rather than
 * relying on callers to take turns with it.
 *
 * ## Lifetime
 *
 * The handle belongs to the scope that opened it. When that scope ends the
 * connection closes, and every later call answers with a closed-handle failure
 * rather than reopening the file behind the caller's back.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure, Err, Ok, type Operation, resource, type Result, scoped } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import {
  WorkflowDatabaseClosedError,
  WorkflowDatabaseFormatError,
  WorkflowDocumentExecutionError,
  WorkflowRequestError,
} from "../storage/errors.ts";
import { parseJsonValue } from "../storage/members.ts";
import {
  canonicalJson,
  type DefinitionRetrieval,
  type DocumentExecutionCompletion,
  type DocumentExecutionRecord,
  parseStopReasonInput,
  type StoredRunState,
  type WorkflowRunRecord,
  type WorkflowStopReason,
} from "../storage/record.ts";
import { type ConnectionLock, createConnectionLock } from "./lock.ts";
import { readDocumentExecution, readRetrieval, readRunRecord, stopReasonColumns } from "./rows.ts";
import { translateSqliteError } from "./schema.ts";

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
  readonly database: DatabaseSync;
  readonly path: string;
  readonly record: WorkflowRunRecord;
}

/**
 * Open a run's database for the life of the calling scope.
 *
 * The connection closes through ordinary teardown rather than a caller
 * remembering to close it, so an interrupted host leaves no connection open on
 * a file another process is about to take a write lock on.
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

function createHandle(connection: OpenConnection): Handle {
  const { database, path } = connection;
  const lock: ConnectionLock = createConnectionLock();

  let closed = false;
  let record = connection.record;
  let retrieval = readRetrievalRow(database);

  /** Whether this scope may still reach the connection at all. */
  function admit(): Result<void> {
    if (closed) {
      return Err(new WorkflowDatabaseClosedError(record.runId));
    }
    return Ok();
  }

  /** One turn at the connection, inside a transaction of its own. */
  function* write<T>(body: () => T): Operation<Result<T>> {
    const admitted = admit();
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
    const admitted = admit();
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

  const handle: WorkflowRunDatabase = {
    get record() {
      return record;
    },

    get retrieval() {
      return retrieval;
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

      // Revisions count replacements since the metadata was last cleared;
      // clearing removes the row, and the next replacement starts over at one.
      const revision = (retrieval?.revision ?? 0) + 1;
      const updatedAt = now();

      const written = yield* write(() => {
        database.prepare(UPSERT_RETRIEVAL).run(canonical, revision, updatedAt);
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
      completion: DocumentExecutionCompletion,
    ): Operation<Result<DocumentExecutionRecord>> {
      const reason = checkedStopReason(completion.reason);
      if (!reason.ok) {
        return reason;
      }
      const columns = stopReasonColumns(reason.value);
      const stoppedAt = now();

      return yield* write(() => {
        const changed = database
          .prepare(FINISH_EXECUTION)
          .run(
            stoppedAt,
            completion.status,
            columns.kind,
            columns.code,
            columns.eventId,
            completion.executionId,
          );
        if (changed.changes === 0) {
          throw new WorkflowDocumentExecutionError(completion.executionId);
        }
        return readExecution(database, completion.executionId);
      });
    },

    *readDocumentExecutions(): Operation<Result<DocumentExecutionRecord[]>> {
      return yield* read(() =>
        database.prepare(SELECT_EXECUTIONS).all().map(readDocumentExecution),
      );
    },

    *updateRunState(state: StoredRunState): Operation<Result<WorkflowRunRecord>> {
      const reason = checkedStopReason(state.reason);
      if (!reason.ok) {
        return reason;
      }
      const columns = stopReasonColumns(reason.value);
      const updatedAt = now();

      const written = yield* write(() => {
        database
          .prepare(UPDATE_RUN_STATE)
          .run(state.status, columns.kind, columns.code, columns.eventId, updatedAt);
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
      database.close();
    },
  };
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

function checkedStopReason(
  reason: WorkflowStopReason | undefined,
): Result<WorkflowStopReason | undefined> {
  if (reason === undefined) {
    return Ok(undefined);
  }
  return parseStopReasonInput(reason);
}

function retrievalFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `the retrieval metadata is not a JSON value: ${reason} at ${path}`,
  );
}

/** The run the singleton row describes, for whoever opened the file. */
export function readRunRow(database: DatabaseSync, path: string): WorkflowRunRecord {
  const row = database.prepare(SELECT_RUN).get();
  if (row === undefined) {
    throw new WorkflowDatabaseFormatError(path, "its workflow_run row is missing");
  }
  return readRunRecord(row);
}

function readRetrievalRow(database: DatabaseSync): DefinitionRetrieval | undefined {
  const row = database.prepare(SELECT_RETRIEVAL).get();
  return row === undefined ? undefined : readRetrieval(row);
}

function readExecution(database: DatabaseSync, executionId: string): DocumentExecutionRecord {
  const row = database.prepare(SELECT_EXECUTION).get(executionId);
  if (row === undefined) {
    throw new WorkflowDocumentExecutionError(executionId);
  }
  return readDocumentExecution(row);
}

function now(): string {
  return new Date().toISOString();
}
