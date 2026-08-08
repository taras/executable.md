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
import type { DatabaseSync } from "node:sqlite";
import { ensureDir, exists } from "@effectionx/fs";
import { createContext, ensure, Err, Ok, type Operation, type Result, scoped } from "effection";
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
import {
  describe,
  type JsonObject,
  type Members,
  parseJsonObject,
  parseMembers,
  requireMemberNames,
} from "../storage/members.ts";
import { canonicalJson, type WorkflowRunRecord } from "../storage/record.ts";
import { openWorkflowRunDatabase, readRunRow } from "./database.ts";
import {
  createWorkflowRunConnections,
  type RunConnection,
  type RunTransaction,
  type WorkflowRunConnections,
} from "./connections.ts";
import { workflowRunPath } from "./path.ts";
import { readTransaction } from "./reading.ts";
import { initializeSchema, isUninitialized, translateSqliteError, verifySchema } from "./schema.ts";
import { SavepointObservation } from "./savepoints.ts";
import { usePrivateWorkspace } from "./workspace/private.ts";

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

export type WorkflowRunRecognitionProbe = (database: DatabaseSync) => void;

/** Adapter-private observation seam for deterministic snapshot tests. */
export const WorkflowRunRecognition = createContext<WorkflowRunRecognitionProbe>(
  "executablemd.workflow.deno.recognition",
  () => {},
);

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
  const connections = createWorkflowRunConnections(yield* SavepointObservation.get());
  yield* ensure(() => {
    connections.close();
  });
  yield* usePrivateWorkspace(connections);

  yield* WorkflowRunStorage.around(
    {
      *create([request]) {
        return yield* createWorkflowRun(root, connections, request);
      },
      *lookup([runId]) {
        return yield* lookupWorkflowRun(root, connections, runId);
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
  connections: WorkflowRunConnections,
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

  try {
    const inspectRecognition = yield* WorkflowRunRecognition.expect();
    const connection = connections.at(path);
    const { lock } = connection;
    // Held across initialization, so a second caller creating the same run
    // waits here rather than inside a synchronous `BEGIN IMMEDIATE` that
    // would stop the host while the first one is still committing.
    const stored = yield* scoped(function* () {
      yield* lock.hold();
      return establish(connection, path, wanted, inspectRecognition);
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

    return Ok(yield* openWorkflowRunDatabase({ connection, connections, record }));
  } catch (error) {
    return refusal(error, path);
  }
}

function* lookupWorkflowRun(
  root: string,
  connections: WorkflowRunConnections,
  runId: string,
): Operation<Result<WorkflowRunDatabase>> {
  const checked = checkRunId(runId);
  if (!checked.ok) {
    return checked;
  }
  const wanted = checked.value;

  const path = workflowRunPath(root, wanted);
  // Asked before opening: `node:sqlite` creates the file it is pointed at, and
  // a lookup that leaves an empty database behind has invented the run it
  // failed to find.
  if (!(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(wanted));
  }

  try {
    const inspectRecognition = yield* WorkflowRunRecognition.expect();
    const connection = connections.at(path);
    const { database, lock } = connection;
    const record = yield* scoped(function* (): Operation<Result<WorkflowRunRecord>> {
      yield* lock.hold();
      try {
        return Ok(recognizeExisting(connection, path, inspectRecognition));
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

    return Ok(yield* openWorkflowRunDatabase({ connection, connections, record: record.value }));
  } catch (error) {
    return refusal(error, path);
  }
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
  connection: RunConnection,
  path: string,
  request: CheckedRequest,
  inspectRecognition: WorkflowRunRecognitionProbe,
): Result<WorkflowRunRecord> {
  const { database } = connection;
  try {
    readTransaction(database, () => {
      if (!isUninitialized(database, path)) {
        verifySchema(database, path, connection.dofs);
        inspectRecognition(database);
      }
    });

    database.exec("BEGIN IMMEDIATE");
    let transaction: RunTransaction;
    try {
      transaction = connection.beginTransaction();
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    try {
      if (isUninitialized(database, path)) {
        const stamp = new Date().toISOString();
        initializeSchema(database, connection.dofs, () => {
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
        });
      } else {
        verifySchema(database, path, connection.dofs);
      }

      verifySchema(database, path, connection.dofs);
      const record = readRunRow(database, path);
      connection.validateTransaction(transaction);
      connection.finishTransaction(transaction);
      database.exec("COMMIT");
      return Ok(record);
    } catch (error) {
      if (transaction.open) {
        connection.finishTransaction(transaction);
      }
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    return refusal(error, path);
  }
}

function recognizeExisting(
  connection: RunConnection,
  path: string,
  inspectRecognition: WorkflowRunRecognitionProbe,
): WorkflowRunRecord {
  return readTransaction(connection.database, () => {
    verifySchema(connection.database, path, connection.dofs);
    inspectRecognition(connection.database);
    return readRunRow(connection.database, path);
  });
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

const REQUEST_MEMBERS = ["runId", "definition", "base", "props"];

/**
 * The run id a caller named, whichever operation they called.
 *
 * `create` and `lookup` address the same runs by the same rule, so they check
 * it in the same place. Nothing here assumes the argument is a string: a host
 * built without types, or one that read the id out of a file, can hand over
 * anything at all, and hashing that would fail somewhere far less legible.
 */
function checkRunId(runId: unknown): Result<string> {
  if (typeof runId !== "string" || runId === "") {
    return Err(
      new WorkflowRequestError(
        `a run id is required, and an empty one names nothing (found ${describe(runId)}).`,
      ),
    );
  }
  if (runId.includes("\u0000")) {
    return Err(
      new WorkflowRequestError(
        "a run id cannot contain a NUL: SQLite compares text up to one, so two ids that " +
          "differ only past it would address the same run.",
      ),
    );
  }
  return Ok(runId);
}

/**
 * The whole request, parsed as a closed shape before any member is read.
 *
 * The type describes what a caller meant. What arrives is whatever the
 * language allows, and reading `.runId` off `null` fails as a `TypeError`
 * rather than as an answer about the request.
 */
function checkRequest(offered: CreateWorkflowRunRequest): Result<CheckedRequest> {
  let members: Members;
  try {
    members = parseMembers(offered, "$", requestFailure);
    requireMemberNames(members, REQUEST_MEMBERS, "$", requestFailure);
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return Err(error);
    }
    throw error;
  }

  const runId = checkRunId(members.get("runId"));
  if (!runId.ok) {
    return runId;
  }

  const base = members.get("base");
  if (typeof base !== "string" || base === "") {
    return Err(
      new WorkflowRequestError("a base is required: it is what the run's starting state is."),
    );
  }

  const definition = parseWorkflowDefinition(members.get("definition"));
  if (!definition.ok) {
    return definition;
  }

  let props: JsonObject;
  try {
    props = parseJsonObject(members.get("props"), "$", propsFailure);
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return Err(error);
    }
    throw error;
  }

  return Ok({ runId: runId.value, definition: definition.value, base, props });
}

function requestFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `the request does not describe a workflow run: ${reason} at ${path}`,
  );
}

function propsFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `the normalized props are not a JSON value: ${reason} at ${path}`,
  );
}
