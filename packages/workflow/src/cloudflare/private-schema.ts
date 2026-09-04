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

const MUTATION_SQL = `CREATE TABLE ${MUTATION_TABLE} (
  command_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  response TEXT NOT NULL CHECK (json_valid(response)),
  response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0)
) STRICT, WITHOUT ROWID`;

const PRIVATE_OBJECTS = new Map([
  [COMMAND_TABLE, { type: "table", sql: COMMAND_SQL }],
  [STAGING_TABLE, { type: "table", sql: STAGING_SQL }],
  [MUTATION_TABLE, { type: "table", sql: MUTATION_SQL }],
]);

export const PRIVATE_OBJECT_NAMES: readonly string[] = Object.freeze([...PRIVATE_OBJECTS.keys()]);

export function initializePrivateSchema(storage: OwnerStorage): void {
  storage.sql.exec(`${COMMAND_SQL};\n\n${STAGING_SQL};\n\n${MUTATION_SQL};`);
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
}
