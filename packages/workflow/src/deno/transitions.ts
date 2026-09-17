/**
 * Every write that moves a run's lifecycle, and the executor lock each one checks.
 *
 * One module holds the lifecycle SQL — creating the run, beginning a document
 * execution, finishing one, publishing a status — because these rows describe
 * one another. A begin that inserted an execution without publishing `running`,
 * or a settlement that finished the record without publishing the outcome, would
 * leave a run whose two halves disagree, and inspection would report whichever
 * half it happened to read.
 *
 * ## The executor lock is checked where it is used
 *
 * Each transition validates the exact live executor lock inside its own
 * transaction, not before opening it. A lock checked in a caller and passed
 * along could have been released by the time the write lands.
 *
 * ## The bodies do not yield
 *
 * From the validation to the commit, a transition body is ordinary synchronous
 * code. Suspending in the middle would let the scope that owns the executor
 * lock tear down between "this caller may write" and the write — the transaction
 * would commit under a lock that is no longer held. What has to happen before
 * the transaction happens before it.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure, Err, Ok, type Operation, resource, type Result, scoped } from "effection";
import { exists, rm } from "@effectionx/fs";
import type { Json } from "@executablemd/durable-streams";
import {
  isGitWorkflowRunCreation,
  type WorkflowBeginRequest,
  type WorkflowExecutionBegun,
  type WorkflowForkRequest,
  type WorkflowRunCreation,
} from "../lifecycle/execution.ts";
import type { LegacyWorkflowSourceReader, RetainedDefinitionSources } from "../lifecycle/source.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { conflictingFields, type WorkflowRunComparison } from "../storage/compatibility.ts";
import { definitionToJson, type GitWorkflowDefinitionV1 } from "../storage/definition.ts";
import {
  LegacyWorkflowSourceReaderUnavailableError,
  WorkflowDefinitionSourceMissingError,
  WorkflowDocumentExecutionError,
  WorkflowRequestError,
  WorkflowRunConflictError,
  WorkflowRunIdMismatchError,
  WorkflowRunNotFoundError,
  WorkflowStorageError,
} from "../storage/errors.ts";
import {
  type SourceBundleSnapshotEntryV2,
  verifySourceBundleSnapshot,
} from "../storage/source-bundle.ts";
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
import type { ExecutorLockHold } from "./executor.ts";
import { reading, readTransaction } from "./reading.ts";
import { readJournalEntries } from "./journal.ts";
import { readRetrievalMetadata } from "./artifact-frontier.ts";
import {
  readDefinitionSourceRows,
  type RetainedSourceRows,
  validateLegacySources,
  verifyRetainedSources,
  writeDefinitionSources,
} from "./definition-source.ts";
import type { ForkSourceSnapshot } from "./fork-source.ts";
import { readForkLineage, writeForkInheritance, type ForkHeadEvents } from "./fork-write.ts";
import { readDocumentExecution, readRetrieval, stopReasonColumns } from "./rows.ts";
import {
  initializeSchema,
  isSqliteForeignKeyConstraint,
  isUninitialized,
  SOURCE_BUNDLE_SCHEMA_VERSION,
  translateSqliteError,
  verifyRecognizedSchema,
  verifySchema,
} from "./schema.ts";

/** Shared with `create()`, so one statement writes an immutable run. */
export const INSERT_RUN = `INSERT INTO workflow_run
  (id, run_id, definition, base, props, status, created_at, updated_at)
  VALUES (1, ?, ?, ?, ?, 'running', ?, ?)`;
/** The same row in a version-2 database, which has no base column at all. */
const INSERT_SOURCE_BUNDLE_RUN = `INSERT INTO workflow_run
  (id, run_id, definition, props, status, created_at, updated_at)
  VALUES (1, ?, ?, ?, 'running', ?, ?)`;
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
 * Begin one document execution under this exact executor lock.
 *
 * For a run that does not exist yet, the schema, the immutable run, its
 * retrieval metadata, an empty Workspace, the first execution record and
 * `running` are one transaction: a reader either finds a whole run or no run,
 * never a half-initialized one.
 */
export function* beginExecution(
  connections: WorkflowRunConnections,
  path: string,
  hold: ExecutorLockHold,
  authorize: () => ExecutorLockHold,
  request: WorkflowBeginRequest,
  readLegacySource?: LegacyWorkflowSourceReader,
): Operation<Result<BeginOutcome>> {
  // Asked before a connection exists, because opening one creates the file.
  // A resume that found nothing would otherwise leave an empty database behind
  // for `list` to refuse — inventing a candidate out of a failed lookup.
  if (request.action === "resume" && !(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(hold.runId));
  }

  // The caller pre-authorized to obtain this hold and the path it names, so a
  // fabricated lock is refused before a connection exists. The same lock is
  // checked again inside the transaction, because a scope can end
  // in between.
  const connection = yield* connections.at(path);

  // Everything the source has to prove, proved first. This caller holds the
  // executor lock, and nothing here writes — so a run whose retained bytes are
  // missing, damaged or unobtainable is refused with its lifecycle and its
  // journal exactly as they were, rather than after a recovery it then has to
  // leave behind.
  const authenticated = yield* authenticateBeforeBegin(connection, path, request, readLegacySource);
  if (!authenticated.ok) {
    return authenticated;
  }

  // One transaction. Recovery decides what the previous workflow executor's execution
  // became, admission decides whether this caller may continue, and an admitted
  // caller's execution is inserted — all or none. Splitting them would publish
  // a recovery that a refusal then had to leave behind, or leave a window where
  // this workflow executor's own execution looks like somebody else's leftovers.
  const outcome = yield* scoped(function* (): Operation<Result<BegunRows | Refused>> {
    yield* connection.lock.hold();
    return inLifecycleTransaction(connection, path, () =>
      beginOnce(connection, path, sameHold(authorize, hold), request, authenticated.value.owned),
    );
  });
  if (!outcome.ok) {
    // The transaction rolled back, so nothing was begun after all.
    hold.execution = undefined;
    hold.settleInterruption = undefined;
    return outcome;
  }
  if (outcome.value.kind === "refused") {
    return Ok(outcome.value);
  }

  const { record, execution, replay, closed } = outcome.value;
  // A run this call created has no proved source yet: what it will execute is
  // read back out of the transaction that committed it, so the closure a caller
  // imports is the store's own bytes rather than the buffers it handed in.
  const sources = yield* settleSources(
    connection,
    path,
    record,
    authenticated.value.proved,
    readLegacySource,
  );
  if (!sources.ok) {
    return sources;
  }

  const database = yield* openWorkflowRunDatabase({ connection, connections, record });
  return Ok({
    kind: "begun",
    database,
    record,
    execution,
    replay,
    sources: sources.value,
    ...(closed === undefined ? {} : { closed }),
  });
}

/** What a begin proved about the run's source before it wrote anything. */
interface AuthenticatedSource {
  /**
   * The source proved before anything moved, when it could be proved yet.
   *
   * Absent for exactly one case: a source-bundle run being created, whose
   * content does not exist in any store until this call commits it. Every other
   * path — an existing run of either version, and a Git run being created from
   * a descriptor the reader can already be asked about — proves it here.
   */
  readonly proved?: RetainedDefinitionSources;
  /** The creation's snapshot, copied and checked against its descriptor. */
  readonly owned?: readonly SourceBundleSnapshotEntryV2[];
}

/**
 * Prove the source before the lifecycle transaction opens.
 *
 * Two independent questions, both answered here so neither can be answered
 * after a write. A version-2 creation's snapshot is copied and held to its own
 * descriptor, so a caller that keeps mutating its arrays changes nothing and a
 * snapshot that does not describe the descriptor never reaches storage. An
 * existing run's retained source is re-derived from what it holds, or — for a
 * version-1 run — fetched through the host's legacy reader and validated
 * against the descriptor the run retains.
 */
function* authenticateBeforeBegin(
  connection: RunConnection,
  path: string,
  request: WorkflowBeginRequest,
  readLegacySource: LegacyWorkflowSourceReader | undefined,
): Operation<Result<AuthenticatedSource>> {
  const { creation } = request;
  let owned: readonly SourceBundleSnapshotEntryV2[] | undefined;
  if (creation !== undefined && !isGitWorkflowRunCreation(creation)) {
    const verified = yield* verifySourceBundleSnapshot(
      creation.definition,
      creation.sourceSnapshot,
    );
    if (!verified.ok) {
      return verified;
    }
    owned = verified.value;
  }

  const stored = yield* readStoredSource(connection, path);
  if (!stored.ok) {
    return stored;
  }

  // A run that is already there is held to what it retains. A Git run that is
  // being created is held to the descriptor it is about to retain: the reader
  // is asked now, with the creation's own descriptor and retrieval metadata, so
  // a host that cannot obtain the source never reaches the transaction that
  // would make the run exist.
  if (stored.value === undefined) {
    if (creation === undefined || !isGitWorkflowRunCreation(creation)) {
      return Ok(owned === undefined ? {} : { owned });
    }
    const proved = yield* readGitSource(creation.definition, creation.retrieval, readLegacySource);
    if (!proved.ok) {
      return proved;
    }
    return Ok({ proved: proved.value, ...(owned === undefined ? {} : { owned }) });
  }

  const proved = yield* authenticate(stored.value, readLegacySource);
  if (!proved.ok) {
    return proved;
  }
  return Ok({ proved: proved.value, ...(owned === undefined ? {} : { owned }) });
}

/** A run that is already there, and whatever its own store holds for it. */
interface StoredSource {
  readonly record: WorkflowRunRecord;
  readonly retrieval: Json | undefined;
  readonly rows?: RetainedSourceRows;
}

/**
 * Read what the store holds, deciding nothing about it.
 *
 * Read-only and inside its own transaction, because the questions that follow
 * are operations and a lifecycle transaction body may not suspend.
 */
function* readStoredSource(
  connection: RunConnection,
  path: string,
): Operation<Result<StoredSource | undefined>> {
  return yield* scoped(function* (): Operation<Result<StoredSource | undefined>> {
    yield* connection.lock.hold();
    try {
      return Ok(
        readTransaction(connection.database, () => {
          if (isUninitialized(connection.database, path)) {
            return undefined;
          }
          const version = verifyRecognizedSchema(connection.database, path, connection.dofs);
          const record = readRunRow(connection.database, path);
          const retrieval = readRetrievalMetadata(connection.database);
          if (version === 2) {
            return { record, retrieval, rows: readDefinitionSourceRows(connection.database) };
          }
          return { record, retrieval };
        }),
      );
    } catch (error) {
      return refusal(error, path);
    }
  });
}

/**
 * The source a stored run is a run of, re-derived or fetched and validated.
 *
 * A source bundle's content is in this database, so it is always re-derived and
 * a store that cannot produce it refuses here — before anything moves.
 *
 * A Git run's content is in a repository this package does not reach, so it is
 * fetched through the host's reader and held to the descriptor at the same
 * moment and for the same reason. A host that installed no reader cannot obtain
 * version-1 Markdown at all, and that is a refusal here rather than a run
 * admitted without knowing what it executes: every version-1 lifecycle
 * admission is gated before it writes.
 */
function* authenticate(
  stored: StoredSource,
  readLegacySource: LegacyWorkflowSourceReader | undefined,
): Operation<Result<RetainedDefinitionSources>> {
  const { definition } = stored.record;
  if (definition.kind === "source-bundle") {
    if (stored.rows === undefined) {
      return Err(new WorkflowDefinitionSourceMissingError());
    }
    return yield* verifyRetainedSources(definition, stored.rows);
  }
  return yield* readGitSource(definition, stored.retrieval, readLegacySource);
}

/**
 * A Git definition's Markdown, fetched through the host and held to it.
 *
 * The reader is a direct dependency the host captured, and a host that captured
 * none cannot obtain version-1 source at all — so that is a refusal here rather
 * than a run begun without knowing what it executes. Whatever comes back is
 * validated against this descriptor before it counts as this run's.
 */
function* readGitSource(
  definition: GitWorkflowDefinitionV1,
  retrieval: Json | undefined,
  readLegacySource: LegacyWorkflowSourceReader | undefined,
): Operation<Result<RetainedDefinitionSources>> {
  if (readLegacySource === undefined) {
    return Err(new LegacyWorkflowSourceReaderUnavailableError());
  }
  const answered = yield* readLegacySource(definition, retrieval);
  if (!answered.ok) {
    return answered;
  }
  return validateLegacySources(definition, answered.value);
}

/**
 * The source the begun execution runs, read back from what is now committed.
 *
 * An existing run already proved its own before anything moved, and that is the
 * value returned. A run this call created has one only now, so it is read out
 * of storage and verified again — which is what makes the closure a caller
 * imports the store's bytes rather than the buffers it supplied.
 */
function* settleSources(
  connection: RunConnection,
  path: string,
  record: WorkflowRunRecord,
  proved: RetainedDefinitionSources | undefined,
  readLegacySource: LegacyWorkflowSourceReader | undefined,
): Operation<Result<RetainedDefinitionSources>> {
  if (proved !== undefined) {
    return Ok(proved);
  }
  // The one case left: a source-bundle run this call created. Its content
  // existed nowhere until the transaction committed, so it is read back out of
  // the store and verified again — which is what makes the closure a caller
  // imports the retained bytes rather than the buffers it supplied.
  const stored = yield* readStoredSource(connection, path);
  if (!stored.ok) {
    return stored;
  }
  if (stored.value === undefined) {
    return Err(new WorkflowRunNotFoundError(record.runId));
  }
  return yield* authenticate(stored.value, readLegacySource);
}

/**
 * What finishes this execution if its host is torn down before it settles.
 *
 * Built inside the transaction that inserted the execution, so it closes over
 * the connection that is already open, the path, and the exact execution id —
 * and therefore asks nothing of the world at the moment it runs. The executor
 * hold calls it during teardown, before the advisory lock beneath is released,
 * which is what makes `interrupted` the status the next acquisition finds
 * rather than a stale `running`.
 *
 * Three things it deliberately does not do. It does not reread the run's
 * source: what a run executes was settled when it began. It does not look the
 * execution up first — one guarded `UPDATE` is the whole decision, and what it
 * changed is what says whether there was anything to finish. And it does not
 * throw: a teardown backstop that raised would replace the failure that caused
 * the teardown with its own.
 *
 * A transaction that rolled back leaves no row at all, and an execution that
 * settled on its own terms leaves one that no longer matches. Both change
 * nothing, so neither is relabelled and neither publishes a run status. A
 * cancellation before the creation committed therefore leaves nothing
 * recognized and nothing to reuse the run id around.
 */
function interruptionSettler(
  connection: RunConnection,
  path: string,
  executionId: string,
): () => void {
  let spent = false;
  return () => {
    if (spent) {
      return;
    }
    spent = true;
    const completion: DocumentExecutionCompletion = {
      executionId,
      status: "interrupted",
      reason: { kind: "host", code: "executor-interrupted" },
    };
    try {
      inLifecycleTransaction(connection, path, () => {
        // The update decides it, rather than a read this then acts on. Its own
        // `WHERE execution_id = ? AND stopped_at IS NULL` is the condition, so
        // a row that was never inserted and a row that already settled are the
        // same answer — nothing changed — and neither is asked about twice.
        const columns = stopReasonColumns(completion.reason);
        const changed = withStopReason(path, () =>
          connection.database
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
        // Published only for an execution this actually finished. A run whose
        // execution settled on its own terms keeps the status that settled it.
        if (changed.changes === 0) {
          return;
        }
        publish(connection.database, path, completion.status, completion.reason);
      });
    } catch {
      // Teardown owes the caller nothing it can act on here. The run keeps
      // whatever it last held, and the next acquisition reconciles it as the
      // unfinished execution of a workflow executor that went away.
      return;
    }
  };
}

/**
 * What one begin transaction committed.
 *
 * A refusal is an outcome, not an absence: the previous workflow executor's execution was
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

/** What the run was after the previous workflow executor's execution was accounted for. */
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
  hold: ExecutorLockHold,
  request: WorkflowBeginRequest,
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
    const differing = conflictingFields(stored, creationComparison(hold.runId, request.creation));
    if (differing.length > 0) {
      throw new WorkflowRunConflictError(hold.runId, differing);
    }
  }

  // Whatever the previous workflow executor left is proven stale: this caller holds the
  // lock, and this acquisition has begun nothing of its own.
  return reconcile(database, path, stored);
}

function beginOnce(
  connection: RunConnection,
  path: string,
  hold: ExecutorLockHold,
  request: WorkflowBeginRequest,
  owned: readonly SourceBundleSnapshotEntryV2[] | undefined,
): BegunRows | Refused {
  // An acquisition begins one execution. A second would find this workflow executor's own
  // live execution and, seeing it unfinished, reconcile it as a dead executor's
  // leftovers — then start another beside it under one executor lock.
  if (hold.execution !== undefined) {
    throw new WorkflowRequestError(
      "this executor lock has already begun a document execution. One acquisition begins one.",
    );
  }

  const recovery = recover(connection, path, hold, request);

  // A file can exist and hold nothing — created by an interrupted attempt, or
  // left empty by something else. Existence is not a run, so a resume that
  // reaches one refuses here rather than letting the creation it happens to
  // carry initialize the run it failed to find.
  if (request.action === "resume" && recovery.status === undefined) {
    return { kind: "refused", reason: new WorkflowRunNotFoundError(hold.runId) };
  }

  const refusal = admissionRefusal(request.action, recovery.status);
  if (refusal !== undefined) {
    // Committed all the same: what the previous workflow executor's execution became is not
    // undone by this caller being told it may not continue.
    return {
      kind: "refused",
      reason: refusal,
      ...(recovery.closed === undefined ? {} : { closed: recovery.closed }),
    };
  }

  const { database } = connection;
  const begun = begin(connection, path, hold, request, recovery, owned);
  hold.execution = begun.execution.executionId;
  // Inside the transaction that records the execution, so the run is never
  // durable without a way to finish it. Everything the settlement needs is
  // captured here; nothing is looked up after cancellation has begun.
  hold.settleInterruption = interruptionSettler(connection, path, begun.execution.executionId);
  return {
    ...begun,
    ...(recovery.closed === undefined ? {} : { closed: recovery.closed }),
    record: readRunRow(database, path),
  };
}

/**
 * Admit one fork and begin its first execution, in one transaction.
 *
 * The source was read before this opened, into an immutable snapshot: the
 * source's executor lock is never taken and no statement here touches it. What
 * commits is the fork's schema, its immutable run, the copied Workspace content
 * and roots, the restored checkpoint Workspace, the inherited journal prefix
 * with its provenance, the lineage and the first execution — all of it, or a
 * destination that holds nothing.
 *
 * A fork id already in use is compatible only when every term of the fork's
 * identity agrees: the source run, the checkpoint, the definition including its
 * component bundle and pinned commit, the base and the normalized props. When
 * they do, this is the same fork again and it continues like any other run.
 */
export function* forkExecution(
  connections: WorkflowRunConnections,
  path: string,
  hold: ExecutorLockHold,
  authorize: () => ExecutorLockHold,
  request: WorkflowForkRequest,
  snapshot: ForkSourceSnapshot,
  head: ForkHeadEvents,
  readLegacySource?: LegacyWorkflowSourceReader,
): Operation<Result<BeginOutcome>> {
  const connection = yield* connections.at(path);

  // The fork's own candidate, proved before its destination exists. A snapshot
  // that does not describe its descriptor leaves nothing behind at all.
  const authenticated = yield* authenticateBeforeBegin(
    connection,
    path,
    { runId: request.runId, action: "start", creation: request.creation },
    readLegacySource,
  );
  if (!authenticated.ok) {
    return authenticated;
  }

  const outcome = yield* scoped(function* (): Operation<Result<BegunRows | Refused>> {
    yield* connection.lock.hold();
    return inLifecycleTransaction(connection, path, (transaction) =>
      forkOnce(
        connection,
        path,
        sameHold(authorize, hold),
        request,
        snapshot,
        head,
        transaction,
        authenticated.value.owned,
      ),
    );
  });
  if (!outcome.ok) {
    // The transaction rolled back, so nothing was forked after all.
    hold.execution = undefined;
    hold.settleInterruption = undefined;
    return outcome;
  }
  if (outcome.value.kind === "refused") {
    return Ok(outcome.value);
  }

  const { record, execution, replay, closed } = outcome.value;
  const sources = yield* settleSources(
    connection,
    path,
    record,
    authenticated.value.proved,
    readLegacySource,
  );
  if (!sources.ok) {
    return sources;
  }
  const database = yield* openWorkflowRunDatabase({ connection, connections, record });
  return Ok({
    kind: "begun",
    database,
    record,
    execution,
    replay,
    sources: sources.value,
    ...(closed === undefined ? {} : { closed }),
  });
}

/**
 * Build the whole fork somewhere nothing recognizes it as a run, and hand back
 * its open database.
 *
 * A compatibility replay needs the fork's own Workspace: a `<File>` resolves
 * through the run's filesystem, and a replay run without one produces effects
 * of a different kind entirely and diverges for a reason that has nothing to do
 * with the candidate. So the fork is assembled in full at a staging path first,
 * replayed there, and thrown away — and only then, if it proved compatible, is
 * the same assembly committed at the run's own path.
 *
 * The staging file belongs to this operation's scope. Whatever happens, it goes
 * when that scope ends, and one left by an interrupted attempt is replaced
 * rather than continued.
 */
export function stageFork(
  connections: WorkflowRunConnections,
  path: string,
  request: WorkflowForkRequest,
  snapshot: ForkSourceSnapshot,
  head: ForkHeadEvents,
  readLegacySource?: LegacyWorkflowSourceReader,
): Operation<Result<WorkflowRunDatabase>> {
  return resource(function* (provide) {
    yield* ensure(function* () {
      connections.close(path);
      yield* rm(path, { force: true });
    });
    // Scratch, so a leftover is replaced rather than opened: what is there was
    // left by an attempt that did not finish, and it describes nothing.
    yield* rm(path, { force: true });

    // The staged fork retains the same source its admitted twin will, so the
    // same snapshot is copied and checked here. A replay against buffers a
    // caller still holds would prove compatibility of something else.
    let owned: readonly SourceBundleSnapshotEntryV2[] | undefined;
    if (isGitWorkflowRunCreation(request.creation)) {
      // A staged fork executes the same candidate its admitted twin will, so
      // the same reader gate applies before anything is assembled: a host that
      // cannot obtain this definition's Markdown cannot replay it either.
      const proved = yield* readGitSource(
        request.creation.definition,
        request.creation.retrieval,
        readLegacySource,
      );
      if (!proved.ok) {
        yield* provide(proved);
        return;
      }
    } else {
      const verified = yield* verifySourceBundleSnapshot(
        request.creation.definition,
        request.creation.sourceSnapshot,
      );
      if (!verified.ok) {
        yield* provide(verified);
        return;
      }
      owned = verified.value;
    }

    const connection = yield* connections.at(path);
    const built = yield* scoped(function* (): Operation<Result<WorkflowRunRecord>> {
      yield* connection.lock.hold();
      return inLifecycleTransaction(connection, path, (transaction) => {
        const record = createRun(connection, path, request.runId, request.creation, owned);
        writeForkInheritance(connection, transaction, snapshot, head);
        void record;
        return readRunRow(connection.database, path);
      });
    });
    if (!built.ok) {
      yield* provide(built);
      return;
    }
    const database = yield* openWorkflowRunDatabase({
      connection,
      connections,
      record: built.value,
    });
    yield* provide(Ok(database));
  });
}

function forkOnce(
  connection: RunConnection,
  path: string,
  hold: ExecutorLockHold,
  request: WorkflowForkRequest,
  snapshot: ForkSourceSnapshot,
  head: ForkHeadEvents,
  transaction: RunTransaction,
  owned: readonly SourceBundleSnapshotEntryV2[] | undefined,
): BegunRows | Refused {
  if (hold.execution !== undefined) {
    throw new WorkflowRequestError(
      "this executor lock has already begun a document execution. One acquisition begins one.",
    );
  }

  const { database } = connection;
  const resumed: WorkflowBeginRequest = {
    runId: hold.runId,
    action: "resume",
    creation: request.creation,
  };

  if (!isUninitialized(database, path)) {
    // The id is taken. Whether it is taken by *this* fork is the only question,
    // and every term of the answer is named separately: a caller who changed
    // the checkpoint learns that, not that "the run differs".
    verifySchema(database, path, connection.dofs);
    const stored = readRunRow(database, path);
    if (stored.runId !== hold.runId) {
      throw new WorkflowRunIdMismatchError(hold.runId, path);
    }
    const differing = forkConflicts(database, stored, hold.runId, request);
    if (differing.length > 0) {
      throw new WorkflowRunConflictError(hold.runId, differing);
    }
    return beginOnce(connection, path, hold, resumed, owned);
  }

  const record = create(
    connection,
    path,
    hold,
    { runId: hold.runId, action: "start", creation: request.creation },
    owned,
  );
  void record;
  writeForkInheritance(connection, transaction, snapshot, head);
  const execution = insertExecution(database);
  hold.execution = execution.executionId;
  hold.settleInterruption = interruptionSettler(connection, path, execution.executionId);
  return { kind: "begun", record: readRunRow(database, path), execution, replay: false };
}

/**
 * Which terms of a stored fork's identity this request disagrees with.
 *
 * The lineage terms come first because they are the ones a fork adds: a run
 * stored under this id that is not a fork at all disagrees about its source,
 * and saying so is more use than reporting the definition it also happens to
 * differ in.
 */
function forkConflicts(
  database: DatabaseSync,
  stored: WorkflowRunRecord,
  runId: string,
  request: WorkflowForkRequest,
): string[] {
  const fields: string[] = [];
  const lineage = readForkLineage(database);
  if (lineage === undefined) {
    fields.push("source run");
  } else {
    if (lineage.sourceRunId !== request.selection.sourceRunId) {
      fields.push("source run");
    }
    if (lineage.checkpointEventId !== request.selection.checkpointEventId) {
      fields.push("checkpoint");
    }
  }
  fields.push(...conflictingFields(stored, creationComparison(runId, request.creation)));
  return fields;
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
  hold: ExecutorLockHold,
  authorize: () => ExecutorLockHold,
  offered: DocumentExecutionCompletion,
): Operation<Result<WorkflowRunRecord>> {
  const checked = parseDocumentExecutionCompletion(offered);
  if (!checked.ok) {
    return checked;
  }
  const completion = checked.value;
  const connection = yield* connections.at(path);

  return yield* scoped(function* (): Operation<Result<WorkflowRunRecord>> {
    yield* connection.lock.hold();
    return inLifecycleTransaction(connection, path, () => {
      sameHold(authorize, hold);
      // The execution this acquisition began, and no other: a completion naming
      // somebody else's execution is not this workflow executor's to settle.
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
 * The hold this executor lock still stands for, and the one it stood for before.
 *
 * A lock checked when the caller asked can have been released before the
 * transaction opened, and a different hold means a different acquisition
 * entirely.
 */
function sameHold(authorize: () => ExecutorLockHold, expected: ExecutorLockHold): ExecutorLockHold {
  const hold = authorize();
  if (hold !== expected) {
    throw new WorkflowRequestError(
      "the executor lock changed between authorization and this transaction, so another " +
        "workflow executor may already hold the run's lock.",
    );
  }
  return hold;
}

function begin(
  connection: RunConnection,
  path: string,
  hold: ExecutorLockHold,
  request: WorkflowBeginRequest,
  recovered: Recovery,
  owned: readonly SourceBundleSnapshotEntryV2[] | undefined,
): BegunRows {
  const { database } = connection;

  if (recovered.status === undefined) {
    // Nothing was there when recovery looked, and this caller still holds the
    // lock, so nothing has appeared since.
    return {
      kind: "begun",
      record: create(connection, path, hold, request, owned),
      ...firstExecution(database),
    };
  }

  const started = insertExecution(database);
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
  hold: ExecutorLockHold,
  request: WorkflowBeginRequest,
  owned: readonly SourceBundleSnapshotEntryV2[] | undefined,
): WorkflowRunRecord {
  const { creation } = request;
  if (creation === undefined) {
    throw new WorkflowRunNotFoundError(hold.runId);
  }
  return createRun(connection, path, hold.runId, creation, owned);
}

/**
 * The schema, the immutable run, its source and its retrieval metadata, in one
 * write.
 *
 * The schema version comes from the creation variant, so a Git run initializes
 * version 1 and a source-bundle run version 2. A version-2 creation writes its
 * complete manifest and de-duplicated content inside the same initialization
 * callback as the run row: descriptor and content are one fact, and a database
 * holding one without the other is a run whose authoritative source nobody
 * supplied.
 *
 * `owned` is the snapshot after it was copied and checked against the
 * descriptor, never the caller's own arrays.
 */
function createRun(
  connection: RunConnection,
  path: string,
  runId: string,
  creation: WorkflowRunCreation,
  owned: readonly SourceBundleSnapshotEntryV2[] | undefined,
): WorkflowRunRecord {
  const { database } = connection;
  const stamp = new Date().toISOString();

  if (isGitWorkflowRunCreation(creation)) {
    initializeSchema(database, connection.dofs, () => {
      database
        .prepare(INSERT_RUN)
        .run(
          runId,
          canonicalJson(definitionToJson(creation.definition)),
          creation.base,
          canonicalJson(creation.props),
          stamp,
          stamp,
        );
    });
  } else {
    if (owned === undefined) {
      throw new WorkflowRequestError(
        "a source-bundle run is created from its exact bytes, and none were verified for it.",
      );
    }
    initializeSchema(
      database,
      connection.dofs,
      () => {
        database
          .prepare(INSERT_SOURCE_BUNDLE_RUN)
          .run(
            runId,
            canonicalJson(definitionToJson(creation.definition)),
            canonicalJson(creation.props),
            stamp,
            stamp,
          );
        writeDefinitionSources(database, creation.definition, owned);
      },
      SOURCE_BUNDLE_SCHEMA_VERSION,
    );
  }

  if (creation.retrieval !== undefined) {
    database.prepare(UPSERT_RETRIEVAL).run(canonicalJson(creation.retrieval), 1, stamp);
  }
  return readRunRow(database, path);
}

/** The immutable terms a creation offers for the run id it names. */
export function creationComparison(
  runId: string,
  creation: WorkflowRunCreation,
): WorkflowRunComparison {
  if (isGitWorkflowRunCreation(creation)) {
    return {
      runId,
      definition: creation.definition,
      base: creation.base,
      props: creation.props,
    };
  }
  return { runId, definition: creation.definition, props: creation.props };
}

function firstExecution(database: DatabaseSync): {
  execution: DocumentExecutionRecord;
  replay: boolean;
} {
  return { execution: insertExecution(database), replay: false };
}

/**
 * Why this action may not continue from this status, or nothing when it may.
 *
 * Answered rather than raised, and asked outside the transaction that recovered
 * the run: refusing is this caller's outcome, not a reason to undo what the
 * previous workflow executor's execution was found to have become.
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

/**
 * Close what the previous workflow executor left, on the evidence the run itself holds.
 *
 * Precedence is the architecture's. A retained root Close proves the canonical
 * outcome won before anything else could; failing that, a cancellation
 * addressed to the exact generation that died settles the execution it was
 * addressed to; failing both, the execution was interrupted.
 */
function reconcile(database: DatabaseSync, path: string, stored: WorkflowRunRecord): Recovery {
  const unfinished = reading(database, SELECT_UNFINISHED).all().map(readDocumentExecution);
  if (unfinished.length === 0) {
    return { status: stored.status };
  }

  const closing = closingOutcome(database, stored);

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
 * What the previous workflow executor's execution became, on the evidence the run holds.
 *
 * A retained root Close proves the canonical outcome won before anything could
 * interrupt it, so it is restored. Failing that, the execution was interrupted:
 * the workflow executor went away without recording an outcome, and that is what happened.
 */
function closingOutcome(database: DatabaseSync, stored: WorkflowRunRecord): Closing {
  // A replay whose terminal state was preserved closes only its own execution,
  // and the authoritative outcome stays exactly as it was.
  if (terminal(stored.status)) {
    return { status: "interrupted", reason: interrupted, publishes: false };
  }

  const canonical = rootOutcome(database);
  if (canonical !== undefined) {
    return { status: canonical.status, reason: canonical.reason, publishes: true };
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

function insertExecution(database: DatabaseSync): DocumentExecutionRecord {
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
 * The body is synchronous on purpose: it validates the executor lock and
 * writes without ever suspending, so no scope can end between the check and the
 * commit.
 */
function inLifecycleTransaction<T>(
  connection: RunConnection,
  path: string,
  body: (transaction: RunTransaction) => T,
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
    const value = body(transaction);
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

/**
 * Make one run terminal under the executor lock without starting anything.
 *
 * There is no live execution to halt here: acquiring the lock is what proved
 * that. What is left is retained state, and the rules are the architecture's —
 * a root Close means the canonical outcome already won and cancellation is
 * refused; an unfinished execution left by a workflow executor that went away is finished
 * as cancelled; a run with nothing running becomes cancelled directly; a run
 * already cancelled says so again; and a completed or failed run is not
 * something to cancel.
 */
export function* cancelRun(
  connections: WorkflowRunConnections,
  path: string,
  hold: ExecutorLockHold,
  authorize: () => ExecutorLockHold,
): Operation<Result<WorkflowRunRecord>> {
  if (!(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(hold.runId));
  }
  const connection = yield* connections.at(path);

  const outcome = yield* scoped(function* (): Operation<Result<WorkflowRunRecord | Refused>> {
    yield* connection.lock.hold();
    return inLifecycleTransaction(connection, path, () => {
      sameHold(authorize, hold);
      const { database } = connection;
      verifySchema(database, path, connection.dofs);
      const stored = readRunRow(database, path);
      if (stored.runId !== hold.runId) {
        throw new WorkflowRunIdMismatchError(hold.runId, path);
      }

      if (stored.status === "cancelled") {
        // Already what the caller asked for. Saying so twice is the same answer.
        return stored;
      }
      if (terminal(stored.status)) {
        throw new WorkflowRequestError(
          `workflow run ${stored.status}: a run whose outcome already won is not cancelled. ` +
            "The run is left exactly as it is.",
        );
      }

      const canonical = rootOutcome(database);
      if (canonical !== undefined) {
        // The document finished before its workflow executor disappeared. Restoring what it
        // recorded is not cancelling it.
        for (const execution of unfinishedExecutions(database)) {
          finish(database, path, {
            executionId: execution.executionId,
            status: canonical.status,
            reason: canonical.reason,
          });
        }
        publish(database, path, canonical.status, canonical.reason);
        // Committed, and refused: what the root recorded is now what the run
        // says, and telling the caller it was not cancelled must not undo that.
        return {
          kind: "refused" as const,
          reason: new WorkflowRequestError(
            `workflow run ${canonical.status}: its root recorded an outcome before the executor ` +
              "went away, and that outcome is what the run retains.",
          ),
        };
      }

      const reason = { kind: "host", code: "cancelled" } as const;
      for (const execution of unfinishedExecutions(database)) {
        finish(database, path, {
          executionId: execution.executionId,
          status: "cancelled",
          reason,
        });
      }
      publish(database, path, "cancelled", reason);
      return readRunRow(database, path);
    });
  });

  if (!outcome.ok) {
    return outcome;
  }
  return "kind" in outcome.value ? Err(outcome.value.reason) : Ok(outcome.value);
}

function unfinishedExecutions(database: DatabaseSync): DocumentExecutionRecord[] {
  return reading(database, SELECT_UNFINISHED).all().map(readDocumentExecution);
}
