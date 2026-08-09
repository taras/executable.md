import { type Operation } from "effection";
import { chmod as chmodPath } from "../../../vendor/cloudflare-computer-dofs/generated/fs/chmod.js";
import { link as linkFile } from "../../../vendor/cloudflare-computer-dofs/generated/fs/link.js";
import { mkdir as mkdirPath } from "../../../vendor/cloudflare-computer-dofs/generated/fs/mkdir.js";
import { readdir as readDirectory } from "../../../vendor/cloudflare-computer-dofs/generated/fs/readdir.js";
import type { WorkspaceDirentResult } from "../../../vendor/cloudflare-computer-dofs/generated/fs/readdir.d.ts";
import { readRangeSync } from "../../../vendor/cloudflare-computer-dofs/generated/fs/readFile.js";
import { readlink as readLink } from "../../../vendor/cloudflare-computer-dofs/generated/fs/readlink.js";
import { rename as renamePath } from "../../../vendor/cloudflare-computer-dofs/generated/fs/rename.js";
import { rm as removePath } from "../../../vendor/cloudflare-computer-dofs/generated/fs/rm.js";
import {
  lstat as lstatPath,
  stat as statPath,
} from "../../../vendor/cloudflare-computer-dofs/generated/fs/stat.js";
import { symlink as createSymlink } from "../../../vendor/cloudflare-computer-dofs/generated/fs/symlink.js";
import { writeFileSync } from "../../../vendor/cloudflare-computer-dofs/generated/fs/writeFile.js";
import type { RunConnection } from "../connections.ts";
import { throwWorkspaceFilesystemFailure } from "./errors.ts";

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

  function filesystemOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      return throwWorkspaceFilesystemFailure(error);
    }
  }

  function execute<T>(operation: () => T): T {
    authorize();
    return filesystemOperation(operation);
  }

  function readBytes(path: string): Uint8Array {
    const metadata = statPath(dofs, path);
    return new Uint8Array(readRangeSync(dofs, path, 0, metadata.size));
  }

  return {
    *readFile(path): Operation<Uint8Array> {
      return execute(() => readBytes(path));
    },

    *readTextFile(path): Operation<string> {
      const bytes = execute(() => readBytes(path));
      return new TextDecoder().decode(bytes);
    },

    *stat(path): Operation<DenoWorkspaceStat> {
      return stat(execute(() => statPath(dofs, path)));
    },

    *lstat(path): Operation<DenoWorkspaceStat> {
      return stat(execute(() => lstatPath(dofs, path)));
    },

    *readlink(path): Operation<string> {
      return execute(() => readLink(dofs, path));
    },

    *readdir(path): Operation<DenoWorkspaceEntry[]> {
      const entries = execute(() => readDirectory(dofs, path));
      return entries.map((entry: WorkspaceDirentResult) => ({
        name: entry.name,
        kind: entry.isFile ? "file" : entry.isDirectory ? "directory" : "symlink",
      }));
    },

    *writeFile(path, content, mode): Operation<void> {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      execute(() =>
        writeFileSync(dofs, path, bytes, mode === undefined ? {} : { mode }, filesystem.now),
      );
    },

    *mkdir(path, options = {}): Operation<void> {
      execute(() => mkdirPath(dofs, path, options, filesystem.now));
    },

    *remove(path, options = {}): Operation<void> {
      execute(() => removePath(dofs, path, options));
    },

    *rename(from, to): Operation<void> {
      execute(() => renamePath(dofs, from, to));
    },

    *chmod(path, mode): Operation<void> {
      execute(() => chmodPath(dofs, path, mode, filesystem.now));
    },

    *symlink(target, path): Operation<void> {
      execute(() => createSymlink(dofs, target, path, filesystem.now));
    },

    *link(existingPath, newPath): Operation<void> {
      execute(() => linkFile(dofs, existingPath, newPath));
    },
  };
}
