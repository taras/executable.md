/**
 * The expected outcomes of durable workflow-run storage.
 *
 * Each condition a caller can act on differently gets its own type. A run that
 * is absent, a run that is present but incompatible, a file that belongs to
 * another run, a file that is not one of ours, a schema this version cannot
 * read, a file SQLite cannot read at all, and a row that does not parse are
 * seven different situations, and collapsing them would leave a host guessing
 * whether to create, refuse, or report damage.
 *
 * None of these messages quotes a stored value. Retained props and journal
 * payloads are filtered history, and a storage failure is not a reason to copy
 * them into an error that travels to logs and terminals. A conflict names the
 * fields that differ; the run id and the host path are named because the caller
 * supplied one and the host chose the other.
 */

/** The base of every expected durable workflow-run storage outcome. */
export class WorkflowStorageError extends Error {
  override name = "WorkflowStorageError";
}

/** Nothing is stored under this run id. */
export class WorkflowRunNotFoundError extends WorkflowStorageError {
  override name = "WorkflowRunNotFoundError";

  readonly runId: string;

  constructor(runId: string) {
    super(
      `No workflow run is stored under the run id ${JSON.stringify(runId)}. ` +
        "Start the run before looking it up.",
    );
    this.runId = runId;
  }
}

/** A run is stored under this id, and its immutable identity is a different one. */
export class WorkflowRunConflictError extends WorkflowStorageError {
  override name = "WorkflowRunConflictError";

  readonly runId: string;

  /** The immutable fields that differ, never the values they hold. */
  readonly fields: readonly string[];

  constructor(runId: string, fields: readonly string[]) {
    super(
      `The workflow run ${JSON.stringify(runId)} is already stored with a different ` +
        `${fields.join(", ")}. Immutable identity cannot be replaced by reusing a run id: ` +
        "start a new run instead.",
    );
    this.runId = runId;
    this.fields = Object.freeze([...fields]);
  }
}

/**
 * The database at this run id's calculated path holds a different run.
 *
 * The path is derived from the run id, so a file holding another run means the
 * hash collided or the storage root was tampered with. Neither is a reason to
 * treat the file as this run's, and neither is repaired by overwriting it.
 */
export class WorkflowRunIdMismatchError extends WorkflowStorageError {
  override name = "WorkflowRunIdMismatchError";

  readonly runId: string;
  readonly path: string;

  constructor(runId: string, path: string) {
    super(
      `The database at ${path} stores a run other than ${JSON.stringify(runId)}, which is ` +
        "the run its path is derived from. It is left unchanged.",
    );
    this.runId = runId;
    this.path = path;
  }
}

/** The file is readable, and it is not a workflow-run database. */
export class WorkflowDatabaseFormatError extends WorkflowStorageError {
  override name = "WorkflowDatabaseFormatError";

  readonly path: string;

  constructor(path: string, reason: string) {
    super(`The file at ${path} is not a workflow-run database: ${reason}. It is left unchanged.`);
    this.path = path;
  }
}

/** The database holds a schema version this build does not implement. */
export class WorkflowSchemaVersionError extends WorkflowStorageError {
  override name = "WorkflowSchemaVersionError";

  readonly path: string;
  readonly stored: number;
  readonly supported: number;

  constructor(path: string, stored: number, supported: number) {
    super(
      `The database at ${path} holds schema version ${stored}, and this build implements ` +
        `version ${supported}. No migration is applied and the file is left unchanged.`,
    );
    this.path = path;
    this.stored = stored;
    this.supported = supported;
  }
}

/** SQLite cannot read the file, or its integrity check reports damage. */
export class WorkflowDatabaseCorruptError extends WorkflowStorageError {
  override name = "WorkflowDatabaseCorruptError";

  readonly path: string;

  constructor(path: string, reason: string) {
    super(
      `The workflow-run database at ${path} is damaged: ${reason}. It is left unchanged; ` +
        "restore it from a backup rather than starting over in place.",
    );
    this.path = path;
  }
}

/** A stored row does not describe what its column claims to hold. */
export class WorkflowRecordMalformedError extends WorkflowStorageError {
  override name = "WorkflowRecordMalformedError";

  /** Where the offending value lives, such as `workflow_run.props`. */
  readonly location: string;

  constructor(location: string, reason: string) {
    super(`The stored ${location} does not parse: ${reason}. The database is left unchanged.`);
    this.location = location;
  }
}

/** A value a caller supplied does not describe what storage was asked to keep. */
export class WorkflowRequestError extends WorkflowStorageError {
  override name = "WorkflowRequestError";

  constructor(reason: string) {
    super(reason);
  }
}

/** The document execution a completion names is not one this run can finish. */
export class WorkflowDocumentExecutionError extends WorkflowStorageError {
  override name = "WorkflowDocumentExecutionError";

  readonly executionId: string;

  constructor(executionId: string) {
    super(
      `No unfinished document execution is stored under ${JSON.stringify(executionId)}. ` +
        "An execution is finished once, by the executor that began it.",
    );
    this.executionId = executionId;
  }
}

/** A transaction cannot be started, continued, or committed as asked. */
export class WorkflowTransactionError extends WorkflowStorageError {
  override name = "WorkflowTransactionError";

  constructor(reason: string) {
    super(reason);
  }
}

/** The scope that owned the database handle has closed. */
export class WorkflowDatabaseClosedError extends WorkflowStorageError {
  override name = "WorkflowDatabaseClosedError";

  readonly runId: string;

  constructor(runId: string) {
    super(
      `The database handle for workflow run ${JSON.stringify(runId)} belongs to a scope that ` +
        "has closed. Look the run up again inside a live scope.",
    );
    this.runId = runId;
  }
}

/** A value offered as a workflow definition descriptor does not describe one. */
export class WorkflowDefinitionError extends WorkflowStorageError {
  override name = "WorkflowDefinitionError";

  /** Location of the offending member within the descriptor, such as `$.objectId`. */
  readonly path: string;

  constructor(reason: string, path: string) {
    super(`${reason} at ${path}`);
    this.path = path;
  }
}
