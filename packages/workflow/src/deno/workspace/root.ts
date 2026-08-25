import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Database as CloudflareDatabase } from "../../../vendor/cloudflare-computer-dofs/generated/storage.js";
import { buildManifest } from "../../../vendor/cloudflare-computer-dofs/generated/sync/manifests.js";
import type { RunConnection, RunTransaction } from "../connections.ts";
import { reading } from "../reading.ts";
import {
  bytes,
  compareUtf8,
  corrupt,
  EMPTY_WORKSPACE_ROOT,
  encodeWorkspaceManifest,
  fromHex,
  integer,
  mode,
  nonnegative,
  parseWorkspaceManifest,
  sha256,
  type StoredWorkspaceRoot,
  toHex,
  validateCanonicalPath,
  validatePathName,
  type WorkspaceRejection,
  type WorkspaceRootEntry,
  workspaceRoot,
  WORKSPACE_ROOT_FORMAT,
} from "./manifest.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/;

const dofsManifestSchema = z
  .object({
    version: z.literal(1),
    chunks: z.array(
      z
        .object({
          hash: z.string().regex(SHA256),
          size: z.number().int().safe().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export interface DofsChunk {
  readonly hash: Uint8Array;
  readonly size: number;
}

export interface DofsManifest {
  readonly size: number;
  readonly chunks: readonly { readonly hash: string; readonly size: number }[];
}

interface NodeRow {
  readonly inode: number;
  readonly type: "file" | "dir" | "symlink";
  readonly mode: number;
  readonly mtime: number;
  readonly rev: number;
  readonly manifestHash: Uint8Array | null;
  readonly linkTarget: string | null;
  readonly size: number;
}

interface FileContent {
  readonly manifest: string;
  readonly blobs: readonly string[];
  readonly chunks: readonly DofsChunk[];
}

export interface CaptureWorkspaceRootOptions {
  readonly publish?: boolean;
}

export function initializeEmptyWorkspace(database: DatabaseSync): void {
  database
    .prepare("INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, ?, ?)")
    .run(EMPTY_WORKSPACE_ROOT.rootId, WORKSPACE_ROOT_FORMAT, EMPTY_WORKSPACE_ROOT.manifest);
  database
    .prepare("INSERT INTO workspace_state (singleton_id, current_root_id) VALUES (1, ?)")
    .run(EMPTY_WORKSPACE_ROOT.rootId);
}

export function captureWorkspaceRoot(
  connection: RunConnection,
  transaction: RunTransaction,
  options: CaptureWorkspaceRootOptions = {},
): StoredWorkspaceRoot {
  connection.validateTransaction(transaction);
  const root = snapshotWorkspace(connection.database, connection.dofs, connection.path, true);
  retainWorkspaceRoot(connection.database, root, connection.path);
  if (options.publish === true) {
    setCurrentWorkspaceRoot(connection.database, root.rootId, connection.path);
  }
  return root;
}

export function snapshotWorkspace(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  databasePath: string,
  materializeMissingManifests: boolean,
): StoredWorkspaceRoot {
  const currentRev = validateDofsBookkeeping(database, databasePath);
  const entries: Array<{ entry: WorkspaceRootEntry; inode: number }> = [];
  const visitingDirectories = new Set<number>();
  const reachableNodes = new Set<number>();
  const nonFileNodes = new Set<number>();
  const filePaths = new Map<number, string[]>();
  const fileContents = new Map<number, FileContent>();
  const manifestHashes = new Set<string>();
  const blobHashes = new Set<string>();
  let reachableDirents = 0;
  let reachableChunks = 0;

  function visit(inode: number, canonicalPath: string): void {
    const node = readNode(database, inode, currentRev, databasePath);
    if (node.type === "dir") {
      if (visitingDirectories.has(inode) || reachableNodes.has(inode)) {
        corrupt(
          databasePath,
          "its live Workspace contains a directory cycle or directory hardlink",
        );
      }
      visitingDirectories.add(inode);
      reachableNodes.add(inode);
      entries.push({
        inode,
        entry: {
          path: canonicalPath,
          kind: "directory",
          mode: node.mode,
          mtime: node.mtime,
        },
      });
      for (const child of readDirents(database, inode, databasePath)) {
        reachableDirents += 1;
        validatePathName(child.name, databasePath);
        const childPath =
          canonicalPath === "/" ? `/${child.name}` : `${canonicalPath}/${child.name}`;
        visit(child.inode, childPath);
      }
      visitingDirectories.delete(inode);
      return;
    }

    if (node.type === "symlink") {
      if (nonFileNodes.has(inode) || reachableNodes.has(inode)) {
        corrupt(databasePath, "its live Workspace contains a non-file hardlink");
      }
      nonFileNodes.add(inode);
      reachableNodes.add(inode);
      const target = node.linkTarget;
      if (target === null || target.includes("\0")) {
        corrupt(databasePath, "its live Workspace contains an invalid symbolic-link target");
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

    reachableNodes.add(inode);
    const paths = filePaths.get(inode) ?? [];
    paths.push(canonicalPath);
    filePaths.set(inode, paths);
    let content = fileContents.get(inode);
    if (content === undefined) {
      content = validateFile(database, dofs, node, databasePath, materializeMissingManifests);
      fileContents.set(inode, content);
      reachableChunks += content.chunks.length;
      manifestHashes.add(content.manifest);
      for (const hash of content.blobs) {
        blobHashes.add(hash);
      }
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
  if (count(database, "vfs_nodes", databasePath) !== reachableNodes.size) {
    corrupt(databasePath, "its live Workspace contains unreachable filesystem nodes");
  }
  if (count(database, "vfs_dirents", databasePath) !== reachableDirents) {
    corrupt(databasePath, "its live Workspace contains unreachable directory entries");
  }
  if (count(database, "vfs_chunks", databasePath) !== reachableChunks) {
    corrupt(databasePath, "its live Workspace contains chunks outside reachable files");
  }

  entries.sort((left, right) => compareUtf8(left.entry.path, right.entry.path));
  const groups = [...filePaths.values()]
    .filter((paths) => paths.length > 1)
    .map((paths) => [...paths].sort(compareUtf8))
    .sort((left, right) => compareUtf8(left[0] ?? "", right[0] ?? ""));
  for (const [index, paths] of groups.entries()) {
    const group = `h${index}`;
    const members = new Set(paths);
    for (const item of entries) {
      if (item.entry.kind === "file" && members.has(item.entry.path)) {
        item.entry.hardlink = group;
      }
    }
  }

  validateDofsContentStore(database, databasePath);
  const manifest = encodeWorkspaceManifest(
    entries.map((item) => item.entry),
    databasePath,
  );
  return workspaceRoot(
    manifest,
    [...manifestHashes].sort(compareUtf8),
    [...blobHashes].sort(compareUtf8),
  );
}

export function retainWorkspaceRoot(
  database: DatabaseSync,
  root: StoredWorkspaceRoot,
  databasePath: string,
): void {
  const parsed = parseWorkspaceManifest(root.manifest, databasePath);
  const derived = rootFromManifest(database, root.manifest, parsed, databasePath);
  if (
    derived.rootId !== root.rootId ||
    !equalStrings(derived.manifestHashes, root.manifestHashes) ||
    !equalStrings(derived.blobHashes, root.blobHashes)
  ) {
    corrupt(databasePath, "a Workspace root does not match its canonical content references");
  }

  const existing = reading(
    database,
    "SELECT format_version, manifest FROM workspace_roots WHERE root_id = ?",
  ).get(root.rootId);
  if (existing === undefined) {
    database
      .prepare("INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, ?, ?)")
      .run(root.rootId, WORKSPACE_ROOT_FORMAT, root.manifest);
    for (const hash of root.manifestHashes) {
      database
        .prepare("INSERT INTO workspace_root_manifest_refs (root_id, manifest_hash) VALUES (?, ?)")
        .run(root.rootId, fromHex(hash, databasePath, "Workspace manifest reference"));
    }
    for (const hash of root.blobHashes) {
      database
        .prepare("INSERT INTO workspace_root_blob_refs (root_id, blob_hash) VALUES (?, ?)")
        .run(root.rootId, fromHex(hash, databasePath, "Workspace blob reference"));
    }
  } else if (
    integer(existing["format_version"], databasePath, "Workspace root format") !==
      WORKSPACE_ROOT_FORMAT ||
    existing["manifest"] !== root.manifest
  ) {
    corrupt(databasePath, "a retained Workspace root identity has different stored bytes");
  }

  requireReferenceSet(
    database,
    root.rootId,
    "workspace_root_manifest_refs",
    "manifest_hash",
    root.manifestHashes,
    databasePath,
  );
  requireReferenceSet(
    database,
    root.rootId,
    "workspace_root_blob_refs",
    "blob_hash",
    root.blobHashes,
    databasePath,
  );
}

export function loadWorkspaceRoot(
  database: DatabaseSync,
  rootId: string,
  databasePath: string,
): StoredWorkspaceRoot {
  if (!SHA256.test(rootId)) {
    corrupt(databasePath, "the selected Workspace root identity is malformed");
  }
  const row = reading(
    database,
    "SELECT root_id, format_version, manifest FROM workspace_roots WHERE root_id = ?",
  ).get(rootId);
  if (row === undefined) {
    corrupt(databasePath, "the selected Workspace root is not retained");
  }
  return parseStoredRoot(database, row, databasePath);
}

export function setCurrentWorkspaceRoot(
  database: DatabaseSync,
  rootId: string,
  databasePath: string,
): void {
  const changed = database
    .prepare("UPDATE workspace_state SET current_root_id = ? WHERE singleton_id = 1")
    .run(rootId);
  if (changed.changes !== 1) {
    corrupt(databasePath, "its Workspace current-root pointer is missing");
  }
}

/**
 * Every Workspace root this run retains, in one deterministic order.
 *
 * The set a generated-XMD admission states its as-of-admission basis over. A
 * continuation asks for that basis by membership, so ordering no longer decides
 * whether a resumed run holds its grant — it stays deterministic so the
 * retained record reads the same however SQLite would have ordered the rows,
 * and `root_id` is the only stable ordering this table has, stable across
 * processes because it is content.
 *
 * `lifecycle.ts` derives forkability from the same table through its own read;
 * that one answers a set membership question on a read-only connection, and this
 * one belongs to a live run.
 */
export function retainedWorkspaceRoots(database: DatabaseSync): string[] {
  const roots: string[] = [];
  for (const row of reading(
    database,
    "SELECT root_id FROM workspace_roots ORDER BY root_id",
  ).all()) {
    const rootId = row["root_id"];
    if (typeof rootId === "string") {
      roots.push(rootId);
    }
  }
  return roots;
}

export function currentWorkspaceRoot(database: DatabaseSync, databasePath: string): string {
  const rows = reading(database, "SELECT singleton_id, current_root_id FROM workspace_state").all();
  const row = rows[0];
  if (
    rows.length !== 1 ||
    integer(row?.["singleton_id"], databasePath, "Workspace singleton") !== 1 ||
    typeof row?.["current_root_id"] !== "string" ||
    !SHA256.test(row["current_root_id"])
  ) {
    corrupt(databasePath, "it does not hold exactly one valid Workspace current-root pointer");
  }
  return row["current_root_id"];
}

export function verifyWorkspace(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  databasePath: string,
): void {
  validateDofsContentStore(database, databasePath);
  const retained = new Map<string, StoredWorkspaceRoot>();
  for (const row of reading(
    database,
    "SELECT root_id, format_version, manifest FROM workspace_roots ORDER BY root_id",
  ).all()) {
    const root = parseStoredRoot(database, row, databasePath);
    if (retained.has(root.rootId)) {
      corrupt(databasePath, "it contains a duplicate retained Workspace root");
    }
    retained.set(root.rootId, root);
    requireReferenceSet(
      database,
      root.rootId,
      "workspace_root_manifest_refs",
      "manifest_hash",
      root.manifestHashes,
      databasePath,
    );
    requireReferenceSet(
      database,
      root.rootId,
      "workspace_root_blob_refs",
      "blob_hash",
      root.blobHashes,
      databasePath,
    );
  }
  if (retained.size === 0) {
    corrupt(databasePath, "it contains no retained Workspace root");
  }

  const unretainedJournalRoots = reading(
    database,
    `SELECT COUNT(*) AS count
         FROM journal_events AS event
         LEFT JOIN workspace_roots AS root ON root.root_id = event.workspace_root_id
        WHERE root.root_id IS NULL`,
  ).get();
  if (integer(unretainedJournalRoots?.["count"], databasePath, "journal root count") !== 0) {
    corrupt(databasePath, "a journal event names a Workspace root that is not retained");
  }

  const current = currentWorkspaceRoot(database, databasePath);
  if (!retained.has(current)) {
    corrupt(databasePath, "its current Workspace root is not retained");
  }
  const live = snapshotWorkspace(database, dofs, databasePath, false);
  if (live.rootId !== current) {
    corrupt(databasePath, "its live Workspace frontier does not equal its current root");
  }
}

export function readDofsManifest(
  database: DatabaseSync,
  hash: string,
  databasePath: string,
): DofsManifest {
  const hashBytes = fromHex(hash, databasePath, "DOFS manifest identity");
  const row = reading(
    database,
    "SELECT hash, size, encoded, last_seen FROM vfs_manifests WHERE hash = ?",
  ).get(hashBytes);
  if (row === undefined) {
    corrupt(databasePath, "a retained Workspace root names a missing DOFS manifest");
  }
  if (toHex(bytes(row["hash"], databasePath, "DOFS manifest hash")) !== hash) {
    corrupt(databasePath, "a DOFS manifest row carries the wrong identity");
  }
  const size = nonnegative(row["size"], databasePath, "DOFS manifest size");
  nonnegative(row["last_seen"], databasePath, "DOFS manifest last-seen value");
  const encoded = bytes(row["encoded"], databasePath, "DOFS manifest encoding");
  if (toHex(sha256(encoded)) !== hash) {
    corrupt(databasePath, "a DOFS manifest hash does not match its bytes");
  }
  const decoded = decodeDofsManifest(encoded, (reason) => corrupt(databasePath, reason));
  if (decoded.size !== size) {
    corrupt(databasePath, "a DOFS manifest size does not equal its chunks");
  }
  for (const chunk of decoded.chunks) {
    validateBlob(database, chunk.hash, chunk.size, databasePath);
  }
  return decoded;
}

/**
 * The manifest one encoding describes, without a database to look anything up in.
 *
 * Separated from the row that holds it because the same bytes are validated in
 * two places: by a live run reading its own content store, and by a reader
 * checking a detached copy where there is no store to consult. The chunks it
 * names are proven to exist by whoever called; what is decided here is only
 * whether these bytes are a canonically encoded DOFS manifest at all, and what
 * size the chunks it lists add up to.
 */
export function decodeDofsManifest(encoded: Uint8Array, reject: WorkspaceRejection): DofsManifest {
  let text: string;
  let offered: unknown;
  try {
    text = decoder.decode(encoded);
    offered = JSON.parse(text);
  } catch {
    reject("a DOFS manifest is not canonical UTF-8 JSON");
  }
  const parsed = dofsManifestSchema.safeParse(offered);
  if (!parsed.success || JSON.stringify(parsed.data) !== text) {
    reject("a DOFS manifest is not canonically encoded");
  }
  const total = parsed.data.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (!Number.isSafeInteger(total)) {
    reject("a DOFS manifest names more bytes than a size can hold");
  }
  return Object.freeze({ size: total, chunks: Object.freeze(parsed.data.chunks) });
}

function parseStoredRoot(
  database: DatabaseSync,
  row: Record<string, unknown>,
  databasePath: string,
): StoredWorkspaceRoot {
  const rootId = row["root_id"];
  const format = integer(row["format_version"], databasePath, "Workspace root format");
  const manifest = row["manifest"];
  if (
    typeof rootId !== "string" ||
    !SHA256.test(rootId) ||
    format !== WORKSPACE_ROOT_FORMAT ||
    typeof manifest !== "string"
  ) {
    corrupt(databasePath, "one of its retained Workspace roots is malformed");
  }
  const parsed = parseWorkspaceManifest(manifest, databasePath);
  const root = rootFromManifest(database, manifest, parsed, databasePath);
  if (root.rootId !== rootId) {
    corrupt(databasePath, "one of its retained Workspace root identities does not match its bytes");
  }
  return root;
}

function rootFromManifest(
  database: DatabaseSync,
  manifest: string,
  parsed: ReturnType<typeof parseWorkspaceManifest>,
  databasePath: string,
): StoredWorkspaceRoot {
  const manifests = new Map<string, DofsManifest>();
  for (const entry of parsed.entries) {
    if (entry.kind === "file") {
      let manifest = manifests.get(entry.manifest);
      if (manifest === undefined) {
        manifest = readDofsManifest(database, entry.manifest, databasePath);
        manifests.set(entry.manifest, manifest);
      }
      if (entry.size !== manifest.size) {
        corrupt(databasePath, "a retained file size differs from its DOFS manifest");
      }
    }
  }
  const blobs = new Set<string>();
  for (const manifest of manifests.values()) {
    for (const chunk of manifest.chunks) {
      blobs.add(chunk.hash);
    }
  }
  return workspaceRoot(
    manifest,
    [...manifests.keys()].sort(compareUtf8),
    [...blobs].sort(compareUtf8),
  );
}

function validateFile(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  node: NodeRow,
  databasePath: string,
  materializeMissingManifest: boolean,
): FileContent {
  const chunks = readChunks(database, node.inode, databasePath);
  const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (!Number.isSafeInteger(total) || total !== node.size) {
    corrupt(databasePath, "a Workspace file size does not equal its ordered chunks");
  }
  const blobs = chunks.map((chunk) =>
    validateBlob(database, toHex(chunk.hash), chunk.size, databasePath),
  );
  let manifestHash = node.manifestHash;
  if (manifestHash === null) {
    if (!materializeMissingManifest) {
      corrupt(databasePath, "a Workspace file has no retained DOFS manifest");
    }
    manifestHash = buildManifest(
      dofs,
      chunks,
      nonnegative(node.mtime, databasePath, "Workspace mtime"),
    );
    database
      .prepare("UPDATE vfs_nodes SET manifest_hash = ? WHERE inode = ?")
      .run(manifestHash, node.inode);
  }
  if (manifestHash.byteLength !== 32) {
    corrupt(databasePath, "a Workspace file has an invalid DOFS manifest identity");
  }
  const manifest = toHex(manifestHash);
  const encoded = readDofsManifest(database, manifest, databasePath);
  if (
    encoded.size !== node.size ||
    !equalChunks(
      encoded.chunks,
      chunks.map((chunk) => ({ hash: toHex(chunk.hash), size: chunk.size })),
    )
  ) {
    corrupt(databasePath, "a Workspace file's DOFS manifest does not equal its chunks");
  }
  return Object.freeze({ manifest, blobs: Object.freeze(blobs), chunks: Object.freeze(chunks) });
}

function validateDofsContentStore(database: DatabaseSync, databasePath: string): void {
  const blobs = reading(
    database,
    "SELECT hash, size, last_seen FROM vfs_blobs ORDER BY hash",
  ).all();
  for (const row of blobs) {
    const hash = bytes(row["hash"], databasePath, "DOFS blob hash");
    if (hash.byteLength !== 32) {
      corrupt(databasePath, "a DOFS blob has an invalid hash length");
    }
    nonnegative(row["last_seen"], databasePath, "DOFS blob last-seen value");
    validateBlob(
      database,
      toHex(hash),
      nonnegative(row["size"], databasePath, "DOFS blob size"),
      databasePath,
    );
  }
  if (count(database, "vfs_blob_bytes", databasePath) !== blobs.length) {
    corrupt(databasePath, "the DOFS blob index and retained bytes are incomplete");
  }

  for (const row of reading(database, "SELECT hash FROM vfs_manifests ORDER BY hash").all()) {
    const hash = bytes(row["hash"], databasePath, "DOFS manifest hash");
    if (hash.byteLength !== 32) {
      corrupt(databasePath, "a DOFS manifest has an invalid hash length");
    }
    readDofsManifest(database, toHex(hash), databasePath);
  }
}

function validateBlob(
  database: DatabaseSync,
  hash: string,
  expectedSize: number,
  databasePath: string,
): string {
  const hashBytes = fromHex(hash, databasePath, "DOFS blob identity");
  const row = reading(
    database,
    `SELECT blob.hash, blob.size, blob.last_seen, content.bytes
         FROM vfs_blobs AS blob
         JOIN vfs_blob_bytes AS content ON content.hash = blob.hash
        WHERE blob.hash = ?`,
  ).get(hashBytes);
  if (row === undefined) {
    corrupt(databasePath, "a Workspace file names missing DOFS blob bytes");
  }
  if (toHex(bytes(row["hash"], databasePath, "DOFS blob hash")) !== hash) {
    corrupt(databasePath, "a DOFS blob row carries the wrong identity");
  }
  const size = nonnegative(row["size"], databasePath, "DOFS blob size");
  nonnegative(row["last_seen"], databasePath, "DOFS blob last-seen value");
  const content = bytes(row["bytes"], databasePath, "DOFS blob bytes");
  if (
    size !== expectedSize ||
    content.byteLength !== expectedSize ||
    toHex(sha256(content)) !== hash
  ) {
    corrupt(databasePath, "a DOFS blob's hash or size does not match its bytes");
  }
  return hash;
}

function readNode(
  database: DatabaseSync,
  inode: number,
  currentRev: number,
  databasePath: string,
): NodeRow {
  const row = reading(
    database,
    `SELECT inode, type, mode, mtime, rev, mount_root, stub_size,
              manifest_hash, link_target, size
         FROM vfs_nodes WHERE inode = ?`,
  ).get(inode);
  if (row === undefined) {
    corrupt(databasePath, "its live Workspace contains a dangling directory entry");
  }
  const type = row["type"];
  if (type !== "file" && type !== "dir" && type !== "symlink") {
    corrupt(databasePath, "its live Workspace contains an unknown node type");
  }
  const manifest = row["manifest_hash"];
  if (manifest !== null && !(manifest instanceof Uint8Array)) {
    corrupt(databasePath, "its live Workspace contains an invalid manifest hash");
  }
  const target = row["link_target"];
  if (target !== null && typeof target !== "string") {
    corrupt(databasePath, "its live Workspace contains an invalid link target");
  }
  const rev = nonnegative(row["rev"], databasePath, "Workspace node revision");
  if (rev > currentRev) {
    corrupt(databasePath, "a Workspace node revision is ahead of the filesystem revision");
  }
  if (row["mount_root"] !== null || row["stub_size"] !== null) {
    corrupt(databasePath, "its retained Workspace contains unsupported mount bookkeeping");
  }
  const result: NodeRow = {
    inode: nonnegative(row["inode"], databasePath, "Workspace inode"),
    type,
    mode: mode(row["mode"], databasePath),
    mtime: integer(row["mtime"], databasePath, "Workspace mtime"),
    rev,
    manifestHash: manifest,
    linkTarget: target,
    size: nonnegative(row["size"], databasePath, "Workspace size"),
  };
  if (result.inode < 1) {
    corrupt(databasePath, "a Workspace inode is not positive");
  }
  if (
    result.type === "dir" &&
    (result.manifestHash !== null || result.linkTarget !== null || result.size !== 0)
  ) {
    corrupt(databasePath, "a Workspace directory carries file or symbolic-link metadata");
  }
  if (
    result.type === "symlink" &&
    (result.manifestHash !== null || result.linkTarget === null || result.size !== 0)
  ) {
    corrupt(databasePath, "a Workspace symbolic link carries inconsistent metadata");
  }
  if (result.type === "file" && result.linkTarget !== null) {
    corrupt(databasePath, "a Workspace file carries a symbolic-link target");
  }
  return result;
}

function readDirents(
  database: DatabaseSync,
  inode: number,
  databasePath: string,
): Array<{ name: string; inode: number }> {
  const entries: Array<{ name: string; inode: number }> = [];
  for (const row of reading(
    database,
    "SELECT name, child_inode FROM vfs_dirents WHERE parent_inode = ?",
  ).all(inode)) {
    const name = row["name"];
    if (typeof name !== "string") {
      corrupt(databasePath, "its live Workspace contains an invalid directory-entry name");
    }
    const child = nonnegative(row["child_inode"], databasePath, "Workspace child inode");
    if (child < 1) {
      corrupt(databasePath, "a Workspace directory entry names an invalid inode");
    }
    entries.push({ name, inode: child });
  }
  return entries.sort((left, right) => compareUtf8(left.name, right.name));
}

function readChunks(database: DatabaseSync, inode: number, databasePath: string): DofsChunk[] {
  const chunks: DofsChunk[] = [];
  for (const [expected, row] of reading(
    database,
    "SELECT idx, hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
  )
    .all(inode)
    .entries()) {
    const index = nonnegative(row["idx"], databasePath, "Workspace chunk index");
    const hash = bytes(row["hash"], databasePath, "Workspace chunk hash");
    const size = nonnegative(row["size"], databasePath, "Workspace chunk size");
    if (index !== expected || hash.byteLength !== 32 || size === 0) {
      corrupt(databasePath, "a Workspace file has malformed or unordered chunks");
    }
    validateBlob(database, toHex(hash), size, databasePath);
    chunks.push({ hash, size });
  }
  return chunks;
}

function validateDofsBookkeeping(database: DatabaseSync, databasePath: string): number {
  const metadata = reading(database, "SELECT k, v FROM vfs_meta ORDER BY k").all();
  if (
    metadata.length !== 2 ||
    metadata[0]?.["k"] !== "rev" ||
    metadata[1]?.["k"] !== "schema_version" ||
    integer(metadata[1]?.["v"], databasePath, "DOFS schema version") !== 5
  ) {
    corrupt(databasePath, "its Workspace filesystem metadata is malformed");
  }
  const rev = nonnegative(metadata[0]?.["v"], databasePath, "Workspace revision");
  if (rev < 1) {
    corrupt(databasePath, "its Workspace revision is not initialized");
  }

  const watermarks = reading(database, "SELECT k, backend, v FROM _vfs_watermark ORDER BY k").all();
  if (
    watermarks.length !== 2 ||
    watermarks[0]?.["k"] !== "fetchRev" ||
    watermarks[0]?.["backend"] !== "default" ||
    integer(watermarks[0]?.["v"], databasePath, "DOFS fetch watermark") !== 0 ||
    watermarks[1]?.["k"] !== "pushRev" ||
    watermarks[1]?.["backend"] !== "default" ||
    integer(watermarks[1]?.["v"], databasePath, "DOFS push watermark") !== 0
  ) {
    corrupt(databasePath, "its Workspace synchronization watermarks are malformed");
  }
  const cursors = reading(database, "SELECT k, backend, path FROM _vfs_fetch_cursor").all();
  if (
    cursors.length !== 1 ||
    cursors[0]?.["k"] !== "fetch" ||
    cursors[0]?.["backend"] !== "default" ||
    cursors[0]?.["path"] !== null
  ) {
    corrupt(databasePath, "its Workspace synchronization cursor is malformed");
  }
  if (count(database, "_vfs_mounts", databasePath) !== 0) {
    corrupt(databasePath, "its retained Workspace contains an unsupported mount");
  }

  for (const row of reading(
    database,
    "SELECT id, rev, path, op FROM vfs_changes ORDER BY id",
  ).all()) {
    const id = nonnegative(row["id"], databasePath, "Workspace change identity");
    const changeRev = nonnegative(row["rev"], databasePath, "Workspace change revision");
    if (
      id < 1 ||
      changeRev < 1 ||
      changeRev > rev ||
      typeof row["path"] !== "string" ||
      row["op"] !== "delete"
    ) {
      corrupt(databasePath, "its Workspace change bookkeeping is malformed");
    }
    validateCanonicalPath(row["path"], databasePath);
  }
  return rev;
}

function requireReferenceSet(
  database: DatabaseSync,
  rootId: string,
  table: string,
  column: string,
  expected: readonly string[],
  databasePath: string,
): void {
  const actual = reading(database, `SELECT ${column} FROM ${table} WHERE root_id = ?`)
    .all(rootId)
    .map((row) => toHex(bytes(row[column], databasePath, `${table}.${column}`)))
    .sort(compareUtf8);
  if (!equalStrings(actual, expected)) {
    corrupt(databasePath, `a retained Workspace root has an inexact ${table} reference set`);
  }
}

function count(database: DatabaseSync, table: string, databasePath: string): number {
  const row = reading(database, `SELECT COUNT(*) AS count FROM ${table}`).get();
  return nonnegative(row?.["count"], databasePath, `${table} row count`);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalChunks(
  left: readonly { readonly hash: string; readonly size: number }[],
  right: readonly { readonly hash: string; readonly size: number }[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
