/**
 * The Workspace filesystem, as an operation rather than a place.
 *
 * Both hosts run the same Workspace work and neither one's storage is the
 * contract. The Deno host's Workspace is rows in the run's own SQLite database
 * reached through DOFS; the runner's is a real directory it materialized from
 * the owner. What a mutation is allowed to ask for is the same either way, so
 * it is stated here and implemented twice.
 *
 * Every member is an `Operation`. That is not decoration: one implementation is
 * synchronous by necessity and the other is asynchronous by necessity, and a
 * caller written against either shape would only work against that one.
 */

import type { Operation } from "effection";

export interface WorkspaceEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink";
}

export interface WorkspaceStat {
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly mtime: number;
  readonly size: number;
}

export interface WorkspaceFilesystem {
  readFile(path: string): Operation<Uint8Array>;
  readTextFile(path: string): Operation<string>;
  stat(path: string): Operation<WorkspaceStat>;
  lstat(path: string): Operation<WorkspaceStat>;
  readlink(path: string): Operation<string>;
  readdir(path: string): Operation<WorkspaceEntry[]>;
  writeFile(path: string, content: string | Uint8Array, mode?: number): Operation<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Operation<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Operation<void>;
  rename(from: string, to: string): Operation<void>;
  chmod(path: string, mode: number): Operation<void>;
  symlink(target: string, path: string): Operation<void>;
  link(existingPath: string, newPath: string): Operation<void>;
}
