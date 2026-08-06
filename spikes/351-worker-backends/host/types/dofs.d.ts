// Typed facade for the surface this spike consumes from the vendored
// @cloudflare/dofs (shared with the #349 spike, which vendors and builds it).
// Deno pairs .js imports with sibling .d.ts files for registry npm packages
// but not for file:-resolved ones, so the package's own declarations cannot
// be used directly. This mirrors vendor/dofs/dist/{types,storage,schema/index,
// fs/filesystem}.d.ts for exactly the members the host uses.

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

export interface WorkspaceStatResult {
  size: number;
  mode: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface WorkspaceDirentResult {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
}

export interface WorkspaceFoundEntry {
  path: string;
  type: "file" | "dir";
}

export interface WorkspaceGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepOptions {
  ignoreCase?: boolean;
}

// Option types the vendored worker-shell adapter imports by name.
export interface ReadFileOptions {
  encoding?: "utf8";
}

export interface WriteFileOptions {
  exclusive?: boolean;
}

export type WriteFileContent = string | Uint8Array;

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export declare class WorkspaceFilesystem {
  constructor(db: Database, options?: { now?: () => number });
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<WorkspaceStatResult>;
  lstat(path: string): Promise<WorkspaceStatResult>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<WorkspaceDirentResult[]>;
  find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]>;
  ls(prefix: string): Promise<string[]>;
  grep(
    pattern: string,
    path: string,
    options?: GrepOptions,
  ): Promise<WorkspaceGrepMatch[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}
