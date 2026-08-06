// Port of upstream packages/computerd/src/fuse/vfs.ts (v0.1.1) minus the
// RPC/sync-loop branches. Deviations from upstream, in full:
//   1. No upstream/SyncRPC support.
//   2. Storage is the file-backed adapter instead of the in-memory
//      SQLiteTestStorage.
//   3. After create(), the wiring verifies the vfs kept our provider —
//      @platformatic/vfs's create() silently falls back to a
//      MemoryProvider when the instanceof check fails, which would make
//      every test pass against the wrong store.

// @ts-types="./types/dofs.d.ts"
import {
  Database,
  initializeSchema,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
// @ts-types="./types/platformatic-vfs.d.ts"
import vfsModule from "@platformatic/vfs";
import type { VirtualFileSystem } from "./types/platformatic-vfs.d.ts";
import { FileSQLiteStorage } from "./file-storage.ts";

const { create, VirtualProvider } = vfsModule;

let prototypePatched = false;
function ensureVirtualProviderPrototype(): void {
  if (prototypePatched) {
    return;
  }
  const proto = SQLiteWorkspaceProvider.prototype;
  const parent = Object.getPrototypeOf(proto);
  if (parent === VirtualProvider.prototype) {
    prototypePatched = true;
    return;
  }
  Object.setPrototypeOf(proto, VirtualProvider.prototype);
  prototypePatched = true;
}

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

export interface WiredFileSystem {
  vfs: VirtualFileSystem;
  db: Database;
  provider: SQLiteWorkspaceProvider;
  storage: FileSQLiteStorage;
}

export function createFileBackedVfs(dbPath: string): WiredFileSystem {
  ensureVirtualProviderPrototype();
  const storage = new FileSQLiteStorage(dbPath);
  const db = new Database(storage);
  initializeSchema(db, Date.now);

  const provider = new SQLiteWorkspaceProvider(db);
  const vfs = create(provider, { moduleHooks: false });
  if (vfs.provider !== provider) {
    storage.close();
    throw new Error(
      "@platformatic/vfs fell back to a MemoryProvider: the prototype splice did not take",
    );
  }
  const source: Record<string, unknown> = Object(provider);
  for (const name of EXTRA_VFS_METHODS) {
    const fn = source[name];
    if (typeof fn !== "function") {
      continue;
    }
    Object.defineProperty(vfs, name, {
      value: (...args: unknown[]) => fn.apply(provider, args),
      writable: true,
      configurable: true,
    });
  }
  return { vfs, db, provider, storage };
}
