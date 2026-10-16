/**
 * Read authenticated saved Workspace state without a durable effect, journal
 * entry or root publication. The transaction ends with the callback, before later
 * host work such as a Git subprocess.
 *
 * The filesystem exposes six reading members; storage compiles statements under
 * a SQLite authorizer that rejects writes, including `INSERT … RETURNING`.
 * Both views are revoked on callback return and rechecked when deferred operations
 * start.
 *
 * An optional historical root is materialized in a rollback-only savepoint. Every
 * exit, including failure and cancellation, restores the current root, saved
 * roots, rows and journal; no other observer sees the historical root selected.
 */

import type { Operation, Result } from "effection";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { guardedWorkflowWorkspaceReads, revocation, type WorkflowWorkspaceReads } from "./guard.ts";
import { transactWorkspaceRoots } from "./private.ts";
import {
  guardedWorkflowWorkspaceReadStorage,
  type WorkflowWorkspaceReadStorage,
} from "./storage.ts";

export type { WorkflowWorkspaceReads } from "./guard.ts";

/**
 * What one inspection is given.
 *
 * The two reading surfaces and nothing else: no publication, no restoration, no
 * connection, no lease, no journal route and no transaction token. Which root
 * it is reading was decided before the callback began.
 */
export interface WorkflowWorkspaceSnapshot {
  readonly filesystem: WorkflowWorkspaceReads;
  readonly storage: WorkflowWorkspaceReadStorage;
}

/** Which root an inspection reads. */
export interface WorkflowWorkspaceReadOptions {
  /**
   * The saved root to read, or the current one when omitted.
   *
   * Named rather than searched for: a root this run does not retain is refused
   * by the same restoration that a resumed run is held to, and the root the
   * Workspace is on afterwards is the one it was on before.
   */
  readonly rootId?: string;
}

/**
 * Read this run's Workspace, at the current root or at one it retains.
 *
 * Answers with what `inspect` answered, inside the run's own short transaction.
 * A failure of the transaction is the `Result`'s, exactly as every other
 * transacted read hands one back.
 */
export function* readWorkflowWorkspace<T>(
  database: WorkflowRunDatabase,
  options: WorkflowWorkspaceReadOptions,
  inspect: (snapshot: WorkflowWorkspaceSnapshot) => Operation<T>,
): Operation<Result<T>> {
  const wanted = options.rootId;
  return yield* transactWorkspaceRoots(database, function* (workspace) {
    const gate = revocation();
    const snapshot: WorkflowWorkspaceSnapshot = {
      filesystem: guardedWorkflowWorkspaceReads(workspace.filesystem, gate.held),
      storage: guardedWorkflowWorkspaceReadStorage(workspace.reads, gate.held),
    };
    const read = () => inspect(snapshot);
    try {
      // The current root is read directly. Materializing it would be a
      // restoration of the root the Workspace is already on — work with an
      // outcome identical to doing nothing, and a rollback to undo it.
      if (wanted === undefined || wanted === (yield* workspace.currentRoot())) {
        return yield* read();
      }
      return yield* workspace.readSavedRoot(wanted, read);
    } finally {
      gate.revoke();
    }
  });
}
