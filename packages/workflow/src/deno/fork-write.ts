/**
 * Planting one source's committed prefix inside a fresh fork run.
 *
 * Everything here runs inside the one transaction that creates the fork, in the
 * order the schema's own references require: DOFS content, then the Workspace
 * roots that name it, then the live Workspace those roots are restored into,
 * then the journal rows that name the roots, and finally the lineage that says
 * where all of it came from. A fork that committed half of this would be a run
 * whose history points at content it does not hold.
 *
 * The inherited rows are written as text, not as re-encoded events. What the
 * fork retains for an inherited event is the record the source wrote — the same
 * bytes, the same public event id, the same Workspace root — so replaying the
 * fork consumes the source's history rather than a re-serialization of it.
 *
 * ## Retention moves with the fork
 *
 * The content is copied rather than referenced. Once this commits, the fork
 * depends on the source database for nothing, and deleting the source leaves
 * the fork's prefix and its selected root exactly as readable as they were.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { serializeDurableEvent, type DurableEvent } from "@executablemd/durable-streams";
import type { WorkflowForkLineage } from "../lifecycle/api.ts";
import type { RunConnection, RunTransaction } from "./connections.ts";
import type { ForkSourceSnapshot } from "./fork-source.ts";

/** The two records a fork writes for itself, before anything it inherited. */
export interface ForkHeadEvents {
  readonly runRecord: DurableEvent;
  readonly rootImport: DurableEvent;
}

import { reading } from "./reading.ts";
import { retainWorkspaceRoot } from "./workspace/root.ts";
import { restoreWorkspaceRoot } from "./workspace/restore.ts";

const INSERT_MANIFEST = `INSERT OR IGNORE INTO vfs_manifests (hash, size, encoded, last_seen)
  VALUES (?, ?, ?, ?)`;
const INSERT_BLOB = "INSERT OR IGNORE INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?)";
const INSERT_BLOB_BYTES = "INSERT OR IGNORE INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)";
const INSERT_EVENT = `INSERT INTO journal_events (event_id, record, workspace_root_id)
  VALUES (?, ?, ?)`;
const INSERT_PROVENANCE = `INSERT INTO journal_event_provenance
  (event_id, source_run_id, source_event_id) VALUES (?, ?, ?)`;
const INSERT_LINEAGE = `INSERT INTO workflow_fork_lineage
  (id, source_run_id, checkpoint_event_id, checkpoint_workspace_root_id, created_at)
  VALUES (1, ?, ?, ?, ?)`;
const INSERT_REPOSITORY = `INSERT INTO workspace_repositories
  (name, locator, locator_fingerprint, requested_base, creation_commit, primary_branch,
   object_format, checkout_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_WORKTREE = `INSERT INTO workspace_worktrees
  (repository_name, name, requested_branch, requested_base, creation_commit, checkout_path)
  VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * Write the inherited prefix, its content, its Workspace and its lineage.
 *
 * Called with the schema already initialized and the fork's own run row already
 * inserted, inside that same transaction.
 */
export function writeForkInheritance(
  connection: RunConnection,
  transaction: RunTransaction,
  snapshot: ForkSourceSnapshot,
  head: ForkHeadEvents,
): void {
  const { database, path } = connection;

  for (const manifest of snapshot.manifests) {
    database
      .prepare(INSERT_MANIFEST)
      .run(manifest.hash, manifest.size, manifest.encoded, manifest.lastSeen);
  }
  for (const blob of snapshot.blobs) {
    database.prepare(INSERT_BLOB).run(blob.hash, blob.size, blob.lastSeen);
    database.prepare(INSERT_BLOB_BYTES).run(blob.hash, blob.content);
  }
  // The DOFS layer caches against this connection, and rows arrived underneath
  // it. What follows reads the content store back to prove the copy is whole.
  connection.invalidateDofsCaches();

  for (const root of snapshot.roots) {
    retainWorkspaceRoot(database, root, path);
  }

  // The fork's live Workspace is the checkpoint's, materialized and published
  // before a single journal row names a root — the restoration verifies the
  // Workspace as it finds it, and a half-planted journal would fail that check
  // for a run that does not exist yet.
  restoreWorkspaceRoot(connection, transaction, snapshot.checkpointWorkspaceRootId, {
    publish: true,
  });

  for (const repository of snapshot.repositories) {
    database
      .prepare(INSERT_REPOSITORY)
      .run(
        repository.name,
        repository.locator,
        repository.locatorFingerprint,
        repository.requestedBase,
        repository.creationCommit,
        repository.primaryBranch,
        repository.objectFormat,
        repository.checkoutPath,
      );
  }
  for (const worktree of snapshot.worktrees) {
    database
      .prepare(INSERT_WORKTREE)
      .run(
        worktree.repositoryName,
        worktree.name,
        worktree.requestedBranch,
        worktree.requestedBase,
        worktree.creationCommit,
        worktree.checkoutPath,
      );
  }

  // The two records the fork wrote for itself stand where the source's stood,
  // against the same Workspace roots, and carry fork event ids.
  database
    .prepare(INSERT_EVENT)
    .run(randomUUID(), serializeDurableEvent(head.runRecord), snapshot.runRecordWorkspaceRootId);
  database
    .prepare(INSERT_EVENT)
    .run(randomUUID(), serializeDurableEvent(head.rootImport), snapshot.rootImportWorkspaceRootId);

  for (const row of snapshot.inherited) {
    database.prepare(INSERT_EVENT).run(row.eventId, row.record, row.workspaceRootId);
    database.prepare(INSERT_PROVENANCE).run(row.eventId, snapshot.sourceRunId, row.eventId);
  }

  database
    .prepare(INSERT_LINEAGE)
    .run(
      snapshot.sourceRunId,
      snapshot.checkpointEventId,
      snapshot.checkpointWorkspaceRootId,
      new Date().toISOString(),
    );
}

/** The lineage one run retains, or nothing when it is not a fork. */
export function readForkLineage(database: DatabaseSync): WorkflowForkLineage | undefined {
  const row = reading(
    database,
    `SELECT source_run_id, checkpoint_event_id, checkpoint_workspace_root_id
       FROM workflow_fork_lineage WHERE id = 1`,
  ).get();
  if (row === undefined) {
    return undefined;
  }
  const sourceRunId = row["source_run_id"];
  const checkpointEventId = row["checkpoint_event_id"];
  const checkpointWorkspaceRootId = row["checkpoint_workspace_root_id"];
  if (
    typeof sourceRunId !== "string" ||
    typeof checkpointEventId !== "string" ||
    typeof checkpointWorkspaceRootId !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({ sourceRunId, checkpointEventId, checkpointWorkspaceRootId });
}
