/**
 * Every write that moves a run's lifecycle, and the authority each one checks.
 *
 * One module holds the lifecycle SQL — creating the run, beginning a document
 * execution, finishing one, publishing a status — because these rows describe
 * one another. A begin that inserted an execution without publishing `running`,
 * or a settlement that finished the record without publishing the outcome, would
 * leave a run whose two halves disagree, and inspection would report whichever
 * half it happened to read.
 *
 * ## Authority is checked where it is used
 *
 * Each transition validates the exact live lease inside its own transaction,
 * not before opening it. A lease is only as good as the moment it is spent: one
 * validated in a caller and passed along could have been released by the time
 * the write lands.
 *
 * ## The bodies do not yield
 *
 * From the validation to the commit, a transition body is ordinary synchronous
 * code. Suspending in the middle would let the scope that owns the lease tear
 * down between "this caller may write" and the write — the transaction would
 * commit under an authority that no longer exists. What has to happen before
 * the transaction, like reading a control request off the filesystem, happens
 * before it.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Err, Ok, type Operation, type Result, scoped } from "effection";
import { exists } from "@effectionx/fs";
import type {
  PendingCancellation,
  WorkflowBeginRequest,
  WorkflowExecutionBegun,
} from "../lifecycle/execution.ts";
import { conflictingFields } from "../storage/compatibility.ts";
import { definitionToJson } from "../storage/definition.ts";
import {
  WorkflowDocumentExecutionError,
  WorkflowRequestError,
  WorkflowRunConflictError,
  WorkflowRunIdMismatchError,
  WorkflowRunNotFoundError,
  WorkflowStorageError,
} from "../storage/errors.ts";
import {
  canonicalJson,
  type DocumentExecutionCompletion,
  type DocumentExecutionRecord,
  parseDocumentExecutionCompletion,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "../storage/record.ts";
import type { RunConnection, RunTransaction, WorkflowRunConnections } from "./connections.ts";
import { openWorkflowRunDatabase, readRunRow } from "./database.ts";
import type { ExecutorHold } from "./executor.ts";
import { reading } from "./reading.ts";
import { readJournalEntries } from "./journal.ts";
import { readDocumentExecution, readRetrieval, stopReasonColumns } from "./rows.ts";
import {
  initializeSchema,
  isSqliteForeignKeyConstraint,
  isUninitialized,
  translateSqliteError,
  verifySchema,
} from "./schema.ts";

/** Shared with `create()`, so one statement writes an immutable run. */
export const INSERT_RUN = `INSERT INTO workflow_run
  (id, run_id, definition, base, props, status, created_at, updated_at)
  VALUES (1, ?, ?, ?, ?, 'running', ?, ?)`;
const UPDATE_RUN_STATE = `UPDATE workflow_run
  SET status = ?, stop_reason_kind = ?, stop_reason_code = ?, stop_reason_event_id = ?,
      updated_at = ?
  WHERE id = 1`;
const UPSERT_RETRIEVAL = `INSERT INTO definition_retrieval (id, metadata, revision, updated_at)
  VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE
  SET metadata = excluded.metadata, revision = excluded.revision,
      updated_at = excluded.updated_at`;
const SELECT_RETRIEVAL = "SELECT * FROM definition_retrieval WHERE id = 1";
const INSERT_EXECUTION = "INSERT INTO document_executions (execution_id, started_at) VALUES (?, ?)";
const FINISH_EXECUTION = `UPDATE document_executions
  SET stopped_at = ?, stop_status = ?, stop_reason_kind = ?, stop_reason_code = ?,
      stop_reason_event_id = ?
  WHERE execution_id = ? AND stopped_at IS NULL`;
const SELECT_EXECUTION = "SELECT * FROM document_executions WHERE execution_id = ?";
const SELECT_UNFINISHED =
  "SELECT * FROM document_executions WHERE stopped_at IS NULL ORDER BY sequence ASC";

/**
 * Begin one document execution under this exact lease.
 *
 * For a run that does not exist yet, the schema, the immutable run, its
 * retrieval metadata, an empty Workspace, the first execution record and
 * `running` are one transaction: a reader either finds a whole run or no run,
 * never a half-initialized one.
 */
export function* beginExecution(
  connections: WorkflowRunConnections,
  path: string,
  hold: ExecutorHold,
  authorize: () => ExecutorHold,
  request: WorkflowBeginRequest,
  pending: PendingCancellation | undefined,
): Operation<Result<BeginOutcome>> {
  // Asked before a connection exists, because opening one creates the file.
  // A resume that found nothing would otherwise leave an empty database behind
  // for `list` to refuse — inventing a candidate out of a failed lookup.
  if (request.action === "resume" && !(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(hold.runId));
  }

  // The caller pre-authorized to obtain this hold and the path it names, so a
  // fabricated lease is refused before a connection exists. The same lease is
  // checked again inside the transaction, because a scope can end in between.
  const connection = connections.at(path);

  // One transaction. Recovery decides what the previous owner's execution
  // became, admission decides whether this caller may continue, and an admitted
  // caller's execution is inserted — all or none. Splitting them would publish
  // a recovery that a refusal then had to leave behind, or leave a window where
  // this owner's own execution looks like somebody else's leftovers.
  const outcome = yield* scoped(function* (): Operation<Result<BegunRows | Refused>> {
    yield* connection.lock.hold();
    return inLifecycleTransaction(connection, path, () =>
      beginOnce(connection, path, sameHold(authorize, hold), request, pending),
    );
  });
  if (!outcome.ok) {
    // The transaction rolled back, so nothing was begun after all.
    hold.execution = undefined;
    return outcome;
  }
  if (outcome.value.kind === "refused") {
    return Ok(outcome.value);
  }

  const { record, execution, replay, closed } = outcome.value;
  const database = yield* openWorkflowRunDatabase({ connection, connections, record });
  return Ok({
    kind: "begun",
    database,
    record,
    execution,
    replay,
    ...(closed === undefined ? {} : { closed }),
  });
}

/**
 * What one begin transaction committed.
 *
 * A refusal is an outcome, not an absence: the previous owner's execution was
 * still accounted for, and that has to survive being told this caller may not
 * continue. The refusal itself is translated outside the transaction.
 */
export type BeginOutcome =
  | ({ readonly kind: "begun" } & WorkflowExecutionBegun & {
        readonly closed?: DocumentExecutionRecord;
      })
  | {
      readonly kind: "refused";
      readonly reason: Error;
      readonly closed?: DocumentExecutionRecord;
    };

interface BegunRows {
  readonly kind: "begun";
  readonly record: WorkflowRunRecord;
  readonly execution: DocumentExecutionRecord;
  readonly replay: boolean;
  readonly closed?: DocumentExecutionRecord;
}

/** What the run was after the previous owner's execution was accounted for. */
interface Recovery {
  /** Absent when there is no run yet, which only a `start` may go on from. */
  readonly status?: WorkflowRunStatus;
  readonly closed?: DocumentExecutionRecord;
}

interface Refused {
  readonly kind: "refused";
  readonly reason: Error;
  readonly closed?: DocumentExecutionRecord;
}

function recover(
  connection: RunConnection,
  path: string,
  hold: ExecutorHold,
  request: WorkflowBeginRequest,
  pending: PendingCancellation | undefined,
): Recovery {
  const { database } = connection;
  if (isUninitialized(database, path)) {
    return {};
  }

  verifySchema(database, path, connection.dofs);
  const stored = readRunRow(database, path);
  if (stored.runId !== hold.runId) {
    throw new WorkflowRunIdMismatchError(hold.runId, path);
  }
  if (request.creation !== undefined) {
    const differing = conflictingFields(stored, {
      runId: hold.runId,
      definition: request.creation.definition,
      base: request.creation.base,
      props: request.creation.props,
    });
    if (differing.length > 0) {
      throw new WorkflowRunConflictError(hold.runId, differing);
    }
  }

  // Whatever the previous owner left is proven stale: this caller holds the
  // lock, and this acquisition has begun nothing of its own.
  return reconcile(database, path, stored, pending);
}

function beginOnce(
  connection: RunConnection,
  path: string,
  hold: ExecutorHold,
  request: WorkflowBeginRequest,
  pending: PendingCancellation | undefined,
): BegunRows | Refused {
  // An acquisition begins one execution. A second would find this owner's own
  // live execution and, seeing it unfinished, reconcile it as a dead executor's
  // leftovers — then start another beside it, under one lease.
  if (hold.execution !== undefined) {
    throw new WorkflowRequestError(
      "this executor lease has already begun a document execution. One acquisition begins one.",
    );
  }

  const recovery = recover(connection, path, hold, request, pending);

  // A file can exist and hold nothing — created by an interrupted attempt, or
  // left empty by something else. Existence is not a run, so a resume that
  // reaches one refuses here rather than letting the creation it happens to
  // carry initialize the run it failed to find.
  if (request.action === "resume" && recovery.status === undefined) {
    return { kind: "refused", reason: new WorkflowRunNotFoundError(hold.runId) };
  }

  const refusal = admissionRefusal(request.action, recovery.status);
  if (refusal !== undefined) {
    // Committed all the same: what the previous owner's execution became is not
    // undone by this caller being told it may not continue.
    return {
      kind: "refused",
      reason: refusal,
      ...(recovery.closed === undefined ? {} : { closed: recovery.closed }),
    };
  }

  const { database } = connection;
  const begun = begin(connection, path, hold, request, recovery);
  hold.execution = begun.execution.executionId;
  return {
    ...begun,
    ...(recovery.closed === undefined ? {} : { closed: recovery.closed }),
    record: readRunRow(database, path),
  };
}

/**
 * Finish this execution and publish what the run became, together.
 *
 * A status line says what was retained, so the record that says the execution
 * ended and the state that says what it ended as commit at once or not at all.
 */
export function* settleExecution(
  connections: WorkflowRunConnections,
  path: string,
  hold: ExecutorHold,
  authorize: () => ExecutorHold,
  offered: DocumentExecutionCompletion,
): Operation<Result<WorkflowRunRecord>> {
  const checked = parseDocumentExecutionCompletion(offered);
  if (!checked.ok) {
    return checked;
  }
  const completion = checked.value;
  const connection = connections.at(path);

  return yield* scoped(function* (): Operation<Result<WorkflowRunRecord>> {
    yield* connection.lock.hold();
    return inLifecycleTransaction(connection, path, () => {
      sameHold(authorize, hold);
      // The execution this acquisition began, and no other: a completion naming
      // somebody else's execution is not this owner's to settle.
      if (completion.executionId !== hold.execution) {
        throw new WorkflowDocumentExecutionError(completion.executionId);
      }
      const { database } = connection;
      finish(database, path, completion);
      publish(database, path, completion.status, completion.reason);
      const record = readRunRow(database, path);
      if (record.runId !== hold.runId) {
        throw new WorkflowRunIdMismatchError(hold.runId, path);
      }
      return record;
    });
  });
}

interface BegunRows {
  readonly record: WorkflowRunRecord;
  readonly execution: DocumentExecutionRecord;
  readonly replay: boolean;
}

/**
 * The hold this lease still stands for, and the one it stood for before.
 *
 * Authority is spent, not held: a lease validated when the caller asked can
 * have been released before the transaction opened, and a different hold means
 * a different acquisition entirely.
 */
function sameHold(authorize: () => ExecutorHold, expected: ExecutorHold): ExecutorHold {
  const hold = authorize();
  if (hold !== expected) {
    throw new WorkflowRequestError(
      "the executor lease changed between authorization and this transaction, so the run may " +
        "already have another owner.",
    );
  }
  return hold;
}

function begin(
  connection: RunConnection,
  path: string,
  hold: ExecutorHold,
  request: WorkflowBeginRequest,
  recovered: Recovery,
): BegunRows {
  const { database } = connection;

  if (recovered.status === undefined) {
    // Nothing was there when recovery looked, and this caller still holds the
    // lock, so nothing has appeared since.
    return {
      kind: "begun",
      record: create(connection, path, hold, request),
      ...firstExecution(database, path),
    };
  }

  const started = insertExecution(database, path);
  if (terminal(recovered.status)) {
    // A replay observes an outcome that already won. Publishing `running` would
    // make a settled run mutable again.
    return { kind: "begun", record: readRunRow(database, path), execution: started, replay: true };
  }
  publish(database, path, "running", undefined);
  return { kind: "begun", record: readRunRow(database, path), execution: started, replay: false };
}

function create(
  connection: RunConnection,
  path: string,
  hold: ExecutorHold,
  request: WorkflowBeginRequest,
): WorkflowRunRecord {
  const { creation } = request;
  if (creation === undefined) {
    throw new WorkflowRunNotFoundError(hold.runId);
  }
  const { database } = connection;
  const stamp = new Date().toISOString();
  initializeSchema(database, connection.dofs, () => {
    database
      .prepare(INSERT_RUN)
      .run(
        hold.runId,
        canonicalJson(definitionToJson(creation.definition)),
        creation.base,
        canonicalJson(creation.props),
        stamp,
        stamp,
      );
  });
  if (creation.retrieval !== undefined) {
    database.prepare(UPSERT_RETRIEVAL).run(canonicalJson(creation.retrieval), 1, stamp);
  }
  return readRunRow(database, path);
}

function firstExecution(
  database: DatabaseSync,
  path: string,
): { execution: DocumentExecutionRecord; replay: boolean } {
  return { execution: insertExecution(database, path), replay: false };
}

/**
 * Why this action may not continue from this status, or nothing when it may.
 *
 * Answered rather than raised, and asked outside the transaction that recovered
 * the run: refusing is this caller's outcome, not a reason to undo what the
 * previous owner's execution was found to have become.
 */
function admissionRefusal(
  action: "start" | "resume",
  status: WorkflowRunStatus | undefined,
): Error | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (action === "resume" && (status === "failed" || status === "cancelled")) {
    return new WorkflowRequestError(
      `workflow run ${status}: a run that ${
        status === "failed" ? "failed" : "was cancelled"
      } is not resumed. The run is left exactly as it is.`,
    );
  }
  if (status === "cancelled") {
    return new WorkflowRequestError(
      "workflow run cancelled: a cancelled run reports its retained state and is not advanced.",
    );
  }
  return undefined;
}

function terminal(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed";
}

interface Reconciled {
  readonly status: WorkflowRunStatus;
  readonly of: { recovered?: DocumentExecutionRecord };
}

/**
 * Close what the previous owner left, on the evidence the run itself holds.
 *
 * Precedence is the architecture's. A retained root Close proves the canonical
 * outcome won before anything else could; failing that, a cancellation
 * addressed to the exact generation that died settles the execution it was
 * addressed to; failing both, the execution was interrupted.
 */
function reconcile(
  database: DatabaseSync,
  path: string,
  stored: WorkflowRunRecord,
  pending: PendingCancellation | undefined,
): Recovery {
  const unfinished = reading(database, SELECT_UNFINISHED).all().map(readDocumentExecution);
  if (unfinished.length === 0) {
    return { status: stored.status };
  }

  const closing = closingOutcome(database, stored, pending);

  let last: DocumentExecutionRecord | undefined;
  for (const execution of unfinished) {
    finish(database, path, {
      executionId: execution.executionId,
      status: closing.status,
      reason: closing.reason,
    });
    last = readExecution(database, execution.executionId);
  }
  const closed = last === undefined ? {} : { closed: last };
  if (!closing.publishes) {
    return { status: stored.status, ...closed };
  }
  publish(database, path, closing.status, closing.reason);
  return { status: closing.status, ...closed };
}

interface Closing {
  readonly status: WorkflowRunStatus;
  readonly reason: DocumentExecutionCompletion["reason"];
  readonly publishes: boolean;
}

/**
 * What the previous owner's execution became, on the evidence the run holds.
 *
 * The order is the architecture's, and each step rules out the next. A retained
 * root Close proves the canonical outcome won before anything could interrupt
 * or cancel it, so it is restored and any request left behind is stale. Failing
 * that, a cancellation addressed to the exact generation that died settles the
 * execution it was addressed to — a request for any other generation belongs to
 * an executor this one is not. Failing both, the execution was interrupted.
 */
function closingOutcome(
  database: DatabaseSync,
  stored: WorkflowRunRecord,
  pending: PendingCancellation | undefined,
): Closing {
  // A replay whose terminal state was preserved closes only its own execution,
  // and the authoritative outcome stays exactly as it was.
  if (terminal(stored.status)) {
    return { status: "interrupted", reason: interrupted, publishes: false };
  }

  const canonical = rootOutcome(database);
  if (canonical !== undefined) {
    return { status: canonical.status, reason: canonical.reason, publishes: true };
  }

  if (pending !== undefined) {
    return {
      status: "cancelled",
      reason: { kind: "host", code: "executor-cancelled" },
      publishes: true,
    };
  }

  return { status: "interrupted", reason: interrupted, publishes: true };
}

const interrupted = { kind: "host", code: "executor-interrupted" } as const;

/**
 * The canonical outcome the root recorded, when it recorded one.
 *
 * A root Close is what proves the document itself finished. Its result decides
 * the run's terminal status, and its own event identity is the reason — the
 * journal already filtered it, so nothing new is retained to say why.
 */
function rootOutcome(
  database: DatabaseSync,
): { status: WorkflowRunStatus; reason: DocumentExecutionCompletion["reason"] } | undefined {
  for (const entry of readJournalEntries(database)) {
    const { event } = entry;
    if (event.type !== "close" || event.coroutineId !== "root") {
      continue;
    }
    if (event.result.status === "ok") {
      return { status: "completed", reason: undefined };
    }
    return {
      status: event.result.status === "cancelled" ? "cancelled" : "failed",
      reason: { kind: "journal", eventId: entry.eventId },
    };
  }
  return undefined;
}

function insertExecution(database: DatabaseSync, path: string): DocumentExecutionRecord {
  const executionId = randomUUID();
  database.prepare(INSERT_EXECUTION).run(executionId, new Date().toISOString());
  return readExecution(database, executionId);
}

function finish(
  database: DatabaseSync,
  path: string,
  completion: DocumentExecutionCompletion,
): void {
  const columns = stopReasonColumns(completion.reason);
  const changed = withStopReason(path, () =>
    database
      .prepare(FINISH_EXECUTION)
      .run(
        new Date().toISOString(),
        completion.status,
        columns.kind,
        columns.code,
        columns.eventId,
        completion.executionId,
      ),
  );
  if (changed.changes === 0) {
    throw new WorkflowDocumentExecutionError(completion.executionId);
  }
}

function publish(
  database: DatabaseSync,
  path: string,
  status: WorkflowRunStatus,
  reason: DocumentExecutionCompletion["reason"],
): void {
  const columns = stopReasonColumns(reason);
  withStopReason(path, () =>
    database
      .prepare(UPDATE_RUN_STATE)
      .run(status, columns.kind, columns.code, columns.eventId, new Date().toISOString()),
  );
}

/**
 * A stop reason that names an event the run does not hold, as a refusal.
 *
 * The reference is a foreign key, so SQLite is what catches it. Left as a raw
 * constraint failure it would reach a caller as damage rather than as the
 * request error it is: a journal reason points at an event that has already
 * been appended and filtered.
 */
function withStopReason<T>(path: string, body: () => T): T {
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

function readExecution(database: DatabaseSync, executionId: string): DocumentExecutionRecord {
  const row = reading(database, SELECT_EXECUTION).get(executionId);
  if (row === undefined) {
    throw new WorkflowDocumentExecutionError(executionId);
  }
  return readDocumentExecution(row);
}

/** The retrieval metadata a run holds, for a caller that already opened it. */
export function readRetrievalRow(database: DatabaseSync) {
  const row = reading(database, SELECT_RETRIEVAL).get();
  return row === undefined ? undefined : readRetrieval(row);
}

/**
 * One lifecycle transaction, from `BEGIN IMMEDIATE` to `COMMIT`.
 *
 * The body is synchronous on purpose: it validates the lease and writes without
 * ever suspending, so no scope can end between the check and the commit.
 */
function inLifecycleTransaction<T>(
  connection: RunConnection,
  path: string,
  body: () => T,
): Result<T> {
  const { database } = connection;
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    return refusal(error, path);
  }

  // The connection's own transaction identity, not just SQLite's: the DOFS
  // layer allocates its savepoints against it, so initializing a Workspace
  // inside a bare `BEGIN IMMEDIATE` finds no transaction to attach to.
  let transaction: RunTransaction;
  try {
    transaction = connection.beginTransaction();
  } catch (error) {
    rollback(database);
    return refusal(error, path);
  }

  try {
    const value = body();
    connection.validateTransaction(transaction);
    connection.finishTransaction(transaction);
    database.exec("COMMIT");
    return Ok(value);
  } catch (error) {
    if (transaction.open) {
      connection.finishTransaction(transaction);
    }
    rollback(database);
    connection.invalidateDofsCaches();
    return refusal(error, path);
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    return;
  }
}

function refusal<T>(error: unknown, path: string): Result<T> {
  const translated = translateSqliteError(error, path);
  if (translated instanceof WorkflowStorageError) {
    return Err(translated);
  }
  throw translated;
}
