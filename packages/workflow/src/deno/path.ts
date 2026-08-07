/**
 * Where this host keeps a run.
 *
 * A run's file name is the SHA-256 of its public run id, so an id containing a
 * separator, a leading dot, or a character this filesystem cannot spell still
 * names exactly one file directly beneath the authorized root. Hashing is also
 * what removes the need for a second registry: discovery is arithmetic on the
 * id, and there is no index to disagree with the files.
 *
 * The root and the path it produces are host arrangement, not identity. A run
 * moved to another root is the same run, which is why the run id is also stored
 * inside the database and checked against the one that was asked for.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

/** The lowercase hexadecimal SHA-256 of a run id's UTF-8 bytes. */
export function hashRunId(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

/** The file a run id names beneath `root`. */
export function workflowRunPath(root: string, runId: string): string {
  return join(root, `${hashRunId(runId)}.sqlite`);
}
