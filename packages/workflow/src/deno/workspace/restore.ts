import type { DatabaseSync } from "node:sqlite";
import { WorkflowTransactionError } from "../../storage/errors.ts";
import type { RunConnection } from "../connections.ts";
import { reading } from "../reading.ts";
import {
  corrupt,
  fromHex,
  integer,
  parentFirst,
  parentPath,
  parseWorkspaceManifest,
  type StoredWorkspaceRoot,
  type WorkspaceRootEntry,
} from "./manifest.ts";
import {
  loadWorkspaceRoot,
  readDofsManifest,
  setCurrentWorkspaceRoot,
  snapshotWorkspace,
  verifyWorkspace,
} from "./root.ts";

export interface RestoreWorkspaceRootOptions {
  readonly publish?: boolean;
}

export function restoreWorkspaceRoot(
  connection: RunConnection,
  rootId: string,
  options: RestoreWorkspaceRootOptions = {},
): StoredWorkspaceRoot {
  if (!connection.transactionOpen) {
    throw new WorkflowTransactionError(
      "restoring a Workspace root requires the caller-owned workflow transaction to be open.",
    );
  }

  const { database, dofs, path, savepoints } = connection;
  verifyWorkspace(database, dofs, path);
  const selected = loadWorkspaceRoot(database, rootId, path);
  connection.invalidateDofsCaches();
  try {
    return savepoints.synchronous(() => {
      rebuild(database, selected, path);
      connection.invalidateDofsCaches();
      const restored = snapshotWorkspace(database, dofs, path, false);
      if (
        restored.rootId !== selected.rootId ||
        restored.manifest !== selected.manifest ||
        !equalStrings(restored.manifestHashes, selected.manifestHashes) ||
        !equalStrings(restored.blobHashes, selected.blobHashes)
      ) {
        corrupt(path, "a retained Workspace root did not materialize to its own identity");
      }
      if (options.publish === true) {
        setCurrentWorkspaceRoot(database, selected.rootId, path);
      }
      return selected;
    });
  } finally {
    connection.invalidateDofsCaches();
  }
}

function rebuild(database: DatabaseSync, root: StoredWorkspaceRoot, databasePath: string): void {
  const parsed = parseWorkspaceManifest(root.manifest, databasePath);
  const rootEntry = parsed.entries[0];
  if (rootEntry === undefined || rootEntry.kind !== "directory" || rootEntry.path !== "/") {
    corrupt(databasePath, "a retained Workspace root has no root directory");
  }

  database.exec("DELETE FROM vfs_dirents");
  database.exec("DELETE FROM vfs_chunks");
  database.exec("DELETE FROM vfs_changes");
  database.exec("DELETE FROM vfs_nodes");

  const revision = nextRevision(database, databasePath);
  database
    .prepare(
      `INSERT INTO vfs_nodes
        (inode, type, mode, mtime, rev, mount_root, stub_size, manifest_hash, link_target, size)
       VALUES (1, 'dir', ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
    )
    .run(rootEntry.mode, rootEntry.mtime, revision);

  const inodes = new Map<string, number>([["/", 1]]);
  const hardlinks = new Map<string, number>();
  const entries = parsed.entries.slice(1).sort(parentFirst);
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    const parentInode = inodes.get(parent);
    if (parentInode === undefined) {
      corrupt(databasePath, "a retained Workspace root names a child without a parent");
    }
    const name = entry.path.slice(parent === "/" ? 1 : parent.length + 1);
    const inode = materializeNode(database, entry, revision, hardlinks, databasePath);
    database
      .prepare("INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)")
      .run(parentInode, name, inode);
    inodes.set(entry.path, inode);
  }
}

function materializeNode(
  database: DatabaseSync,
  entry: WorkspaceRootEntry,
  revision: number,
  hardlinks: Map<string, number>,
  databasePath: string,
): number {
  if (entry.kind === "file" && entry.hardlink !== null) {
    const existing = hardlinks.get(entry.hardlink);
    if (existing !== undefined) {
      return existing;
    }
  }

  let inode: number;
  if (entry.kind === "directory") {
    const result = database
      .prepare(
        `INSERT INTO vfs_nodes
          (type, mode, mtime, rev, mount_root, stub_size, manifest_hash, link_target, size)
         VALUES ('dir', ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
      )
      .run(entry.mode, entry.mtime, revision);
    inode = Number(result.lastInsertRowid);
  } else if (entry.kind === "symlink") {
    const result = database
      .prepare(
        `INSERT INTO vfs_nodes
          (type, mode, mtime, rev, mount_root, stub_size, manifest_hash, link_target, size)
         VALUES ('symlink', ?, ?, ?, NULL, NULL, NULL, ?, 0)`,
      )
      .run(entry.mode, entry.mtime, revision, entry.target);
    inode = Number(result.lastInsertRowid);
  } else {
    const manifest = readDofsManifest(database, entry.manifest, databasePath);
    if (manifest.size !== entry.size) {
      corrupt(databasePath, "a retained file size differs from its DOFS manifest");
    }
    const result = database
      .prepare(
        `INSERT INTO vfs_nodes
          (type, mode, mtime, rev, mount_root, stub_size, manifest_hash, link_target, size)
         VALUES ('file', ?, ?, ?, NULL, NULL, ?, NULL, ?)`,
      )
      .run(
        entry.mode,
        entry.mtime,
        revision,
        fromHex(entry.manifest, databasePath, "DOFS manifest identity"),
        entry.size,
      );
    inode = Number(result.lastInsertRowid);
    for (const [index, chunk] of manifest.chunks.entries()) {
      database
        .prepare("INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)")
        .run(inode, index, fromHex(chunk.hash, databasePath, "DOFS blob identity"), chunk.size);
    }
  }

  if (!Number.isSafeInteger(inode) || inode < 1) {
    corrupt(databasePath, "restoration did not allocate a valid Workspace inode");
  }
  if (entry.kind === "file" && entry.hardlink !== null) {
    hardlinks.set(entry.hardlink, inode);
  }
  return inode;
}

function nextRevision(database: DatabaseSync, databasePath: string): number {
  const row = reading(database, "UPDATE vfs_meta SET v = v + 1 WHERE k = 'rev' RETURNING v").get();
  const revision = integer(row?.["v"], databasePath, "Workspace revision");
  if (revision < 1) {
    corrupt(databasePath, "restoration did not establish a valid Workspace revision");
  }
  return revision;
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
