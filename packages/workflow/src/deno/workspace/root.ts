import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Database as CloudflareDatabase } from "../../../vendor/cloudflare-computer-dofs/generated/storage.js";
import { buildManifest } from "../../../vendor/cloudflare-computer-dofs/generated/sync/manifests.js";
import { WorkflowDatabaseCorruptError } from "../../storage/errors.ts";
import type { SavepointManager } from "../savepoints.ts";

export const WORKSPACE_ROOT_FORMAT = 1;
const DOMAIN = new TextEncoder().encode("xmd-workspace-root\0v1\0");
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/;

const directoryEntrySchema = z.object({
  path: z.string(),
  kind: z.literal("directory"),
  mode: z.number().int().min(0).max(0o7777),
  mtime: z.number().int().safe(),
});
const fileEntrySchema = z.object({
  path: z.string(),
  kind: z.literal("file"),
  mode: z.number().int().min(0).max(0o7777),
  mtime: z.number().int().safe(),
  size: z.number().int().safe().nonnegative(),
  manifest: z.string().regex(SHA256),
  hardlink: z
    .string()
    .regex(/^h[0-9]+$/)
    .nullable(),
});
const symlinkEntrySchema = z.object({
  path: z.string(),
  kind: z.literal("symlink"),
  mode: z.number().int().min(0).max(0o7777),
  mtime: z.number().int().safe(),
  target: z.string(),
});
const rootManifestSchema = z.object({
  format: z.literal(WORKSPACE_ROOT_FORMAT),
  entries: z.array(
    z.discriminatedUnion("kind", [directoryEntrySchema, fileEntrySchema, symlinkEntrySchema]),
  ),
});
const dofsManifestSchema = z.object({
  version: z.literal(1),
  chunks: z.array(
    z.object({ hash: z.string().regex(SHA256), size: z.number().int().safe().positive() }),
  ),
});

export type WorkspaceRootEntry = z.infer<typeof rootManifestSchema>["entries"][number];
export type WorkspaceRootManifest = z.infer<typeof rootManifestSchema>;

export interface StoredWorkspaceRoot {
  readonly rootId: string;
  readonly manifest: string;
  readonly manifestHashes: readonly string[];
  readonly blobHashes: readonly string[];
}

interface NodeRow {
  readonly inode: number;
  readonly type: "file" | "dir" | "symlink";
  readonly mode: number;
  readonly mtime: number;
  readonly manifestHash: Uint8Array | null;
  readonly linkTarget: string | null;
  readonly size: number;
}

interface Chunk {
  readonly hash: Uint8Array;
  readonly size: number;
}

export function emptyWorkspaceRoot(): StoredWorkspaceRoot {
  return workspaceRoot(
    '{"format":1,"entries":[{"path":"/","kind":"directory","mode":493,"mtime":0}]}',
    [],
    [],
  );
}

export function workspaceRoot(
  manifest: string,
  manifestHashes: readonly string[],
  blobHashes: readonly string[],
): StoredWorkspaceRoot {
  const bytes = encoder.encode(manifest);
  const hash = createHash("sha256");
  hash.update(DOMAIN);
  hash.update(bytes);
  return Object.freeze({
    rootId: hash.digest("hex"),
    manifest,
    manifestHashes: Object.freeze([...manifestHashes]),
    blobHashes: Object.freeze([...blobHashes]),
  });
}

export function snapshotWorkspace(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  path: string,
  repairMissingManifest: boolean,
): StoredWorkspaceRoot {
  const entries: Array<{ entry: WorkspaceRootEntry; inode: number }> = [];
  const visiting = new Set<number>();
  const reachable = new Set<number>();
  const filePaths = new Map<number, string[]>();
  const manifestHashes = new Set<string>();
  const blobHashes = new Set<string>();

  function visit(inode: number, canonicalPath: string): void {
    const node = readNode(database, inode, path);
    if (node.type === "dir") {
      if (visiting.has(inode) || reachable.has(inode)) {
        corrupt(path, "its live Workspace contains a directory cycle or directory hardlink");
      }
      visiting.add(inode);
      reachable.add(inode);
      entries.push({
        inode,
        entry: { path: canonicalPath, kind: "directory", mode: node.mode, mtime: node.mtime },
      });
      for (const child of readDirents(database, inode, path)) {
        validateName(child.name, path);
        const childPath =
          canonicalPath === "/" ? `/${child.name}` : `${canonicalPath}/${child.name}`;
        visit(child.inode, childPath);
      }
      visiting.delete(inode);
      return;
    }

    reachable.add(inode);
    if (node.type === "symlink") {
      const target = node.linkTarget;
      if (target === null || target.includes("\0") || hasUnpairedSurrogate(target)) {
        corrupt(path, "its live Workspace contains an invalid symbolic-link target");
      }
      entries.push({
        inode,
        entry: {
          path: canonicalPath,
          kind: "symlink",
          mode: node.mode,
          mtime: node.mtime,
          target,
        },
      });
      return;
    }

    const paths = filePaths.get(inode) ?? [];
    paths.push(canonicalPath);
    filePaths.set(inode, paths);
    const content = validateFile(database, dofs, node, path, repairMissingManifest);
    manifestHashes.add(content.manifest);
    for (const hash of content.blobs) {
      blobHashes.add(hash);
    }
    entries.push({
      inode,
      entry: {
        path: canonicalPath,
        kind: "file",
        mode: node.mode,
        mtime: node.mtime,
        size: node.size,
        manifest: content.manifest,
        hardlink: null,
      },
    });
  }

  visit(1, "/");
  if (count(database, "vfs_nodes") !== reachable.size) {
    corrupt(path, "its live Workspace contains unreachable filesystem nodes");
  }
  if (count(database, "vfs_dirents") !== entries.length - 1) {
    corrupt(path, "its live Workspace contains unreachable directory entries");
  }

  entries.sort((left, right) => compareUtf8(left.entry.path, right.entry.path));
  let hardlink = 0;
  const groups = [...filePaths.values()]
    .filter((paths) => paths.length > 1)
    .map((paths) => [...paths].sort(compareUtf8))
    .sort((left, right) => compareUtf8(left[0] ?? "", right[0] ?? ""));
  for (const paths of groups) {
    const group = `h${hardlink}`;
    hardlink += 1;
    for (const item of entries) {
      if (item.entry.kind === "file" && paths.includes(item.entry.path)) {
        item.entry.hardlink = group;
      }
    }
  }

  const logical = entries.map((item) => item.entry);
  validateEntryOrder(logical, path);
  const manifest = JSON.stringify({ format: WORKSPACE_ROOT_FORMAT, entries: logical });
  return workspaceRoot(manifest, [...manifestHashes].sort(), [...blobHashes].sort());
}

export function retainWorkspaceRoot(
  database: DatabaseSync,
  root: StoredWorkspaceRoot,
  path: string,
): void {
  const existing = database
    .prepare("SELECT manifest FROM workspace_roots WHERE root_id = ?")
    .get(root.rootId);
  if (existing === undefined) {
    database
      .prepare("INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, 1, ?)")
      .run(root.rootId, root.manifest);
    for (const hash of root.manifestHashes) {
      database
        .prepare("INSERT INTO workspace_root_manifest_refs (root_id, manifest_hash) VALUES (?, ?)")
        .run(root.rootId, fromHex(hash));
    }
    for (const hash of root.blobHashes) {
      database
        .prepare("INSERT INTO workspace_root_blob_refs (root_id, blob_hash) VALUES (?, ?)")
        .run(root.rootId, fromHex(hash));
    }
    return;
  }
  if (existing["manifest"] !== root.manifest) {
    corrupt(path, "a retained Workspace root identity has different stored bytes");
  }
  requireReferenceSet(
    database,
    root.rootId,
    "workspace_root_manifest_refs",
    "manifest_hash",
    root.manifestHashes,
    path,
  );
  requireReferenceSet(
    database,
    root.rootId,
    "workspace_root_blob_refs",
    "blob_hash",
    root.blobHashes,
    path,
  );
}

export function setCurrentWorkspaceRoot(
  database: DatabaseSync,
  rootId: string,
  path: string,
): void {
  const changed = database
    .prepare("UPDATE workspace_state SET current_root_id = ? WHERE singleton_id = 1")
    .run(rootId);
  if (changed.changes !== 1) {
    corrupt(path, "its Workspace current-root pointer is missing");
  }
}

export function currentWorkspaceRoot(database: DatabaseSync, path: string): string {
  const row = database
    .prepare("SELECT current_root_id FROM workspace_state WHERE singleton_id = 1")
    .get();
  const value = row?.["current_root_id"];
  if (typeof value !== "string" || !SHA256.test(value)) {
    corrupt(path, "its Workspace current-root pointer is malformed");
  }
  return value;
}

export function verifyWorkspace(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  path: string,
): void {
  const stateCount = count(database, "workspace_state");
  if (stateCount !== 1) {
    corrupt(path, "it does not hold exactly one Workspace current-root pointer");
  }
  for (const row of database
    .prepare("SELECT root_id, format_version, manifest FROM workspace_roots")
    .all()) {
    const root = parseStoredRoot(database, row, path);
    requireReferenceSet(
      database,
      root.rootId,
      "workspace_root_manifest_refs",
      "manifest_hash",
      root.manifestHashes,
      path,
    );
    requireReferenceSet(
      database,
      root.rootId,
      "workspace_root_blob_refs",
      "blob_hash",
      root.blobHashes,
      path,
    );
    validateRetainedContent(database, root, path);
  }
  const current = currentWorkspaceRoot(database, path);
  const live = snapshotWorkspace(database, dofs, path, false);
  if (live.rootId !== current) {
    corrupt(path, "its live Workspace frontier does not equal its current root");
  }
}

export function materializeWorkspaceRoot(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  savepoints: SavepointManager,
  path: string,
  rootId: string,
): void {
  savepoints.synchronous(() => {
    const row = database
      .prepare("SELECT root_id, format_version, manifest FROM workspace_roots WHERE root_id = ?")
      .get(rootId);
    if (row === undefined) {
      throw new Error(`no retained Workspace root exists under ${rootId}`);
    }
    const root = parseStoredRoot(database, row, path);
    validateRetainedContent(database, root, path);
    rebuild(database, root, path);
    const restored = snapshotWorkspace(database, dofs, path, false);
    if (restored.rootId !== root.rootId) {
      corrupt(path, "a retained Workspace root did not materialize to its own identity");
    }
    setCurrentWorkspaceRoot(database, root.rootId, path);
  });
}

function rebuild(database: DatabaseSync, root: StoredWorkspaceRoot, path: string): void {
  const parsed = parseManifest(root.manifest, path);
  database.exec("DELETE FROM vfs_dirents");
  database.exec("DELETE FROM vfs_chunks");
  database.exec("DELETE FROM vfs_changes");
  database.exec("DELETE FROM vfs_nodes");

  const currentRev = scalarInteger(database, "SELECT v FROM vfs_meta WHERE k = 'rev'", path);
  const rev = currentRev + 1;
  database.prepare("UPDATE vfs_meta SET v = ? WHERE k = 'rev'").run(rev);
  const rootEntry = parsed.entries[0];
  if (rootEntry === undefined || rootEntry.kind !== "directory" || rootEntry.path !== "/") {
    corrupt(path, "a retained Workspace root has no root directory");
  }
  database
    .prepare(
      "INSERT INTO vfs_nodes (inode, type, mode, mtime, rev, size) VALUES (1, 'dir', ?, ?, ?, 0)",
    )
    .run(rootEntry.mode, rootEntry.mtime, rev);

  const inodes = new Map<string, number>([["/", 1]]);
  const hardlinks = new Map<string, number>();
  for (const entry of parsed.entries.slice(1).sort(parentFirst)) {
    const parent = parentPath(entry.path);
    const parentInode = inodes.get(parent);
    if (parentInode === undefined) {
      corrupt(path, "a retained Workspace root names a child before a valid parent");
    }
    const name = entry.path.slice(parent === "/" ? 1 : parent.length + 1);
    let inode: number;
    if (entry.kind === "file" && entry.hardlink !== null && hardlinks.has(entry.hardlink)) {
      const linked = hardlinks.get(entry.hardlink);
      if (linked === undefined) {
        corrupt(path, "a retained Workspace root has an invalid hardlink group");
      }
      inode = linked;
    } else {
      inode = insertNode(database, entry, rev, path);
      if (entry.kind === "file" && entry.hardlink !== null) {
        hardlinks.set(entry.hardlink, inode);
      }
    }
    database
      .prepare("INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)")
      .run(parentInode, name, inode);
    inodes.set(entry.path, inode);
  }
}

function insertNode(
  database: DatabaseSync,
  entry: WorkspaceRootEntry,
  rev: number,
  path: string,
): number {
  if (entry.kind === "directory") {
    const result = database
      .prepare("INSERT INTO vfs_nodes (type, mode, mtime, rev, size) VALUES ('dir', ?, ?, ?, 0)")
      .run(entry.mode, entry.mtime, rev);
    return Number(result.lastInsertRowid);
  }
  if (entry.kind === "symlink") {
    const result = database
      .prepare(
        "INSERT INTO vfs_nodes (type, mode, mtime, rev, link_target, size) VALUES ('symlink', ?, ?, ?, ?, 0)",
      )
      .run(entry.mode, entry.mtime, rev, entry.target);
    return Number(result.lastInsertRowid);
  }
  const manifest = readDofsManifest(database, entry.manifest, path);
  const result = database
    .prepare(
      "INSERT INTO vfs_nodes (type, mode, mtime, rev, manifest_hash, size) VALUES ('file', ?, ?, ?, ?, ?)",
    )
    .run(entry.mode, entry.mtime, rev, fromHex(entry.manifest), entry.size);
  const inode = Number(result.lastInsertRowid);
  for (const [index, chunk] of manifest.chunks.entries()) {
    database
      .prepare("INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)")
      .run(inode, index, fromHex(chunk.hash), chunk.size);
  }
  return inode;
}

function parseStoredRoot(
  database: DatabaseSync,
  row: Record<string, unknown>,
  path: string,
): StoredWorkspaceRoot {
  const rootId = row["root_id"];
  const format = integer(row["format_version"], path, "Workspace root format");
  const manifest = row["manifest"];
  if (
    typeof rootId !== "string" ||
    !SHA256.test(rootId) ||
    format !== WORKSPACE_ROOT_FORMAT ||
    typeof manifest !== "string"
  ) {
    corrupt(path, "one of its retained Workspace roots is malformed");
  }
  const parsed = parseManifest(manifest, path);
  const canonical = JSON.stringify(parsed);
  if (canonical !== manifest) {
    corrupt(path, "one of its retained Workspace roots is not canonically encoded");
  }
  const manifests = new Set<string>();
  for (const entry of parsed.entries) {
    if (entry.kind === "file") {
      manifests.add(entry.manifest);
    }
  }
  const blobs = new Set<string>();
  for (const hash of manifests) {
    for (const chunk of readDofsManifest(database, hash, path).chunks) {
      blobs.add(chunk.hash);
    }
  }
  const root = workspaceRoot(manifest, [...manifests].sort(), [...blobs].sort());
  if (root.rootId !== rootId) {
    corrupt(path, "one of its retained Workspace root identities does not match its bytes");
  }
  return root;
}

function parseManifest(manifest: string, path: string): WorkspaceRootManifest {
  let offered: unknown;
  try {
    offered = JSON.parse(manifest);
  } catch {
    corrupt(path, "one of its retained Workspace roots is not JSON");
  }
  const parsed = rootManifestSchema.safeParse(offered);
  if (!parsed.success) {
    corrupt(path, "one of its retained Workspace roots has an invalid manifest");
  }
  validateEntryOrder(parsed.data.entries, path);
  return parsed.data;
}

function validateEntryOrder(entries: WorkspaceRootEntry[], path: string): void {
  if (entries.length === 0 || entries[0]?.path !== "/" || entries[0]?.kind !== "directory") {
    corrupt(path, "a Workspace root does not begin with its root directory");
  }
  let previous: string | undefined;
  const hardlinks = new Map<string, number>();
  const hardlinkEntries = new Map<string, WorkspaceRootEntry & { kind: "file" }>();
  const directories = new Set<string>();
  let nextHardlink = 0;
  for (const entry of entries) {
    validateCanonicalPath(entry.path, path);
    if (previous !== undefined && compareUtf8(previous, entry.path) >= 0) {
      corrupt(path, "a Workspace root's paths are duplicated or out of canonical order");
    }
    previous = entry.path;
    if (entry.path !== "/" && !directories.has(parentPath(entry.path))) {
      corrupt(path, "a Workspace root contains an entry without a retained parent directory");
    }
    if (entry.kind === "directory") {
      directories.add(entry.path);
    }
    if (
      entry.kind === "symlink" &&
      (entry.target.includes("\0") || hasUnpairedSurrogate(entry.target))
    ) {
      corrupt(path, "a Workspace root contains an invalid symbolic-link target");
    }
    if (entry.kind === "file" && entry.hardlink !== null) {
      const first = hardlinkEntries.get(entry.hardlink);
      if (first === undefined) {
        if (entry.hardlink !== `h${nextHardlink}`) {
          corrupt(path, "a Workspace root's hardlink groups are not canonically numbered");
        }
        nextHardlink += 1;
        hardlinkEntries.set(entry.hardlink, entry);
      } else if (
        first.mode !== entry.mode ||
        first.mtime !== entry.mtime ||
        first.size !== entry.size ||
        first.manifest !== entry.manifest
      ) {
        corrupt(path, "a Workspace root's hardlink group describes different inode properties");
      }
      hardlinks.set(entry.hardlink, (hardlinks.get(entry.hardlink) ?? 0) + 1);
    }
  }
  for (const count of hardlinks.values()) {
    if (count < 2) {
      corrupt(path, "a Workspace root contains a one-member hardlink group");
    }
  }
}

function validateFile(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  node: NodeRow,
  path: string,
  repair: boolean,
): { manifest: string; blobs: string[] } {
  const chunks = readChunks(database, node.inode, path);
  const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (total !== node.size) {
    corrupt(path, "a Workspace file size does not equal its ordered chunks");
  }
  const blobs = chunks.map((chunk) => validateBlob(database, chunk, path));
  let manifestHash = node.manifestHash;
  if (manifestHash === null) {
    if (!repair) {
      corrupt(path, "a Workspace file has no retained DOFS manifest");
    }
    manifestHash = buildManifest(dofs, chunks, 0);
    database
      .prepare("UPDATE vfs_nodes SET manifest_hash = ? WHERE inode = ?")
      .run(manifestHash, node.inode);
  }
  const manifest = toHex(manifestHash);
  const encoded = readDofsManifest(database, manifest, path);
  if (
    encoded.size !== node.size ||
    JSON.stringify(encoded.chunks) !==
      JSON.stringify(chunks.map((chunk) => ({ hash: toHex(chunk.hash), size: chunk.size })))
  ) {
    corrupt(path, "a Workspace file's DOFS manifest does not equal its chunks");
  }
  return { manifest, blobs };
}

function readDofsManifest(
  database: DatabaseSync,
  hash: string,
  path: string,
): { size: number; chunks: Array<{ hash: string; size: number }> } {
  const row = database
    .prepare("SELECT size, encoded FROM vfs_manifests WHERE hash = ?")
    .get(fromHex(hash));
  if (row === undefined) {
    corrupt(path, "a retained Workspace root names a missing DOFS manifest");
  }
  const size = integer(row["size"], path, "DOFS manifest size");
  const encoded = bytes(row["encoded"], path, "DOFS manifest encoding");
  if (toHex(sha256(encoded)) !== hash) {
    corrupt(path, "a DOFS manifest hash does not match its bytes");
  }
  let offered: unknown;
  try {
    offered = JSON.parse(decoder.decode(encoded));
  } catch {
    corrupt(path, "a DOFS manifest is not canonical UTF-8 JSON");
  }
  const parsed = dofsManifestSchema.safeParse(offered);
  if (!parsed.success || JSON.stringify(parsed.data) !== decoder.decode(encoded)) {
    corrupt(path, "a DOFS manifest is not canonically encoded");
  }
  const total = parsed.data.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (total !== size) {
    corrupt(path, "a DOFS manifest size does not equal its chunks");
  }
  return { size, chunks: parsed.data.chunks };
}

function validateRetainedContent(
  database: DatabaseSync,
  root: StoredWorkspaceRoot,
  path: string,
): void {
  for (const manifest of root.manifestHashes) {
    const parsed = readDofsManifest(database, manifest, path);
    for (const chunk of parsed.chunks) {
      validateBlob(database, { hash: fromHex(chunk.hash), size: chunk.size }, path);
    }
  }
}

function validateBlob(database: DatabaseSync, chunk: Chunk, path: string): string {
  const hash = toHex(chunk.hash);
  const row = database
    .prepare(
      "SELECT b.size, x.bytes FROM vfs_blobs b JOIN vfs_blob_bytes x ON x.hash = b.hash WHERE b.hash = ?",
    )
    .get(chunk.hash);
  if (row === undefined) {
    corrupt(path, "a Workspace file names missing DOFS blob bytes");
  }
  const size = integer(row["size"], path, "DOFS blob size");
  const content = bytes(row["bytes"], path, "DOFS blob bytes");
  if (size !== chunk.size || content.byteLength !== chunk.size || toHex(sha256(content)) !== hash) {
    corrupt(path, "a DOFS blob's hash or size does not match its bytes");
  }
  return hash;
}

function readNode(database: DatabaseSync, inode: number, path: string): NodeRow {
  const row = database
    .prepare(
      "SELECT inode, type, mode, mtime, manifest_hash, link_target, size FROM vfs_nodes WHERE inode = ?",
    )
    .get(inode);
  if (row === undefined) {
    corrupt(path, "its live Workspace contains a dangling directory entry");
  }
  const type = row["type"];
  if (type !== "file" && type !== "dir" && type !== "symlink") {
    corrupt(path, "its live Workspace contains an unknown node type");
  }
  const manifest = row["manifest_hash"];
  if (manifest !== null && !(manifest instanceof Uint8Array)) {
    corrupt(path, "its live Workspace contains an invalid manifest hash");
  }
  const target = row["link_target"];
  if (target !== null && typeof target !== "string") {
    corrupt(path, "its live Workspace contains an invalid link target");
  }
  const result: NodeRow = {
    inode: integer(row["inode"], path, "Workspace inode"),
    type,
    mode: mode(row["mode"], path),
    mtime: integer(row["mtime"], path, "Workspace mtime"),
    manifestHash: manifest,
    linkTarget: target,
    size: nonnegative(row["size"], path, "Workspace size"),
  };
  if (
    result.type === "dir" &&
    (result.manifestHash !== null || result.linkTarget !== null || result.size !== 0)
  ) {
    corrupt(path, "a Workspace directory carries file or symbolic-link metadata");
  }
  if (
    result.type === "symlink" &&
    (result.manifestHash !== null || result.linkTarget === null || result.size !== 0)
  ) {
    corrupt(path, "a Workspace symbolic link carries inconsistent metadata");
  }
  if (result.type === "file" && result.linkTarget !== null) {
    corrupt(path, "a Workspace file carries a symbolic-link target");
  }
  return result;
}

function readDirents(
  database: DatabaseSync,
  inode: number,
  path: string,
): Array<{ name: string; inode: number }> {
  const entries: Array<{ name: string; inode: number }> = [];
  for (const row of database
    .prepare("SELECT name, child_inode FROM vfs_dirents WHERE parent_inode = ?")
    .all(inode)) {
    const name = row["name"];
    if (typeof name !== "string") {
      corrupt(path, "its live Workspace contains an invalid directory-entry name");
    }
    entries.push({ name, inode: integer(row["child_inode"], path, "Workspace child inode") });
  }
  return entries.sort((left, right) => compareUtf8(left.name, right.name));
}

function readChunks(database: DatabaseSync, inode: number, path: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const [expected, row] of database
    .prepare("SELECT idx, hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx")
    .all(inode)
    .entries()) {
    const index = integer(row["idx"], path, "Workspace chunk index");
    const hash = bytes(row["hash"], path, "Workspace chunk hash");
    const size = integer(row["size"], path, "Workspace chunk size");
    if (index !== expected || hash.byteLength !== 32 || size <= 0) {
      corrupt(path, "a Workspace file has malformed or unordered chunks");
    }
    chunks.push({ hash, size });
  }
  return chunks;
}

function requireReferenceSet(
  database: DatabaseSync,
  rootId: string,
  table: string,
  column: string,
  expected: readonly string[],
  path: string,
): void {
  const actual = database
    .prepare(`SELECT ${column} FROM ${table} WHERE root_id = ?`)
    .all(rootId)
    .map((row) => toHex(bytes(row[column], rootId, `${table}.${column}`)))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    corrupt(path, `a retained Workspace root has an inexact ${table} reference set`);
  }
}

function validateCanonicalPath(value: string, databasePath: string): void {
  if (value === "/") {
    return;
  }
  if (
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value)
  ) {
    corrupt(databasePath, "a Workspace root contains a noncanonical path");
  }
  for (const part of value.slice(1).split("/")) {
    if (part === "" || part === "." || part === "..") {
      corrupt(databasePath, "a Workspace root contains a noncanonical path component");
    }
  }
}

function validateName(name: string, path: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0") ||
    hasUnpairedSurrogate(name)
  ) {
    corrupt(path, "its live Workspace contains a noncanonical name");
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(encoder.encode(left), encoder.encode(right));
}

function parentFirst(left: WorkspaceRootEntry, right: WorkspaceRootEntry): number {
  const depth = left.path.split("/").length - right.path.split("/").length;
  return depth === 0 ? compareUtf8(left.path, right.path) : depth;
}

function parentPath(path: string): string {
  const boundary = path.lastIndexOf("/");
  return boundary === 0 ? "/" : path.slice(0, boundary);
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  const value = row?.["count"];
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : -1;
}

function scalarInteger(database: DatabaseSync, sql: string, path: string): number {
  const row = database.prepare(sql).get();
  return integer(row?.["v"], path, "Workspace revision");
}

function mode(value: unknown, path: string): number {
  const parsed = integer(value, path, "Workspace mode");
  if (parsed < 0 || parsed > 0o7777) {
    corrupt(path, "a Workspace node has an invalid mode");
  }
  return parsed;
}

function nonnegative(value: unknown, path: string, label: string): number {
  const parsed = integer(value, path, label);
  if (parsed < 0) {
    corrupt(path, `${label} is negative`);
  }
  return parsed;
}

function integer(value: unknown, path: string, label: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    corrupt(path, `${label} is not a safe integer`);
  }
  return parsed;
}

function bytes(value: unknown, path: string, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    corrupt(path, `${label} is not bytes`);
  }
  return value;
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function corrupt(path: string, reason: string): never {
  throw new WorkflowDatabaseCorruptError(path, reason);
}
