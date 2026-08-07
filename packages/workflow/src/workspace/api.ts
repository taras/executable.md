import type { DurableEffect, EffectDescription, Json } from "@executablemd/durable-streams";
import type { Operation, Result } from "effection";

export interface WorkspaceStat {
  readonly mode: number;
  readonly mtime: number;
  readonly size: number;
  readonly kind: "file" | "directory" | "symlink";
}

export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink";
}

export interface WorkspaceFilesystem {
  readFile(path: string): Operation<Uint8Array>;
  readTextFile(path: string): Operation<string>;
  stat(path: string): Operation<WorkspaceStat>;
  lstat(path: string): Operation<WorkspaceStat>;
  readlink(path: string): Operation<string>;
  readdir(path: string): Operation<WorkspaceDirectoryEntry[]>;
  writeFile(path: string, content: string | Uint8Array, mode?: number): Operation<void>;
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ): Operation<void>;
  remove(path: string, options?: { readonly recursive?: boolean }): Operation<void>;
  rename(from: string, to: string): Operation<void>;
  chmod(path: string, mode: number): Operation<void>;
  symlink(target: string, path: string): Operation<void>;
  link(existingPath: string, newPath: string): Operation<void>;
}

export interface WorkflowWorkspace {
  /** The immutable root currently published for this run. */
  currentRoot(): Operation<Result<string>>;

  /**
   * One provider-level durable Workspace operation.
   *
   * This is the retained transaction foundation used by later public
   * Workspace effects. It is not a public file component or history command.
   */
  effect<T extends Json>(
    description: EffectDescription,
    mutation: (filesystem: WorkspaceFilesystem) => Operation<T>,
  ): DurableEffect<T>;
}
