import { type Operation, until } from "effection";
import { link as linkFile } from "../../../vendor/cloudflare-computer-dofs/generated/fs/link.js";
import type { WorkspaceDirentResult } from "../../../vendor/cloudflare-computer-dofs/generated/fs/readdir.d.ts";
import { rename as renamePath } from "../../../vendor/cloudflare-computer-dofs/generated/fs/rename.js";
import type { RunConnection } from "../connections.ts";

export interface DenoWorkspaceEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink";
}

export interface DenoWorkspaceStat {
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly mtime: number;
  readonly size: number;
}

export interface DenoWorkspaceFilesystem {
  readFile(path: string): Operation<Uint8Array>;
  readTextFile(path: string): Operation<string>;
  stat(path: string): Operation<DenoWorkspaceStat>;
  lstat(path: string): Operation<DenoWorkspaceStat>;
  readlink(path: string): Operation<string>;
  readdir(path: string): Operation<DenoWorkspaceEntry[]>;
  writeFile(path: string, content: string | Uint8Array, mode?: number): Operation<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Operation<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Operation<void>;
  rename(from: string, to: string): Operation<void>;
  chmod(path: string, mode: number): Operation<void>;
  symlink(target: string, path: string): Operation<void>;
  link(existingPath: string, newPath: string): Operation<void>;
}

export function createDenoWorkspaceFilesystem(
  connection: RunConnection,
  authorize: () => void,
): DenoWorkspaceFilesystem {
  const { dofs, filesystem } = connection;

  function stat(value: {
    mode: number;
    mtime: number;
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  }): DenoWorkspaceStat {
    const kind = value.isFile ? "file" : value.isDirectory ? "directory" : "symlink";
    return { kind, mode: value.mode, mtime: value.mtime, size: value.size };
  }

  return {
    *readFile(path): Operation<Uint8Array> {
      authorize();
      const stream = yield* until(filesystem.readFile(path));
      return new Uint8Array(yield* until(new Response(stream).arrayBuffer()));
    },

    *readTextFile(path): Operation<string> {
      authorize();
      const value = yield* until(filesystem.readFile(path, "utf8"));
      if (typeof value !== "string") {
        throw new Error("the Workspace text read returned a byte stream");
      }
      return value;
    },

    *stat(path): Operation<DenoWorkspaceStat> {
      authorize();
      return stat(yield* until(filesystem.stat(path)));
    },

    *lstat(path): Operation<DenoWorkspaceStat> {
      authorize();
      return stat(yield* until(filesystem.lstat(path)));
    },

    *readlink(path): Operation<string> {
      authorize();
      return yield* until(filesystem.readlink(path));
    },

    *readdir(path): Operation<DenoWorkspaceEntry[]> {
      authorize();
      const entries = yield* until(filesystem.readdir(path));
      return entries.map((entry: WorkspaceDirentResult) => ({
        name: entry.name,
        kind: entry.isFile ? "file" : entry.isDirectory ? "directory" : "symlink",
      }));
    },

    *writeFile(path, content, mode): Operation<void> {
      authorize();
      yield* until(filesystem.writeFile(path, content, mode === undefined ? {} : { mode }));
    },

    *mkdir(path, options = {}): Operation<void> {
      authorize();
      yield* until(filesystem.mkdir(path, options));
    },

    *remove(path, options = {}): Operation<void> {
      authorize();
      yield* until(filesystem.rm(path, options));
    },

    // deno-lint-ignore require-yield
    *rename(from, to): Operation<void> {
      authorize();
      renamePath(dofs, from, to);
    },

    *chmod(path, mode): Operation<void> {
      authorize();
      yield* until(filesystem.chmod(path, mode));
    },

    *symlink(target, path): Operation<void> {
      authorize();
      yield* until(filesystem.symlink(target, path));
    },

    // deno-lint-ignore require-yield
    *link(existingPath, newPath): Operation<void> {
      authorize();
      linkFile(dofs, existingPath, newPath);
    },
  };
}
