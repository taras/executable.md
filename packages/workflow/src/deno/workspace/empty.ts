import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WorkflowDatabaseCorruptError } from "../../storage/errors.ts";

export const WORKSPACE_ROOT_FORMAT = 1;
export const EMPTY_WORKSPACE_MANIFEST =
  '{"format":1,"entries":[{"path":"/","kind":"directory","mode":493,"mtime":0}]}';

const ROOT_DOMAIN = "xmd-workspace-root\0v1\0";

export const EMPTY_WORKSPACE_ROOT_ID = workspaceRootId(EMPTY_WORKSPACE_MANIFEST);

export function workspaceRootId(manifest: string): string {
  const hash = createHash("sha256");
  hash.update(ROOT_DOMAIN, "utf8");
  hash.update(manifest, "utf8");
  return hash.digest("hex");
}

export function initializeEmptyWorkspace(database: DatabaseSync): void {
  database
    .prepare("INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, ?, ?)")
    .run(EMPTY_WORKSPACE_ROOT_ID, WORKSPACE_ROOT_FORMAT, EMPTY_WORKSPACE_MANIFEST);
  database
    .prepare("INSERT INTO workspace_state (singleton_id, current_root_id) VALUES (1, ?)")
    .run(EMPTY_WORKSPACE_ROOT_ID);
}

export function verifyEmptyWorkspace(database: DatabaseSync, path: string): void {
  const state = database.prepare("SELECT singleton_id, current_root_id FROM workspace_state").all();
  if (
    state.length !== 1 ||
    number(state[0]?.["singleton_id"]) !== 1 ||
    state[0]?.["current_root_id"] !== EMPTY_WORKSPACE_ROOT_ID
  ) {
    corrupt(path, "it does not hold the canonical empty Workspace current-root pointer");
  }

  const roots = database
    .prepare("SELECT root_id, format_version, manifest FROM workspace_roots")
    .all();
  if (
    roots.length !== 1 ||
    roots[0]?.["root_id"] !== EMPTY_WORKSPACE_ROOT_ID ||
    number(roots[0]?.["format_version"]) !== WORKSPACE_ROOT_FORMAT ||
    roots[0]?.["manifest"] !== EMPTY_WORKSPACE_MANIFEST ||
    workspaceRootId(String(roots[0]?.["manifest"])) !== EMPTY_WORKSPACE_ROOT_ID
  ) {
    corrupt(path, "its retained Workspace root is not the canonical empty root");
  }

  requireCount(database, "workspace_root_manifest_refs", 0, path);
  requireCount(database, "workspace_root_blob_refs", 0, path);
  requireCount(database, "vfs_dirents", 0, path);
  requireCount(database, "vfs_chunks", 0, path);
  requireCount(database, "vfs_blobs", 0, path);
  requireCount(database, "vfs_blob_bytes", 0, path);
  requireCount(database, "vfs_manifests", 0, path);
  requireCount(database, "vfs_changes", 0, path);
  requireCount(database, "_vfs_mounts", 0, path);

  const nodes = database
    .prepare(
      `SELECT inode, type, mode, mtime, rev, mount_root, stub_size,
              manifest_hash, link_target, size
       FROM vfs_nodes`,
    )
    .all();
  const root = nodes[0];
  if (
    nodes.length !== 1 ||
    number(root?.["inode"]) !== 1 ||
    root?.["type"] !== "dir" ||
    number(root?.["mode"]) !== 0o755 ||
    number(root?.["mtime"]) !== 0 ||
    number(root?.["rev"]) !== 0 ||
    root?.["mount_root"] !== null ||
    root?.["stub_size"] !== null ||
    root?.["manifest_hash"] !== null ||
    root?.["link_target"] !== null ||
    number(root?.["size"]) !== 0
  ) {
    corrupt(path, "its live Workspace frontier is not the canonical empty root filesystem");
  }

  const metadata = database.prepare("SELECT k, v FROM vfs_meta ORDER BY k").all();
  if (
    metadata.length !== 2 ||
    metadata[0]?.["k"] !== "rev" ||
    number(metadata[0]?.["v"]) !== 1 ||
    metadata[1]?.["k"] !== "schema_version" ||
    number(metadata[1]?.["v"]) !== 5
  ) {
    corrupt(path, "its Workspace filesystem metadata is not the pinned empty version-5 state");
  }

  const watermarks = database.prepare("SELECT k, backend, v FROM _vfs_watermark ORDER BY k").all();
  if (
    watermarks.length !== 2 ||
    watermarks[0]?.["k"] !== "fetchRev" ||
    watermarks[0]?.["backend"] !== "default" ||
    number(watermarks[0]?.["v"]) !== 0 ||
    watermarks[1]?.["k"] !== "pushRev" ||
    watermarks[1]?.["backend"] !== "default" ||
    number(watermarks[1]?.["v"]) !== 0
  ) {
    corrupt(path, "its Workspace synchronization watermarks are malformed");
  }

  const cursors = database.prepare("SELECT k, backend, path FROM _vfs_fetch_cursor").all();
  if (
    cursors.length !== 1 ||
    cursors[0]?.["k"] !== "fetch" ||
    cursors[0]?.["backend"] !== "default" ||
    cursors[0]?.["path"] !== null
  ) {
    corrupt(path, "its Workspace synchronization cursor is malformed");
  }

  const foreignJournalRoots = database
    .prepare("SELECT COUNT(*) AS count FROM journal_events WHERE workspace_root_id <> ?")
    .get(EMPTY_WORKSPACE_ROOT_ID);
  if (number(foreignJournalRoots?.["count"]) !== 0) {
    corrupt(path, "a journal event does not reference the current retained Workspace root");
  }
}

function requireCount(database: DatabaseSync, table: string, expected: number, path: string): void {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  if (number(row?.["count"]) !== expected) {
    corrupt(path, `its ${table} rows do not describe the canonical empty Workspace`);
  }
}

function number(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function corrupt(path: string, reason: string): never {
  throw new WorkflowDatabaseCorruptError(path, reason);
}
