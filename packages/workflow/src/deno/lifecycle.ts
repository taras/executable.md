/**
 * The Deno lifecycle provider's read-only half.
 *
 * Inspection is a separate physical path from execution, not a politer way of
 * using the same one. It opens each database read-only, on a connection of its
 * own, outside the execution pool: the pool's connections carry DOFS caches, an
 * active-transaction marker and a teardown that rolls back, and none of that
 * belongs to a command whose whole contract is that it changes nothing. SQLite
 * itself refuses a write on these handles, so "read-only" is enforced by the
 * database rather than promised by this module.
 *
 * ## Discovery is arithmetic
 *
 * A run's file is the SHA-256 of its id with a `.sqlite` suffix directly beneath
 * the authorized root, so `status` and `history` derive one path and `list`
 * enumerates exactly that namespace. Lifecycle sidecars occupy names this
 * pattern does not match and are never candidates. There is no registry, so
 * there is nothing that could disagree with the files.
 *
 * ## One bad candidate fails the list
 *
 * A foreign, incompatible, damaged or unparseable candidate is reported as
 * itself and ends the request. Returning the healthy rows would answer "these
 * are your runs" with a list that is missing one nobody was told about.
 *
 * ## One snapshot, one moment
 *
 * Every field of a snapshot is read inside one transaction, so the record, the
 * executions, the journal frontier and the current Workspace root cannot come
 * from different commits of the same run.
 */

import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { exists, readdir } from "@effectionx/fs";
import { Err, Ok, type Operation, type Result } from "effection";
import { Database as CloudflareDatabase } from "../../vendor/cloudflare-computer-dofs/generated/storage.js";
import type {
  DurableObjectStorageLike,
  SQLCursorLike,
  SQLStorageLike,
} from "../../vendor/cloudflare-computer-dofs/generated/types.d.ts";
import { WorkflowLifecycle, type WorkflowLifecycleSnapshot } from "../lifecycle/api.ts";
import { readEventSource, type WorkflowHistoryEntry } from "../lifecycle/history.ts";
import {
  WorkflowRequestError,
  WorkflowRunIdMismatchError,
  WorkflowRunLocationMismatchError,
  WorkflowRunNotFoundError,
  WorkflowStorageError,
} from "../storage/errors.ts";
import type { DocumentExecutionRecord, WorkflowRunRecord } from "../storage/record.ts";
import { readJournalEntries } from "./journal.ts";
import { workflowRunPath } from "./path.ts";
import { authorizedRoot, checkRunId } from "./provider.ts";
import { reading, readTransaction } from "./reading.ts";
import { readDocumentExecution, readRetrieval, readRunRecord } from "./rows.ts";
import { translateSqliteError, verifySchema } from "./schema.ts";

const SELECT_RUN = "SELECT * FROM workflow_run WHERE id = 1";
const SELECT_RETRIEVAL = "SELECT * FROM definition_retrieval WHERE id = 1";
const SELECT_EXECUTIONS = "SELECT * FROM document_executions ORDER BY sequence ASC";
const SELECT_FRONTIER =
  "SELECT event_id, workspace_root_id FROM journal_events ORDER BY sequence DESC LIMIT 1";
const SELECT_CURRENT_ROOT = "SELECT current_root_id FROM workspace_state WHERE singleton_id = 1";

/** A run's file: the hash of its id, and nothing else in this namespace. */
const CANDIDATE = /^[0-9a-f]{64}\.sqlite$/;

export interface WorkflowLifecycleOptions {
  /** The directory this host keeps runs in. Absolute, as storage requires. */
  readonly root: string;
}

/**
 * Install lifecycle for the current scope and its descendants.
 *
 * `{ at: "min" }` for the same reason storage uses it: middleware at the
 * default position runs outermost, so an outer scope's provider would answer
 * ahead of one installed nearer the work.
 *
 * This slice installs the read-only operations. Acquisition, cancellation and
 * deletion are not installed, so they answer with the Api's fail-closed default
 * rather than with a host that appears to hold authority it does not.
 */
export function* useWorkflowLifecycle(options: WorkflowLifecycleOptions): Operation<void> {
  const root = authorizedRoot(options.root);
  yield* WorkflowLifecycle.around(
    {
      *inspect([runId]) {
        return yield* inspectRun(root, runId);
      },
      *list() {
        return yield* listRuns(root);
      },
      *history([runId]) {
        return yield* runHistory(root, runId);
      },
    },
    { at: "min" },
  );
}

function* inspectRun(root: string, runId: string): Operation<Result<WorkflowLifecycleSnapshot>> {
  return yield* atRun(root, runId, snapshot);
}

function* runHistory(
  root: string,
  runId: string,
): Operation<Result<readonly WorkflowHistoryEntry[]>> {
  return yield* atRun(root, runId, (database) =>
    Object.freeze(
      readJournalEntries(database).map((entry) =>
        Object.freeze({
          eventId: entry.eventId,
          event: entry.event,
          workspaceRootId: entry.workspaceRootId,
          ...sourceOf(entry.event),
        }),
      ),
    ),
  );
}

function sourceOf(event: WorkflowHistoryEntry["event"]): Partial<WorkflowHistoryEntry> {
  const source = readEventSource(event);
  return source === undefined ? {} : { source };
}

/**
 * Read one run this caller named, refusing storage that holds a different one.
 *
 * Two questions, and the second is asked for every candidate rather than only
 * here: `withSnapshot` refuses a database whose retained id does not name its
 * file at all, so what is left to ask is whether the run it holds is the run
 * that was asked for.
 */
function* atRun<T>(
  root: string,
  runId: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord, path: string) => T,
): Operation<Result<T>> {
  const checked = checkRunId(runId);
  if (!checked.ok) {
    return checked;
  }
  const path = workflowRunPath(root, checked.value);
  // Asked before opening, because `node:sqlite` creates the file it is pointed
  // at. A read-only open of an absent run must report the absent run rather
  // than inventing an empty one.
  if (!(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(checked.value));
  }
  return withSnapshot(path, (database, record) => {
    if (record.runId !== checked.value) {
      throw new WorkflowRunIdMismatchError(checked.value, path);
    }
    return read(database, record, path);
  });
}

function* listRuns(root: string): Operation<Result<readonly WorkflowLifecycleSnapshot[]>> {
  const snapshots: WorkflowLifecycleSnapshot[] = [];
  for (const path of yield* candidatePaths(root)) {
    // One unreadable candidate ends the request. A list is a claim about every
    // run this root holds, and a shorter one silently answers a question the
    // caller did not ask. A candidate that is a perfectly good database of
    // *another* run is one of those: `withSnapshot` refuses it because its
    // retained id does not name the file it was found in.
    const read = withSnapshot(path, (database, record) => snapshot(database, record, path));
    if (!read.ok) {
      return read;
    }
    snapshots.push(read.value);
  }

  snapshots.sort(byNewestUpdate);
  return Ok(Object.freeze(snapshots));
}

/** Newest update first; the run id breaks a tie so the order is total. */
function byNewestUpdate(left: WorkflowLifecycleSnapshot, right: WorkflowLifecycleSnapshot): number {
  if (left.record.updatedAt === right.record.updatedAt) {
    return left.record.runId < right.record.runId ? -1 : 1;
  }
  return left.record.updatedAt < right.record.updatedAt ? 1 : -1;
}

function* candidatePaths(root: string): Operation<string[]> {
  if (!(yield* exists(root))) {
    // A host that has never started a run has no runs, which is a complete
    // answer rather than a missing store.
    return [];
  }
  const names = yield* readdir(root);
  return names
    .filter((name) => CANDIDATE.test(name))
    .sort()
    .map((name) => join(root, name));
}

/**
 * One consistent reading of a run, on a connection SQLite will not let anything
 * write through, closed before the answer is returned.
 *
 * Recognition is structure and then identity: a file that is shaped like a
 * version-1 workflow run still has to be the run its location names. Because a
 * run's file name is the hash of its id, a healthy database copied or renamed
 * to another candidate's name would otherwise be returned as a second, entirely
 * genuine-looking run — so the check belongs here, where every read passes,
 * rather than only where a caller supplied an id to compare against.
 */
function withSnapshot<T>(
  path: string,
  read: (database: DatabaseSync, record: WorkflowRunRecord) => T,
): Result<T> {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    return refusal(error, path);
  }
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    return Ok(
      readTransaction(database, () => {
        verifySchema(database, path, inertDofs(database));
        const record = readRunRow(database, path);
        if (basename(path) !== basename(workflowRunPath(dirname(path), record.runId))) {
          throw new WorkflowRunLocationMismatchError(record.runId, path);
        }
        return read(database, record);
      }),
    );
  } catch (error) {
    return refusal(error, path);
  } finally {
    database.close();
  }
}

/**
 * A DOFS handle for recognition, which never reaches it.
 *
 * Verification materializes no manifest, so the only DOFS call it could make is
 * one it is told not to make. Handing it a connection that refuses to write is
 * what proves that: a recognition path that started writing would fail here
 * rather than quietly repairing a database inspection promised to leave alone.
 */
function inertDofs(database: DatabaseSync): CloudflareDatabase {
  const sql: SQLStorageLike = {
    exec<Row extends object = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SQLCursorLike<Row> {
      const statement = database.prepare(query);
      const rows = Reflect.apply(statement.all, statement, bindings);
      return {
        toArray(): Row[] {
          return rows;
        },
      };
    },
  };
  const storage: DurableObjectStorageLike = {
    sql,
    transactionSync<T>(_closure: () => T): T {
      throw new WorkflowRequestError(
        "workflow inspection does not open a DOFS transaction: it reads a snapshot and " +
          "changes nothing.",
      );
    },
  };
  return new CloudflareDatabase(storage);
}

function snapshot(
  database: DatabaseSync,
  record: WorkflowRunRecord,
  path: string,
): WorkflowLifecycleSnapshot {
  const retrievalRow = reading(database, SELECT_RETRIEVAL).get();
  const executions: DocumentExecutionRecord[] = reading(database, SELECT_EXECUTIONS)
    .all()
    .map(readDocumentExecution);

  return Object.freeze({
    record,
    ...(retrievalRow === undefined ? {} : { retrieval: readRetrieval(retrievalRow) }),
    executions: Object.freeze(executions),
    ...frontier(database, path),
    currentWorkspaceRootId: currentRoot(database, path),
  });
}

function frontier(
  database: DatabaseSync,
  path: string,
): Pick<WorkflowLifecycleSnapshot, "journalFrontier"> {
  const row = reading(database, SELECT_FRONTIER).get();
  if (row === undefined) {
    return {};
  }
  const eventId = row["event_id"];
  const workspaceRootId = row["workspace_root_id"];
  if (typeof eventId !== "string" || typeof workspaceRootId !== "string") {
    throw new WorkflowRequestError(`The journal frontier at ${path} does not describe an event.`);
  }
  return { journalFrontier: Object.freeze({ eventId, workspaceRootId }) };
}

function currentRoot(database: DatabaseSync, path: string): string {
  const row = reading(database, SELECT_CURRENT_ROOT).get();
  const rootId = row?.["current_root_id"];
  if (typeof rootId !== "string") {
    throw new WorkflowRequestError(`The Workspace at ${path} has no current root.`);
  }
  return rootId;
}

function readRunRow(database: DatabaseSync, path: string): WorkflowRunRecord {
  const row = reading(database, SELECT_RUN).get();
  if (row === undefined) {
    throw new WorkflowRequestError(`The workflow-run database at ${path} holds no workflow run.`);
  }
  return readRunRecord(row);
}

function refusal<T>(error: unknown, path: string): Result<T> {
  const translated = translateSqliteError(error, path);
  if (translated instanceof WorkflowStorageError) {
    return Err(translated);
  }
  throw translated;
}
