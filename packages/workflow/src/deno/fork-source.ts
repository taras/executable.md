/**
 * The committed source snapshot a fork is admitted from.
 *
 * Everything a fork inherits is read here, once, on a read-only connection, in
 * one transaction — the journal rows exactly as they are stored, the Workspace
 * roots those rows name, the DOFS content behind those roots, and the checkout
 * metadata the checkpoint's Workspace held. The source's executor lock is never
 * taken and no statement here writes: a fork reads a committed prefix, and a
 * caller who is still appending to the source past that prefix is appending to
 * events this snapshot does not contain.
 *
 * Reading the content into memory rather than copying between two open
 * databases is what keeps the destination transaction synchronous. The
 * transaction that creates a fork validates an executor lock and must not
 * suspend between that check and its commit, so everything it writes has to be
 * in hand before it opens.
 */

import type { DatabaseSync } from "node:sqlite";
import { parseDurableEvent, type DurableEvent } from "@executablemd/durable-streams";
import { isRootImportEvent, isRunRecordEvent } from "../fork.ts";
import { WorkflowRecordMalformedError, WorkflowRequestError } from "../storage/errors.ts";
import { describe } from "../storage/members.ts";
import { reading } from "./reading.ts";
import {
  bytes,
  integer,
  parseWorkspaceManifest,
  type StoredWorkspaceRoot,
} from "./workspace/manifest.ts";
import { loadWorkspaceRoot } from "./workspace/root.ts";

/** One retained journal row, exactly as the source stores it. */
export interface RetainedJournalRow {
  readonly eventId: string;
  readonly record: string;
  readonly workspaceRootId: string;
}

/** One DOFS manifest, as content the fork must hold for itself. */
export interface RetainedManifest {
  readonly hash: Uint8Array;
  readonly size: number;
  readonly encoded: Uint8Array;
  readonly lastSeen: number;
}

/** One DOFS blob and its bytes. */
export interface RetainedBlob {
  readonly hash: Uint8Array;
  readonly size: number;
  readonly lastSeen: number;
  readonly content: Uint8Array;
}

/** One retained Repository checkout, as the fork inherits it. */
export interface RetainedRepository {
  readonly name: string;
  readonly locator: string;
  readonly locatorFingerprint: string;
  readonly requestedBase: string | null;
  readonly creationCommit: string;
  readonly primaryBranch: string;
  readonly objectFormat: string;
  readonly checkoutPath: string;
}

/** One retained Worktree checkout, as the fork inherits it. */
export interface RetainedWorktree {
  readonly repositoryName: string;
  readonly name: string;
  readonly requestedBranch: string;
  readonly requestedBase: string | null;
  readonly creationCommit: string;
  readonly checkoutPath: string;
}

/** Everything one checkpoint hands a fork, read in one committed snapshot. */
export interface ForkSourceSnapshot {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
  /** The root the source's own `workflow_run` record was written against. */
  readonly runRecordWorkspaceRootId: string;
  /** The root the source's root import was written against, when the prefix holds one. */
  readonly rootImportWorkspaceRootId: string;
  /** The prefix without the two records the fork writes for itself. */
  readonly inherited: readonly RetainedJournalRow[];
  readonly roots: readonly StoredWorkspaceRoot[];
  readonly manifests: readonly RetainedManifest[];
  readonly blobs: readonly RetainedBlob[];
  readonly repositories: readonly RetainedRepository[];
  readonly worktrees: readonly RetainedWorktree[];
}

/**
 * Read the prefix `checkpointEventId` selects, and everything it depends on.
 *
 * The caller has already established that this checkpoint is forkable; what is
 * left is to take a consistent copy of it. A checkpoint this database does not
 * retain is refused here too, because the read that proves it is the same read
 * that would have copied it.
 */
export function readForkSource(
  database: DatabaseSync,
  path: string,
  sourceRunId: string,
  checkpointEventId: string,
): ForkSourceSnapshot {
  const rows = readRetainedRows(database);
  const at = rows.findIndex((row) => row.eventId === checkpointEventId);
  if (at === -1) {
    throw new WorkflowRequestError(
      `no retained event of workflow run ${JSON.stringify(sourceRunId)} is ` +
        `${JSON.stringify(checkpointEventId)}.`,
    );
  }

  const prefix = rows.slice(0, at + 1);
  const record = prefix.find((row) => isRunRecord(row));
  if (record === undefined) {
    throw new WorkflowRequestError(
      `workflow run ${JSON.stringify(sourceRunId)} records no run of its own before the ` +
        "selected checkpoint, so there is no history a fork could inherit.",
    );
  }
  // The fork writes both of these for itself: its identity, and the import of
  // the document it was given rather than the one the source was run from.
  const rootImport = prefix.find((row) => isRootImport(row));
  const inherited = prefix.filter((row) => row !== record && row !== rootImport);

  const checkpoint = prefix[at];
  if (checkpoint === undefined) {
    throw new WorkflowRequestError("the selected checkpoint is not a retained event");
  }

  const rootIds = new Set(prefix.map((row) => row.workspaceRootId));
  rootIds.add(checkpoint.workspaceRootId);
  const roots = [...rootIds].sort().map((rootId) => loadWorkspaceRoot(database, rootId, path));

  const manifestHashes = new Set(roots.flatMap((root) => root.manifestHashes));
  const blobHashes = new Set(roots.flatMap((root) => root.blobHashes));

  const checkoutPaths = directoryPaths(checkpoint.workspaceRootId, roots, path);

  return Object.freeze({
    sourceRunId,
    checkpointEventId,
    checkpointWorkspaceRootId: checkpoint.workspaceRootId,
    runRecordWorkspaceRootId: record.workspaceRootId,
    rootImportWorkspaceRootId: rootImport?.workspaceRootId ?? record.workspaceRootId,
    inherited: Object.freeze(inherited),
    roots: Object.freeze(roots),
    manifests: Object.freeze([...manifestHashes].map((hash) => readManifest(database, hash, path))),
    blobs: Object.freeze([...blobHashes].map((hash) => readBlob(database, hash, path))),
    repositories: Object.freeze(readRepositories(database, path, checkoutPaths)),
    worktrees: Object.freeze(readWorktrees(database, path, checkoutPaths)),
  });
}

/**
 * The directories the checkpoint's Workspace held.
 *
 * A checkout exists in the fork only when the root the fork starts from
 * contains its tree. Selecting by the manifest rather than by the retained
 * metadata is what keeps a Repository the source created *after* the checkpoint
 * from arriving in a fork whose Workspace has no such directory.
 */
function directoryPaths(
  checkpointRootId: string,
  roots: readonly StoredWorkspaceRoot[],
  path: string,
): ReadonlySet<string> {
  const checkpoint = roots.find((root) => root.rootId === checkpointRootId);
  if (checkpoint === undefined) {
    throw new WorkflowRequestError(
      "the selected checkpoint names a Workspace root it does not have",
    );
  }
  const parsed = parseWorkspaceManifest(checkpoint.manifest, path);
  const directories = new Set<string>();
  for (const entry of parsed.entries) {
    if (entry.kind === "directory") {
      directories.add(entry.path);
    }
  }
  return directories;
}

/**
 * Every retained journal row, in append order.
 *
 * A fork slices a prefix out of this; an export seals all of it. Both read the
 * rows the same way, because what makes a row well formed is not a property of
 * which of them is asking.
 */
export function readRetainedRows(database: DatabaseSync): RetainedJournalRow[] {
  const rows: RetainedJournalRow[] = [];
  for (const row of reading(
    database,
    "SELECT event_id, record, workspace_root_id FROM journal_events ORDER BY sequence ASC",
  ).all()) {
    const eventId = row["event_id"];
    const record = row["record"];
    const workspaceRootId = row["workspace_root_id"];
    if (typeof eventId !== "string" || eventId === "") {
      throw new WorkflowRecordMalformedError(
        "journal_events.event_id",
        `expected a non-empty identity, found ${describe(eventId)}`,
      );
    }
    if (typeof record !== "string") {
      throw new WorkflowRecordMalformedError(
        "journal_events.record",
        `expected text, found ${describe(record)}`,
      );
    }
    if (typeof workspaceRootId !== "string" || workspaceRootId === "") {
      throw new WorkflowRecordMalformedError(
        "journal_events.workspace_root_id",
        `expected a non-empty root identity, found ${describe(workspaceRootId)}`,
      );
    }
    rows.push(Object.freeze({ eventId, record, workspaceRootId }));
  }
  return rows;
}

function isRunRecord(row: RetainedJournalRow): boolean {
  return isRunRecordEvent(parsed(row));
}

function isRootImport(row: RetainedJournalRow): boolean {
  return isRootImportEvent(parsed(row));
}

function parsed(row: RetainedJournalRow): DurableEvent {
  const event = parseDurableEvent(row.record);
  if (!event.ok) {
    throw new WorkflowRecordMalformedError("journal_events.record", event.error.message);
  }
  return event.value;
}

function readManifest(database: DatabaseSync, hash: string, path: string): RetainedManifest {
  const row = reading(
    database,
    "SELECT hash, size, encoded, last_seen FROM vfs_manifests WHERE hex(hash) = upper(?)",
  ).get(hash);
  if (row === undefined) {
    throw new WorkflowRequestError(
      "the selected checkpoint names Workspace content this run no longer holds.",
    );
  }
  return Object.freeze({
    hash: bytes(row["hash"], path, "DOFS manifest identity"),
    size: integer(row["size"], path, "DOFS manifest size"),
    encoded: bytes(row["encoded"], path, "DOFS manifest content"),
    lastSeen: integer(row["last_seen"], path, "DOFS manifest watermark"),
  });
}

function readBlob(database: DatabaseSync, hash: string, path: string): RetainedBlob {
  const row = reading(
    database,
    `SELECT blob.hash AS hash, blob.size AS size, blob.last_seen AS last_seen,
            content.bytes AS bytes
       FROM vfs_blobs AS blob
       JOIN vfs_blob_bytes AS content ON content.hash = blob.hash
      WHERE hex(blob.hash) = upper(?)`,
  ).get(hash);
  if (row === undefined) {
    throw new WorkflowRequestError(
      "the selected checkpoint names Workspace content this run no longer holds.",
    );
  }
  return Object.freeze({
    hash: bytes(row["hash"], path, "DOFS blob identity"),
    size: integer(row["size"], path, "DOFS blob size"),
    lastSeen: integer(row["last_seen"], path, "DOFS blob watermark"),
    content: bytes(row["bytes"], path, "DOFS blob content"),
  });
}

export function readRepositories(
  database: DatabaseSync,
  path: string,
  checkouts?: ReadonlySet<string>,
): RetainedRepository[] {
  const repositories: RetainedRepository[] = [];
  for (const row of reading(database, "SELECT * FROM workspace_repositories ORDER BY name").all()) {
    const checkoutPath = text(row["checkout_path"], "workspace_repositories.checkout_path");
    // Absent selects every row. A fork takes only the checkouts its chosen root
    // still has a directory for; an export records what the run retains.
    if (checkouts !== undefined && !checkouts.has(checkoutPath)) {
      continue;
    }
    repositories.push(
      Object.freeze({
        name: text(row["name"], "workspace_repositories.name"),
        locator: text(row["locator"], "workspace_repositories.locator"),
        locatorFingerprint: text(
          row["locator_fingerprint"],
          "workspace_repositories.locator_fingerprint",
        ),
        requestedBase: optionalText(row["requested_base"], "workspace_repositories.requested_base"),
        creationCommit: text(row["creation_commit"], "workspace_repositories.creation_commit"),
        primaryBranch: text(row["primary_branch"], "workspace_repositories.primary_branch"),
        objectFormat: text(row["object_format"], "workspace_repositories.object_format"),
        checkoutPath,
      }),
    );
  }
  return repositories;
}

export function readWorktrees(
  database: DatabaseSync,
  path: string,
  checkouts?: ReadonlySet<string>,
): RetainedWorktree[] {
  const worktrees: RetainedWorktree[] = [];
  for (const row of reading(
    database,
    "SELECT * FROM workspace_worktrees ORDER BY repository_name, name",
  ).all()) {
    const checkoutPath = text(row["checkout_path"], "workspace_worktrees.checkout_path");
    if (checkouts !== undefined && !checkouts.has(checkoutPath)) {
      continue;
    }
    worktrees.push(
      Object.freeze({
        repositoryName: text(row["repository_name"], "workspace_worktrees.repository_name"),
        name: text(row["name"], "workspace_worktrees.name"),
        requestedBranch: text(row["requested_branch"], "workspace_worktrees.requested_branch"),
        requestedBase: optionalText(row["requested_base"], "workspace_worktrees.requested_base"),
        creationCommit: text(row["creation_commit"], "workspace_worktrees.creation_commit"),
        checkoutPath,
      }),
    );
  }
  return worktrees;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new WorkflowRecordMalformedError(label, `expected text, found ${describe(value)}`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return text(value, label);
}
