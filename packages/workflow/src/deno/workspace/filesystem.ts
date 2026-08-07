import { type Operation, until } from "effection";
import { link as dofsLink } from "../../../vendor/cloudflare-computer-dofs/generated/fs/link.js";
import { rename as dofsRename } from "../../../vendor/cloudflare-computer-dofs/generated/fs/rename.js";
import { clearBlobCache } from "../../../vendor/cloudflare-computer-dofs/generated/fs/blobCache.js";
import { clearResolveCache } from "../../../vendor/cloudflare-computer-dofs/generated/fs/resolveCache.js";
import type { RunConnection } from "../connections.ts";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceFilesystem,
  WorkspaceStat,
} from "../../workspace/api.ts";

export function createWorkspaceFilesystem(connection: RunConnection): WorkspaceFilesystem {
  const { dofs, filesystem } = connection;

  function toStat(value: {
    mode: number;
    mtime: number;
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  }): WorkspaceStat {
    const kind = value.isFile ? "file" : value.isDirectory ? "directory" : "symlink";
    return { mode: value.mode, mtime: value.mtime, size: value.size, kind };
  }

  return {
    *readFile(path): Operation<Uint8Array> {
      const stream = yield* until(filesystem.readFile(path));
      return new Uint8Array(yield* until(new Response(stream).arrayBuffer()));
    },

    *readTextFile(path): Operation<string> {
      const content = yield* until(filesystem.readFile(path, "utf8"));
      if (typeof content !== "string") {
        throw new Error("the Workspace text read returned a byte stream");
      }
      return content;
    },

    *stat(path): Operation<WorkspaceStat> {
      return toStat(yield* until(filesystem.stat(path)));
    },

    *lstat(path): Operation<WorkspaceStat> {
      return toStat(yield* until(filesystem.lstat(path)));
    },

    *readlink(path): Operation<string> {
      return yield* until(filesystem.readlink(path));
    },

    *readdir(path): Operation<WorkspaceDirectoryEntry[]> {
      const entries = yield* until(filesystem.readdir(path));
      const result: WorkspaceDirectoryEntry[] = [];
      for (const entry of entries) {
        result.push({
          name: entry.name,
          kind: entry.isFile ? "file" : entry.isDirectory ? "directory" : "symlink",
        });
      }
      return result;
    },

    *writeFile(path, content, mode): Operation<void> {
      yield* until(filesystem.writeFile(path, content, mode === undefined ? {} : { mode }));
    },

    *mkdir(path, options = {}): Operation<void> {
      yield* until(filesystem.mkdir(path, options));
    },

    *remove(path, options = {}): Operation<void> {
      yield* until(filesystem.rm(path, options));
    },

    // deno-lint-ignore require-yield
    *rename(from, to): Operation<void> {
      dofsRename(dofs, from, to);
    },

    *chmod(path, mode): Operation<void> {
      yield* until(filesystem.chmod(path, mode));
    },

    *symlink(target, path): Operation<void> {
      yield* until(filesystem.symlink(target, path));
    },

    // deno-lint-ignore require-yield
    *link(existingPath, newPath): Operation<void> {
      dofsLink(dofs, existingPath, newPath);
    },
  };
}

export function clearWorkspaceCaches(connection: RunConnection): void {
  clearResolveCache(connection.dofs);
  clearBlobCache(connection.dofs);
}

const WORKSPACE_ERROR_CODES = new Set([
  "ENOENT",
  "ENOTEMPTY",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "EINVAL",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSYS",
  "EBADF",
  "ELOOP",
  "EUNKNOWN_HASH",
]);

export function isJournalableWorkspaceError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "WorkspaceFsError" &&
    "code" in error &&
    typeof error.code === "string" &&
    WORKSPACE_ERROR_CODES.has(error.code)
  );
}
