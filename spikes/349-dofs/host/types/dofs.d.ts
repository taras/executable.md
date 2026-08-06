// Typed facade for the surface this spike consumes from the vendored
// @cloudflare/dofs. Deno pairs .js imports with sibling .d.ts files for
// registry npm packages but not for file:-resolved ones, so the vendored
// package's own declarations cannot be used directly; this file mirrors
// vendor/dofs/dist/{types,storage,schema/index,fs/filesystem}.d.ts for
// exactly the members the host uses.

export interface SQLCursorLike<Row extends object = Record<string, unknown>> {
  toArray(): Row[];
}

export interface SQLStorageLike {
  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SQLCursorLike<Row>;
}

export interface DurableObjectStorageLike {
  sql: SQLStorageLike;
  transaction?<T>(closure: () => T | Promise<T>): T | Promise<T>;
  transactionSync?<T>(closure: () => T): T;
}

export declare class Database {
  constructor(storage: DurableObjectStorageLike);
  all<Row extends object>(query: string, ...bindings: unknown[]): Row[];
}

export declare function initializeSchema(
  db: Database,
  now: () => number,
): void;

export declare const SCHEMA_VERSION: number;

export interface WorkspaceDirentResult {
  name: string;
}

export interface WorkspaceStatResult {
  size: number;
  mode: number;
}

export interface WorkspaceFilesystemOptions {
  now?: () => number;
}

export declare class WorkspaceFilesystem {
  constructor(db: Database, options?: WorkspaceFilesystemOptions);
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<WorkspaceStatResult>;
  lstat(path: string): Promise<WorkspaceStatResult>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<WorkspaceDirentResult[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}
