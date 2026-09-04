/**
 * The Workspace filesystem, over the attempt directory this invocation owns.
 *
 * The runner's Workspace is a real tree it materialized from the owner, so the
 * operations are the runtime's own asynchronous primitives adapted with
 * `until`. Nothing above this module names a runtime, and nothing in it decides
 * anything about a Workspace: it moves bytes where it is told, and refuses to
 * be told anywhere outside the attempt.
 *
 * `node:fs/promises` rather than a runtime global, for the same reason the
 * materialization adapter uses it: the same code has to work wherever the
 * runner runs.
 */

import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type Operation, until } from "effection";
import type {
  WorkspaceEntry,
  WorkspaceFilesystem,
  WorkspaceStat,
} from "../workspace/filesystem.ts";
import { throwWorkspaceFilesystemFailure } from "./workspace/errors.ts";
import type { HostPath } from "../remote/materialize.ts";

/**
 * Where a logical path is allowed to land.
 *
 * The attempt root is the whole of what this invocation may touch. A logical
 * path is resolved and then held to that root, so `..`, an absolute path and a
 * path that merely starts with the root's name are each refused before any
 * syscall — the host path is a place to work, never a durable identity.
 */
function within(at: HostPath, root: string, path: string): string {
  const host = resolve(at(path));
  const inside = relative(root, host);
  // The empty relative path is the Workspace root itself, which is a directory
  // this invocation owns and may read. Only leaving the tree is refused.
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new WorkspacePathError("this Workspace path is outside the tree this invocation owns.");
  }
  return host;
}

/** A path no Workspace operation may reach, whatever it names. */
export class WorkspacePathError extends Error {
  override name = "WorkspacePathError";
}

function described(value: {
  mode: number;
  mtimeMs: number;
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}): WorkspaceStat {
  const kind = value.isFile() ? "file" : value.isDirectory() ? "directory" : "symlink";
  // The retained mode is the permission bits; the type bits belong to the
  // node's kind, which is reported beside it.
  return { kind, mode: value.mode & 0o7777, mtime: Math.trunc(value.mtimeMs), size: value.size };
}

/**
 * A runtime failure, named the way the shared classifier reads one.
 *
 * The classifier asks for a `WorkspaceFsError` carrying a documented code,
 * because that is what the other host raises. Renaming here rather than
 * widening the classifier keeps one list of documented conditions.
 */
function named(error: unknown): unknown {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  if (error instanceof Error && typeof code === "string") {
    const renamed = new Error(error.message, { cause: error });
    renamed.name = "WorkspaceFsError";
    Reflect.set(renamed, "code", code);
    return renamed;
  }
  return error;
}

export function createRemoteWorkspaceFilesystem(
  at: HostPath,
  authorize: () => void,
): WorkspaceFilesystem {
  // The attempt's own root, taken from the same resolver every other path goes
  // through. Passing it separately would let the two disagree.
  const resolved = resolve(at("/"));

  function* run<T>(path: string, body: (host: string) => Promise<T>): Operation<T> {
    authorize();
    const host = within(at, resolved, path);
    try {
      return yield* until(body(host));
    } catch (error) {
      // The same classification the Deno host applies: a documented filesystem
      // condition is the effect's own outcome, and everything else is the run
      // failing.
      return throwWorkspaceFilesystemFailure(named(error));
    }
  }

  return {
    *readFile(path): Operation<Uint8Array> {
      return yield* run(path, (host) => readFile(host));
    },

    *readTextFile(path): Operation<string> {
      const bytes = yield* run(path, (host) => readFile(host));
      return new TextDecoder().decode(bytes);
    },

    *stat(path): Operation<WorkspaceStat> {
      return described(yield* run(path, (host) => stat(host)));
    },

    *lstat(path): Operation<WorkspaceStat> {
      return described(yield* run(path, (host) => lstat(host)));
    },

    *readlink(path): Operation<string> {
      return yield* run(path, (host) => readlink(host));
    },

    *readdir(path): Operation<WorkspaceEntry[]> {
      const entries = yield* run(path, (host) => readdir(host, { withFileTypes: true }));
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "symlink",
      }));
    },

    *writeFile(path, content, mode): Operation<void> {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      yield* run(path, (host) => writeFile(host, bytes, mode === undefined ? {} : { mode }));
    },

    *mkdir(path, options = {}): Operation<void> {
      yield* run(path, (host) => mkdir(host, options).then(() => undefined));
    },

    *remove(path, options = {}): Operation<void> {
      yield* run(path, (host) => rm(host, options));
    },

    *rename(from, to): Operation<void> {
      // Both ends are held to the attempt: a rename is two paths, and checking
      // one of them would let the other leave the tree.
      const destination = within(at, resolved, to);
      yield* run(from, (host) => rename(host, destination));
    },

    *chmod(path, mode): Operation<void> {
      yield* run(path, (host) => chmod(host, mode));
    },

    *symlink(target, path): Operation<void> {
      // The target is not resolved here. A symbolic link's target is retained
      // exactly as written, and reading through one goes back through this
      // interface, where it is held to the attempt like any other path.
      yield* run(path, (host) => symlink(target, host));
    },

    *link(existingPath, newPath): Operation<void> {
      const destination = within(at, resolved, newPath);
      yield* run(existingPath, (host) => link(host, destination));
    },
  };
}
