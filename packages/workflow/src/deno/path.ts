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

/**
 * The sidecars one run's executor arranges beside its database.
 *
 * Suffixes rather than a subdirectory, so every path a run occupies is derived
 * from one hash and inspection's candidate pattern — `<hash>.sqlite` exactly —
 * excludes all three by construction. None of them is retained run state: they
 * are how one host arranges ownership, and a different host may arrange it
 * differently without changing what the run is.
 */
export interface WorkflowRunSidecars {
  /** The advisory lock. Empty, and never unlinked while a lease may hold it. */
  readonly lock: string;
  /** Who owns the run right now, and under which generation. */
  readonly descriptor: string;
  /** One pending request addressed to that exact generation. */
  readonly request: string;
}

export function workflowRunSidecars(root: string, runId: string): WorkflowRunSidecars {
  const hash = hashRunId(runId);
  return Object.freeze({
    lock: join(root, `${hash}.lock`),
    descriptor: join(root, `${hash}.control`),
    request: join(root, `${hash}.request`),
  });
}
