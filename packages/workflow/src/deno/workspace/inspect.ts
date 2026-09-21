/**
 * Reading this run's Workspace without performing a durable effect.
 *
 * Some work has to look at retained bytes and retained rows without changing
 * anything: exporting a checkout so a subprocess can run against files, or
 * proving that what a record names is still there. That is not an effect — it
 * journals nothing, publishes no root and has no result to replay — but it does
 * need the same authority as one, because the bytes it reads are the run's.
 *
 * So this opens the run's ordinary authenticated transaction, hands the
 * callback a snapshot that can only read, and closes it. The transaction is
 * held for the inspection alone: everything a caller does afterwards runs
 * against host files, so a Git subprocess never keeps the run's database open.
 *
 * "Can only read" is proven rather than promised. The filesystem is the six
 * reading members and no others, and the storage view compiles every statement
 * under a SQLite authorizer that refuses to admit anything but a read, so
 * `INSERT … RETURNING` is rejected during compilation instead of returning the
 * row it just wrote. Both are revoked when the callback returns, and both
 * recheck when an operation they produced actually begins — a callback that
 * built its writes early and yielded them late is the hole that closes.
 *
 * `rootId` is what makes a historical read possible. A run sometimes has to
 * name what it published at an earlier moment, and the Workspace has moved on
 * since — so the retained root is materialized inside a rollback-only
 * savepoint, the callback reads it, and everything that materialization wrote
 * is discarded. The current root, the retained roots, the rows and the journal
 * are what they were on every path out, including a failure and a
 * cancellation. Nothing here publishes, and there is no ordering in which
 * anything else observes the Workspace selected at the historical root.
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
   * The retained root to read, or the current one when omitted.
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
      return yield* workspace.readRetainedRoot(wanted, read);
    } finally {
      gate.revoke();
    }
  });
}
