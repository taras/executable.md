// @ts-types="../../351-worker-backends/host/types/dofs.d.ts"
import { Database, initializeSchema } from "@cloudflare/dofs";
import { WorkspaceFsShim } from "./workspace-fs.ts";
import { FileSQLiteStorage } from "./storage.ts";

export interface Workspace {
  fs: WorkspaceFsShim;
  storage: FileSQLiteStorage;
  db: Database;
}

export function openWorkspace(path: string): Workspace {
  const storage = new FileSQLiteStorage(path);
  const db = new Database(storage);
  initializeSchema(db, Date.now);
  storage.initializeJournal();
  return { fs: new WorkspaceFsShim(db), storage, db };
}
