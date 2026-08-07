/**
 * The Deno workflow-run storage provider.
 *
 * This module is where the host stops being provider-neutral: it hashes run
 * ids, resolves paths beneath the authorized root, opens SQLite, and decides
 * what each of SQLite's refusals means. Nothing above it names any of those.
 *
 * ## Finding a run
 *
 * A run's file is the SHA-256 of its public run id beneath the root, so
 * discovery is arithmetic and there is no index that could disagree with the
 * files. Because a path can be derived by anyone, the run id is also stored
 * inside the database and checked: a file at the right path holding a different
 * run is a collision or tampering, and is refused rather than adopted.
 *
 * ## Creating is reusing
 *
 * `create()` answers with the stored run when the request describes it, and
 * refuses when any immutable field differs. That is what makes a
 * caller-selected id usable twice — as a retry, or as a second process
 * addressing the same work — without a separate idempotency concept.
 *
 * Two callers creating at once converge through SQLite's own write lock: the
 * first initializes the file, the second finds it already initialized and
 * compares instead of writing.
 */

import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir, exists } from "@effectionx/fs";
import { ensure, Err, Ok, type Operation, type Result, scoped } from "effection";
import {
  type CreateWorkflowRunRequest,
  type WorkflowRunDatabase,
  WorkflowRunStorage,
} from "../storage/api.ts";
import { conflictingFields } from "../storage/compatibility.ts";
import {
  definitionToJson,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from "../storage/definition.ts";
import {
  WorkflowRequestError,
  WorkflowRunConflictError,
  WorkflowRunIdMismatchError,
  WorkflowRunNotFoundError,
  WorkflowStorageError,
} from "../storage/errors.ts";
import { type JsonObject, parseJsonObject } from "../storage/members.ts";
import { canonicalJson, type WorkflowRunRecord } from "../storage/record.ts";
import { openWorkflowRunDatabase, readRunRow } from "./database.ts";
import { type ConnectionLocks, createConnectionLocks } from "./lock.ts";
import { workflowRunPath } from "./path.ts";
import { initializeSchema, isUninitialized, translateSqliteError, verifySchema } from "./schema.ts";

/**
 * How long a connection waits for another host's write lock.
 *
 * SQLite is reached synchronously, so this is also how long the thread can
 * stop. Long enough for a transaction that is committing, short enough that a
 * host holding a lock it will never release is reported rather than waited on.
 */
const BUSY_TIMEOUT_MS = 5_000;

const INSERT_RUN = `INSERT INTO workflow_run
  (id, run_id, definition, base, props, status, created_at, updated_at)
  VALUES (1, ?, ?, ?, ?, 'running', ?, ?)`;

export interface WorkflowRunStorageOptions {
  /**
   * The directory this host is authorized to keep runs in.
   *
   * Absolute. A relative root names a different directory from a different
   * working directory, and where a run lives is host arrangement that must not
   * depend on where a process happened to start. `~` is not expanded: a path
   * only a shell understands is not a path.
   */
  readonly root: string;
}

/**
 * Install this host's run storage for the current scope and its descendants.
 *
 * `{ at: "min" }` is not decoration. Middleware installed at the default
 * position runs outermost, so an outer scope's provider would answer ahead of
 * one installed nearer the work — the opposite of what a provider is for.
 *
 * The turns taken at each database belong to this installation. They are
 * created here rather than at module scope, so coordination lasts exactly as
 * long as the scope that installed the provider and nothing accumulates
 * between runs.
 */
export function* useWorkflowRunStorage(options: WorkflowRunStorageOptions): Operation<void> {
  const root = authorizedRoot(options.root);
  const locks = createConnectionLocks();

  yield* WorkflowRunStorage.around(
    {
      *create([request]) {
        return yield* createWorkflowRun(root, locks, request);
      },
      *lookup([runId]) {
        return yield* lookupWorkflowRun(root, locks, runId);
      },
    },
    { at: "min" },
  );
}

function authorizedRoot(root: string): string {
  if (typeof root !== "string" || root === "") {
    throw new WorkflowRequestError("a storage root is required.");
  }
  if (root.startsWith("~")) {
    throw new WorkflowRequestError(
      "a storage root beginning with ~ is a shell convenience rather than a path. Resolve " +
        "it before installing the provider.",
    );
  }
  if (!isAbsolute(root)) {
    throw new WorkflowRequestError(
      "a storage root must be absolute, so that where a run lives does not depend on the " +
        "working directory a process happened to start in.",
    );
  }
  return root;
}

/** A request whose every member has been checked rather than believed. */
interface CheckedRequest {
  readonly runId: string;
  readonly definition: WorkflowDefinition;
  readonly base: string;
  readonly props: JsonObject;
}

function* createWorkflowRun(
  root: string,
  locks: ConnectionLocks,
  request: CreateWorkflowRunRequest,
): Operation<Result<WorkflowRunDatabase>> {
  const checked = checkRequest(request);
  if (!checked.ok) {
    return checked;
  }
  const wanted = checked.value;

  const path = workflowRunPath(root, wanted.runId);
  if (!(yield* exists(path))) {
    yield* ensureDir(dirname(path));
  }

  const lock = locks.at(path);

  return yield* withConnection(path, function* (database): Operation<Result<WorkflowRunDatabase>> {
    // Held across initialization, so a second caller creating the same run
    // waits here rather than inside a synchronous `BEGIN IMMEDIATE` that
    // would stop the host while the first one is still committing.
    const stored = yield* scoped(function* () {
      yield* lock.hold();
      return establish(database, path, wanted);
    });
    if (!stored.ok) {
      return stored;
    }

    const record = stored.value;
    if (record.runId !== wanted.runId) {
      return Err(new WorkflowRunIdMismatchError(wanted.runId, path));
    }

    const differing = conflictingFields(record, wanted);
    if (differing.length > 0) {
      return Err(new WorkflowRunConflictError(wanted.runId, differing));
    }

    return Ok(yield* openWorkflowRunDatabase({ database, path, record, lock }));
  });
}

function* lookupWorkflowRun(
  root: string,
  locks: ConnectionLocks,
  runId: string,
): Operation<Result<WorkflowRunDatabase>> {
  if (runId === "") {
    return Err(new WorkflowRequestError("a run id is required, and an empty one names nothing."));
  }

  const path = workflowRunPath(root, runId);
  // Asked before opening: `node:sqlite` creates the file it is pointed at, and
  // a lookup that leaves an empty database behind has invented the run it
  // failed to find.
  if (!(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(runId));
  }

  const lock = locks.at(path);

  return yield* withConnection(path, function* (database): Operation<Result<WorkflowRunDatabase>> {
    const record = yield* scoped(function* (): Operation<Result<WorkflowRunRecord>> {
      yield* lock.hold();
      try {
        verifySchema(database, path);
        return Ok(readRunRow(database, path));
      } catch (error) {
        return refusal(error, path);
      }
    });
    if (!record.ok) {
      return record;
    }

    if (record.value.runId !== runId) {
      return Err(new WorkflowRunIdMismatchError(runId, path));
    }

    return Ok(yield* openWorkflowRunDatabase({ database, path, record: record.value, lock }));
  });
}

/**
 * Open the file, and close it again unless a handle takes ownership.
 *
 * A refused database must not leave a connection open on a file the caller is
 * about to be told is unusable — that connection would hold a lock nothing was
 * going to release until the process ended. That includes a refusal raised on
 * the way to producing the handle: reading a row while the handle is being
 * built is as capable of finding an unreadable record as reading one later.
 *
 * Between opening the file and handing it to a handle there is checking to do,
 * and a caller may be cancelled during it. The connection is therefore given
 * up through ordinary teardown as well, so an interrupted open closes what it
 * opened rather than leaving the file locked by a connection nobody holds.
 */
function* withConnection(
  path: string,
  body: (database: DatabaseSync) => Operation<Result<WorkflowRunDatabase>>,
): Operation<Result<WorkflowRunDatabase>> {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
    // A connection setting, not a change to the file. Without it SQLite
    // refuses a contended write lock immediately, so a second host reaching
    // the same run would be told the database is busy rather than waiting the
    // moment it takes the first one to commit.
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Off by default in SQLite, and per connection rather than stored in the
    // file. Without it a stop reason could name a journal event that is not
    // there, which is a reason that refers to nothing.
    database.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    return refusal(error, path);
  }

  let adopted = false;
  let released = false;

  function release(): void {
    if (adopted || released) {
      return;
    }
    released = true;
    database.close();
  }

  // Registered before the checking begins, so cancellation part-way through it
  // still closes the connection. Once a handle owns the connection this is a
  // no-op, and the handle's own teardown closes it.
  yield* ensure(release);

  let result: Result<WorkflowRunDatabase>;
  try {
    result = yield* body(database);
  } catch (error) {
    release();
    return refusal(error, path);
  }

  if (result.ok) {
    adopted = true;
  } else {
    release();
  }
  return result;
}

/**
 * The stored run, initializing the database when it holds nothing yet.
 *
 * The structural check happens before any write, so a file belonging to
 * something else is refused without a transaction ever being opened on it. It
 * runs again under the write lock because a second caller may have created the
 * run in between.
 */
function establish(
  database: DatabaseSync,
  path: string,
  request: CheckedRequest,
): Result<WorkflowRunRecord> {
  try {
    if (!isUninitialized(database, path)) {
      verifySchema(database, path);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      if (isUninitialized(database, path)) {
        const stamp = new Date().toISOString();
        initializeSchema(database);
        database
          .prepare(INSERT_RUN)
          .run(
            request.runId,
            canonicalJson(definitionToJson(request.definition)),
            request.base,
            canonicalJson(request.props),
            stamp,
            stamp,
          );
      } else {
        verifySchema(database, path);
      }

      const record = readRunRow(database, path);
      database.exec("COMMIT");
      return Ok(record);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    return refusal(error, path);
  }
}

/**
 * Report a storage refusal as itself, and let anything else propagate.
 *
 * A failure this module did not classify is not an expected outcome, and
 * turning it into one would hand a caller a `Result` describing a defect.
 */
function refusal<T>(error: unknown, path: string): Result<T> {
  const translated = translateSqliteError(error, path);
  if (translated instanceof WorkflowStorageError) {
    return Err(translated);
  }
  throw translated;
}

function checkRequest(request: CreateWorkflowRunRequest): Result<CheckedRequest> {
  if (typeof request.runId !== "string" || request.runId === "") {
    return Err(new WorkflowRequestError("a run id is required, and an empty one names nothing."));
  }
  if (request.runId.includes("\u0000")) {
    return Err(
      new WorkflowRequestError(
        "a run id cannot contain a NUL: SQLite compares text up to one, so two ids that " +
          "differ only past it would address the same run.",
      ),
    );
  }
  if (typeof request.base !== "string" || request.base === "") {
    return Err(
      new WorkflowRequestError("a base is required: it is what the run's starting state is."),
    );
  }

  const definition = parseWorkflowDefinition(request.definition);
  if (!definition.ok) {
    return definition;
  }

  let props: JsonObject;
  try {
    props = parseJsonObject(request.props, "$", propsFailure);
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return Err(error);
    }
    throw error;
  }

  return Ok({
    runId: request.runId,
    definition: definition.value,
    base: request.base,
    props,
  });
}

function propsFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `the normalized props are not a JSON value: ${reason} at ${path}`,
  );
}
