/**
 * The scratch state one acquisition keeps, and nothing else keeps.
 *
 * Hibernation is why this is in SQLite rather than in a field or an attachment.
 * An idle Durable Object is evicted while its sockets stay open, so anything
 * held in memory is gone by the time the next message arrives; and the
 * attachment is bounded at 16 KiB and is the compact acquisition identity, not
 * somewhere to put a growing ledger or a content payload.
 *
 * Two tables, both keyed by the owner-minted acquisition ID. One remembers what
 * each command ID already decided, so a retry returns the decision rather than
 * acting twice. The other holds content a runner has offered but nothing has
 * adopted.
 *
 * Neither is run state. Staged bytes are not published content: they are in no
 * root, referenced by nothing, invisible to every retained read, and adopting
 * them is a later checkpoint's transaction to perform. Both are declared here
 * rather than in the shared logical schema for exactly that reason — they are
 * this adapter's physical scratch, and a host that had no hibernation would
 * need neither.
 *
 * Recognition checks their exact shapes like any other declared object. Storage
 * carrying a table this build did not write is refused rather than tolerated
 * because its name looked familiar.
 */

import { normalize, type SchemaObject } from "../sqlite/workflow-schema.ts";
import type { OwnerStorage } from "./storage.ts";

export const COMMAND_TABLE = "_xmd_executor_commands";
/**
 * Decisions about mutations, which outlive the connection that asked for them.
 *
 * The acquisition-scoped ledger answers a retry on the same socket. It cannot
 * answer the case that matters most: the owner committed, the answer was lost,
 * and the connection died. A replacement acquisition discards its predecessor's
 * scratch — correctly, because staged bytes and read decisions belong to the
 * connection that produced them — but the fact that a mutation was applied is
 * not scratch. It is the only thing that lets the next connection tell "this
 * already happened" from "this never happened", and without it the same request
 * meets a moved frontier and is refused as stale while the runner has no way to
 * know whether to promote or discard.
 *
 * So a mutation decision is keyed by the run rather than the acquisition, and
 * cleanup never touches it. It is not a lease and does not expire because a
 * socket did.
 */
export const MUTATION_TABLE = "_xmd_run_mutations";
export const STAGING_TABLE = "_xmd_executor_staging";

/**
 * Which execution each acquisition began, as the owner knows it.
 *
 * The runner remembers this too, in the hold it issued, but a runner's memory
 * is not authority: a settlement arrives naming an execution, and what decides
 * whether this caller may finish it is what the owner retained when that
 * execution began. Kept here rather than in a field because an evicted Durable
 * Object forgets fields and keeps its sockets, so the association has to be
 * where the next message can still find it.
 *
 * One row per acquisition: one acquisition begins one execution. The row is
 * this connection's, so a replacement acquisition discards it and cannot adopt
 * the execution it named.
 */
export const HOLD_TABLE = "_xmd_executor_holds";

/**
 * The parts of a fork one acquisition has offered, before any of it is a run.
 *
 * A fork source is larger than one message may be, so it crosses in bounded
 * parts that name where they belong in the selection, and the final command
 * commits them together. Like staged content these are scratch: nothing reads
 * them, nothing inherits them, and a replacement acquisition throws them away.
 */
export const FORK_TABLE = "_xmd_executor_fork_parts";

const COMMAND_SQL = `CREATE TABLE ${COMMAND_TABLE} (
  acquisition_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  response TEXT NOT NULL CHECK (json_valid(response)),
  response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
  PRIMARY KEY (acquisition_id, command_id)
) STRICT, WITHOUT ROWID`;

const STAGING_SQL = `CREATE TABLE ${STAGING_TABLE} (
  acquisition_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manifest', 'blob')),
  digest TEXT NOT NULL CHECK (
    length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
  ),
  size INTEGER NOT NULL CHECK (size > 0),
  bytes BLOB NOT NULL,
  PRIMARY KEY (acquisition_id, kind, digest)
) STRICT, WITHOUT ROWID`;

const HOLD_SQL = `CREATE TABLE ${HOLD_TABLE} (
  acquisition_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL
) STRICT, WITHOUT ROWID`;

const FORK_SQL = `CREATE TABLE ${FORK_TABLE} (
  acquisition_id TEXT NOT NULL,
  section TEXT NOT NULL CHECK (
    section IN ('inherited', 'roots', 'manifests', 'blobs', 'checkouts')
  ),
  position INTEGER NOT NULL CHECK (position >= 0),
  part TEXT NOT NULL CHECK (json_valid(part)),
  part_bytes INTEGER NOT NULL CHECK (part_bytes > 0),
  PRIMARY KEY (acquisition_id, section, position)
) STRICT, WITHOUT ROWID`;

const MUTATION_SQL = `CREATE TABLE ${MUTATION_TABLE} (
  command_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  response TEXT NOT NULL CHECK (json_valid(response)),
  response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
  execution_id TEXT
) STRICT, WITHOUT ROWID`;

const PRIVATE_OBJECTS = new Map([
  [COMMAND_TABLE, { type: "table", sql: COMMAND_SQL }],
  [STAGING_TABLE, { type: "table", sql: STAGING_SQL }],
  [MUTATION_TABLE, { type: "table", sql: MUTATION_SQL }],
  [HOLD_TABLE, { type: "table", sql: HOLD_SQL }],
  [FORK_TABLE, { type: "table", sql: FORK_SQL }],
]);

export const PRIVATE_OBJECT_NAMES: readonly string[] = Object.freeze([...PRIVATE_OBJECTS.keys()]);

export function initializePrivateSchema(storage: OwnerStorage): void {
  if (privateSchemaPresent(storage)) {
    // Already here, because a transfer was offered before the run it belongs
    // to existed. The scratch is this adapter's own and is not rewritten.
    return;
  }
  storage.sql.exec(
    `${COMMAND_SQL};\n\n${STAGING_SQL};\n\n${MUTATION_SQL};\n\n${HOLD_SQL};\n\n${FORK_SQL};`,
  );
}

/** Whether this adapter's own scratch tables are already declared here. */
export function privateSchemaPresent(storage: OwnerStorage): boolean {
  const names = new Set(
    storage.sql
      .exec("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .toArray()
      .map((row) => String(row["name"])),
  );
  return PRIVATE_OBJECT_NAMES.every((name) => names.has(name));
}

export function privateStructureFailure(
  objects: readonly SchemaObject[],
): { kind: "missing" | "misshapen"; name: string } | undefined {
  const byName = new Map(objects.map((object) => [object.name, object]));
  for (const [name, expected] of PRIVATE_OBJECTS) {
    const found = byName.get(name);
    if (found === undefined) {
      return { kind: "missing", name };
    }
    if (found.type !== expected.type || normalize(found.sql) !== normalize(expected.sql)) {
      return { kind: "misshapen", name };
    }
  }
  return undefined;
}

/**
 * Discard what belonged to a connection that is gone.
 *
 * Staged bytes and read decisions are that connection's scratch and go with it.
 * Mutation decisions deliberately do not: they are how the next connection
 * learns that a commit already happened, and deleting one would turn a retry
 * into a second mutation or a refusal the runner cannot interpret.
 */
export function discardPriorAcquisitions(storage: OwnerStorage, acquisitionId: string): void {
  storage.sql.exec(`DELETE FROM ${COMMAND_TABLE} WHERE acquisition_id <> ?`, acquisitionId);
  storage.sql.exec(`DELETE FROM ${STAGING_TABLE} WHERE acquisition_id <> ?`, acquisitionId);
  // A previous connection's fork parts describe a transfer nobody is going to
  // finish, and its execution association belonged to a connection that can no
  // longer settle anything. Neither is inherited: what an earlier executor left
  // unfinished is decided by recovery, from what the run itself retains.
  storage.sql.exec(`DELETE FROM ${FORK_TABLE} WHERE acquisition_id <> ?`, acquisitionId);
  storage.sql.exec(`DELETE FROM ${HOLD_TABLE} WHERE acquisition_id <> ?`, acquisitionId);
}

/**
 * Adopt the execution a retained decision began, when nobody else holds it.
 *
 * The case this exists for: a mutation committed, its answer was lost, the
 * connection that asked died, and a replacement acquisition asked the same
 * question again. Re-observing the decision is not enough — the execution it
 * began has to become this acquisition's, or the caller would be handed a run
 * it cannot settle. The old acquisition is already gone by the time this runs,
 * because its scratch and its hold went with it.
 */
export function adoptExecution(
  storage: OwnerStorage,
  acquisitionId: string,
  commandId: string,
): "adopted" | "nothing-to-adopt" | "stale" {
  const decided = storage.sql
    .exec(`SELECT execution_id FROM ${MUTATION_TABLE} WHERE command_id = ?`, commandId)
    .toArray()[0];
  const executionId = decided?.["execution_id"];
  if (typeof executionId !== "string") {
    // The decision began nothing, so there is nothing to hold. Answering it
    // again is answering a question, not granting authority.
    return "nothing-to-adopt";
  }
  const open = storage.sql
    .exec(
      "SELECT execution_id FROM document_executions WHERE execution_id = ? AND stopped_at IS NULL",
      executionId,
    )
    .toArray()[0];
  if (open === undefined) {
    // Finished since — recovered by a later executor, or settled. The run has
    // moved past this decision, and handing it back as current authority would
    // hand back a database nobody may settle.
    return "stale";
  }
  const holder = storage.sql
    .exec(`SELECT acquisition_id FROM ${HOLD_TABLE} WHERE execution_id = ?`, executionId)
    .toArray()[0];
  if (holder !== undefined) {
    if (holder["acquisition_id"] !== acquisitionId) {
      // Somebody live holds it. Two acquisitions cannot hold one execution.
      return "stale";
    }
    return "adopted";
  }
  storage.sql.exec(
    `INSERT INTO ${HOLD_TABLE} (acquisition_id, execution_id) VALUES (?, ?)`,
    acquisitionId,
    executionId,
  );
  return "adopted";
}

/**
 * Which execution one retained decision began, as the ledger recorded it.
 *
 * Read without adopting anything. The mutation row and the answer it retains
 * have to agree about whether a decision granted execution authority, and
 * establishing that is not the same act as taking the authority.
 */
export function recordedExecution(storage: OwnerStorage, commandId: string): string | undefined {
  const row = storage.sql
    .exec(`SELECT execution_id FROM ${MUTATION_TABLE} WHERE command_id = ?`, commandId)
    .toArray()[0];
  const recorded = row?.["execution_id"];
  return typeof recorded === "string" ? recorded : undefined;
}

/** Which execution this acquisition began, when it has begun one. */
export function heldExecution(storage: OwnerStorage, acquisitionId: string): string | undefined {
  const row = storage.sql
    .exec(`SELECT execution_id FROM ${HOLD_TABLE} WHERE acquisition_id = ?`, acquisitionId)
    .toArray()[0];
  const held = row?.["execution_id"];
  return typeof held === "string" ? held : undefined;
}

/**
 * Record that this acquisition began this execution.
 *
 * Refuses a second one. An acquisition begins one execution, and the owner is
 * where that is decided: a runner that lost track of its own hold cannot talk
 * this store into holding two.
 */
export function holdExecution(
  storage: OwnerStorage,
  acquisitionId: string,
  executionId: string,
): void {
  storage.sql.exec(
    `INSERT INTO ${HOLD_TABLE} (acquisition_id, execution_id) VALUES (?, ?)`,
    acquisitionId,
    executionId,
  );
}

/** Let go of the execution this acquisition began, once it is finished. */
export function releaseExecution(storage: OwnerStorage, acquisitionId: string): void {
  storage.sql.exec(`DELETE FROM ${HOLD_TABLE} WHERE acquisition_id = ?`, acquisitionId);
}
