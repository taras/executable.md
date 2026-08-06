// Re-implementation of computerd's src/fuse/vfs.ts wiring in plain JS,
// minus the @cloudflare/computer-rpc sync loop, plus a file-backed
// SQLite storage instead of SQLiteTestStorage(:memory:).
//
// Wiring steps (mirroring vfs.ts):
//   1. prototype-splice SQLiteWorkspaceProvider -> VirtualProvider
//      (else @platformatic/vfs's create() SILENTLY falls back to MemoryProvider)
//   2. create(provider, { moduleHooks: false })
//   3. Object.defineProperty-forward EXTRA_VFS_METHODS onto the vfs facade.
//      NOTE: writeFileRangesSync is probed by driver.ts but deliberately
//      NOT in the upstream forward list; we replicate that exactly and
//      record whether it reaches the vfs.

import {
  Database,
  initializeSchema,
  SQLiteWorkspaceProvider,
  WorkspaceFilesystem,
} from "./dofs/dist/index.js";
import { FileSQLiteStorage } from "./file-storage.mjs";
import { create, VirtualProvider } from "@platformatic/vfs";

// Exactly the upstream list from packages/computerd/src/fuse/vfs.ts.
const EXTRA_VFS_METHODS = [
  "linkSync",
  "createFileSync",
  "writeRangeSync",
  "truncateFileSync",
  "chmodSync",
  "readRangeSync",
  "openWriteBufferSync",
  "openWriteBufferForCreateSync",
  "releaseWriteBufferSync",
];

let prototypePatched = false;
function ensureVirtualProviderPrototype() {
  if (prototypePatched) return;
  const proto = SQLiteWorkspaceProvider.prototype;
  const parent = Object.getPrototypeOf(proto);
  if (parent === VirtualProvider.prototype) {
    prototypePatched = true;
    return;
  }
  Object.setPrototypeOf(proto, VirtualProvider.prototype);
  prototypePatched = true;
}

export function createFileVfs(dbPath) {
  ensureVirtualProviderPrototype();
  const storage = new FileSQLiteStorage(dbPath);
  const db = new Database(storage);
  initializeSchema(db, () => Date.now());

  const provider = new SQLiteWorkspaceProvider(db);
  const vfs = create(provider, { moduleHooks: false });
  for (const name of EXTRA_VFS_METHODS) {
    const fn = provider[name];
    if (typeof fn !== "function") continue;
    Object.defineProperty(vfs, name, {
      value: (...args) => fn.apply(provider, args),
      writable: true,
      configurable: true,
    });
  }

  // WorkspaceFilesystem over the same Database = the "API side".
  const wfs = new WorkspaceFilesystem(db);
  return { vfs, db, wfs, storage, provider };
}

// Prove we're on SQLite, not the silent MemoryProvider fallback:
// write through the vfs facade, read back through a FRESH node:sqlite
// connection over the same db file.
export async function verifySqliteBacked(vfsHandle, dbPath) {
  const marker = `sqlite-proof-${Date.now()}`;
  if (!vfsHandle.vfs.existsSync("/workspace")) {
    vfsHandle.vfs.mkdirSync("/workspace", { mode: 0o755 });
  }
  vfsHandle.vfs.writeFileSync("/workspace/.sqlite-proof", marker);
  const { DatabaseSync } = await import("node:sqlite");
  const fresh = new DatabaseSync(dbPath);
  try {
    const rows = fresh
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const tables = rows.map((r) => r.name);
    // Find the inode row for the proof file.
    let proofRow = null;
    for (const t of tables) {
      try {
        const hit = fresh
          .prepare(`SELECT * FROM ${t} WHERE CAST(name AS TEXT) = ? LIMIT 1`)
          .all(".sqlite-proof");
        if (hit.length > 0) {
          proofRow = { table: t };
          break;
        }
      } catch {
        // table without a name column; ignore
      }
    }
    return { tables, proofFileFoundInTable: proofRow?.table ?? null, marker };
  } finally {
    fresh.close();
  }
}
