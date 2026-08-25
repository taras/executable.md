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

/**
 * A recognized database was found where another run's id would put it.
 *
 * The same disagreement between location and identity, discovered from the
 * other side: nobody asked for this run, and the file it was found in is not
 * the one its id names. Reported as its own sentence because "the run you asked
 * for is not here" and "this run is not where it belongs" read as opposite
 * claims about the same file.
 */
export class WorkflowRunLocationMismatchError extends WorkflowRunIdMismatchError {
  override name = "WorkflowRunLocationMismatchError";

  constructor(runId: string, path: string) {
    super(runId, path);
    this.message =
      `The database at ${path} retains the workflow run ${JSON.stringify(runId)}, whose id ` +
      "does not name this file. A run's file name is the hash of its id, so a database found " +
      "anywhere else is a collision or a copy. It is left unchanged.";
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

/** The unsupported pre-release schema that claimed the now-complete version 1. */
export class WorkflowIncompleteVersionOneError extends WorkflowDatabaseCorruptError {
  override name = "WorkflowIncompleteVersionOneError";

  constructor(path: string) {
    super(path, "it contains the incomplete pre-release version-1 structure");
    this.message =
      `The workflow-run database at ${path} contains the unsupported incomplete ` +
      "pre-release version-1 structure. It is not migrated or changed. Delete and recreate " +
      "this pre-release database with the complete version-1 provider.";
  }
}

/**
 * A crashed run could not be inspected from a private recovered copy.
 *
 * Inspection reads a database a lost host left mid-transaction by recovering a
 * copy of it, so this says the copy could not be produced or could not be
 * cleaned up — never that the run itself is damaged. Damage keeps its own
 * types. The retained database and its journal are unchanged either way.
 *
 * `scratchPath` is absent whenever cleanup succeeded, which is every failure
 * except one. It is populated only when the private copy could not be removed,
 * because that is the single case where the operator has something to do.
 */
export class WorkflowInspectionRecoveryError extends WorkflowStorageError {
  override name = "WorkflowInspectionRecoveryError";

  /** The retained run database inspection was asked about. */
  readonly path: string;

  /** The private directory that still holds a copy, when removal failed. */
  readonly scratchPath: string | undefined;

  constructor(path: string, scratchPath?: string) {
    super(
      scratchPath === undefined
        ? `The crashed workflow-run database at ${path} could not be inspected from a private ` +
            "recovered copy. It is left unchanged, and its next write-capable owner still " +
            "recovers it."
        : `The crashed workflow-run database at ${path} was inspected from a private recovered ` +
            `copy that could not be removed afterwards. It is left unchanged. Remove ${scratchPath} ` +
            "when you no longer need it.",
    );
    this.path = path;
    this.scratchPath = scratchPath;
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

/**
 * The base of every expected XMD artifact outcome.
 *
 * An artifact is discovered from the path a caller supplied and from nothing
 * else, so every one of these names that path. None of them quotes a retained
 * byte: an artifact holds whatever the run wrote into its Workspace, and a
 * refusal that repeated part of it would publish the content the file was
 * being refused for.
 *
 * The conditions below are separate because callers act on them differently. A
 * foreign container is somebody's other file, a live run database is XMD's own
 * writable state offered as evidence, a future version is a file a later build
 * reads, and a mismatch is evidence that no longer describes itself. Collapsing
 * them would leave an operator guessing which of those they are holding.
 */
export class XmdArtifactError extends WorkflowStorageError {
  override name = "XmdArtifactError";

  /** The artifact path the caller supplied. */
  readonly path: string;

  constructor(path: string, sentence: string) {
    super(sentence);
    this.path = path;
  }
}

/** The path does not name a regular `.xmd` file. */
export class XmdArtifactPathError extends XmdArtifactError {
  override name = "XmdArtifactPathError";

  constructor(path: string, reason: string) {
    super(path, `The path ${path} does not name an XMD artifact: ${reason}.`);
  }
}

/** Nothing at this path can be opened. */
export class XmdArtifactUnreadableError extends XmdArtifactError {
  override name = "XmdArtifactUnreadableError";

  constructor(path: string, reason: string) {
    super(path, `The XMD artifact at ${path} could not be opened: ${reason}.`);
  }
}

/** A SQLite database that belongs to another program. */
export class XmdArtifactForeignContainerError extends XmdArtifactError {
  override name = "XmdArtifactForeignContainerError";

  constructor(path: string, reason: string) {
    super(path, `The file at ${path} is not an XMD artifact: ${reason}. It is left unchanged.`);
  }
}

/**
 * A live workflow-run database, offered where an artifact was expected.
 *
 * Its own category rather than a foreign container, because this file is XMD's
 * and the mistake is what it is being used *as*. A run store is writable
 * authority over a run id; an artifact is evidence nobody can advance. Reading
 * one as the other is how two downloaded copies would come to believe they
 * coordinate a single live identity.
 */
export class XmdArtifactLiveRunError extends XmdArtifactError {
  override name = "XmdArtifactLiveRunError";

  constructor(path: string) {
    super(
      path,
      `The file at ${path} is a live workflow-run database, not an XMD artifact. A run store ` +
        "is writable authority over its run; export it as an artifact rather than renaming it.",
    );
  }
}

/** The container schema version is one this build does not implement. */
export class XmdArtifactContainerVersionError extends XmdArtifactError {
  override name = "XmdArtifactContainerVersionError";

  readonly stored: number;
  readonly supported: number;

  constructor(path: string, stored: number, supported: number) {
    super(
      path,
      `The XMD artifact at ${path} uses container schema version ${stored}, and this build ` +
        `implements version ${supported}. It is neither migrated nor rewritten.`,
    );
    this.stored = stored;
    this.supported = supported;
  }
}

/** The artifact format version is one this build does not implement. */
export class XmdArtifactFormatVersionError extends XmdArtifactError {
  override name = "XmdArtifactFormatVersionError";

  readonly stored: number;
  readonly supported: number;

  constructor(path: string, stored: number, supported: number) {
    super(
      path,
      `The XMD artifact at ${path} declares artifact format version ${stored}, and this build ` +
        `implements version ${supported}. It is neither migrated nor rewritten.`,
    );
    this.stored = stored;
    this.supported = supported;
  }
}

/** The container claims this version and is not shaped like it. */
export class XmdArtifactSchemaError extends XmdArtifactError {
  override name = "XmdArtifactSchemaError";

  constructor(path: string, reason: string) {
    super(
      path,
      `The XMD artifact at ${path} disagrees with the version it declares: ${reason}. ` +
        "It is left unchanged.",
    );
  }
}

/** A retained record does not describe what its kind claims. */
export class XmdArtifactRecordError extends XmdArtifactError {
  override name = "XmdArtifactRecordError";

  /** Which entry kind failed to parse, never the content it held. */
  readonly kind: string;

  constructor(path: string, kind: string, reason: string) {
    super(
      path,
      `The XMD artifact at ${path} holds a ${kind} record that does not describe one: ` +
        `${reason}. It is left unchanged.`,
    );
    this.kind = kind;
  }
}

/** The accepted content is not the inventory the artifact is required to hold. */
export class XmdArtifactInventoryError extends XmdArtifactError {
  override name = "XmdArtifactInventoryError";

  constructor(path: string, reason: string) {
    super(
      path,
      `The XMD artifact at ${path} does not hold a complete inventory: ${reason}. ` +
        "It is left unchanged.",
    );
  }
}

/** A stored entry's bytes are not the bytes its own row declares. */
export class XmdArtifactContentError extends XmdArtifactError {
  override name = "XmdArtifactContentError";

  readonly kind: string;

  constructor(path: string, kind: string, reason: string) {
    super(
      path,
      `The XMD artifact at ${path} holds ${kind} content that does not match its declared ` +
        `${reason}. It is left unchanged.`,
    );
    this.kind = kind;
  }
}

/** The stored manifest is not the manifest this artifact's content produces. */
export class XmdArtifactManifestMismatchError extends XmdArtifactError {
  override name = "XmdArtifactManifestMismatchError";

  constructor(path: string) {
    super(
      path,
      `The XMD artifact at ${path} stores an artifact manifest that its own content does not ` +
        "produce, so it no longer describes the run it claims to. It is left unchanged.",
    );
  }
}

/** The stored identity is not the identity this artifact's manifest derives. */
export class XmdArtifactIdentityMismatchError extends XmdArtifactError {
  override name = "XmdArtifactIdentityMismatchError";

  constructor(path: string) {
    super(
      path,
      `The XMD artifact at ${path} stores an artifact identity its own manifest does not ` +
        "derive. It is left unchanged.",
    );
  }
}

/** Nothing may be written at the destination an artifact was asked for. */
export class XmdArtifactDestinationError extends XmdArtifactError {
  override name = "XmdArtifactDestinationError";

  constructor(path: string, reason: string) {
    super(path, `No XMD artifact was written at ${path}: ${reason}.`);
  }
}

/**
 * The file was written and does not read back as what was sealed into it.
 *
 * Reported rather than returned as an artifact, because the alternative is
 * handing back a path whose contents this build has just failed to recognize.
 */
export class XmdArtifactWriteVerificationError extends XmdArtifactError {
  override name = "XmdArtifactWriteVerificationError";

  constructor(path: string, reason: string) {
    super(
      path,
      `The XMD artifact written at ${path} does not read back as the snapshot it was given: ` +
        `${reason}. No artifact is reported.`,
    );
  }
}

/**
 * Incomplete staging state could not be removed.
 *
 * Names the leftover path because that is the one case where an operator has
 * something to do. A failure here never reports a successful artifact: a file
 * nobody could finish writing is not evidence.
 */
export class XmdArtifactCleanupError extends XmdArtifactError {
  override name = "XmdArtifactCleanupError";

  constructor(path: string, reason: string) {
    super(
      path,
      `The incomplete XMD artifact staging state at ${path} could not be removed: ${reason}. ` +
        "No artifact is reported. Remove it when you no longer need it.",
    );
  }
}
