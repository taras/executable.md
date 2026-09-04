/**
 * The Workspace filesystem, over the attempt directory this invocation owns.
 *
 * The runner's Workspace is a real directory it materialized from the owner, so
 * the operations are the runtime's own asynchronous primitives adapted with
 * `until`. Nothing above this module names a runtime, and nothing in it decides
 * anything about a Workspace: it moves bytes where it is told, and refuses to
 * be told anywhere outside the attempt.
 *
 * ## Why lexical admission is not containment here
 *
 * The Deno host's Workspace is rows in a database, so a path there has no
 * outside to reach and admission is arithmetic. This one is a real directory on
 * a host that has an outside, and a symbolic link is a path the kernel follows
 * on its own. Comparing the *spelling* of a path with the attempt root admits
 * `/link` while the syscall that follows reads whatever `/link` points at.
 *
 * So every operation resolves before it acts, on the same terms
 * `packages/runtime/host-files.ts` states for the host provider: a complete
 * `..` segment leaves and `..notes.md` does not; the existing prefix is walked
 * so a path that does not exist yet can still be judged by its deepest
 * existing ancestor; an operation that acts on a link does not follow it, and
 * one whose contract follows a link follows only where that link lands inside
 * the attempt.
 *
 * ## A link's target is a Workspace path, not a host path
 *
 * A retained symbolic link carries its target as text, and that text is
 * interpreted in the Workspace it belongs to. An absolute target names the
 * logical Workspace root — the root of the tree this invocation owns — not the
 * runner host's root. Letting the kernel interpret `/etc/passwd` would turn a
 * retained Workspace entry into authority over the machine, so resolution is
 * done here, one segment at a time, and the host is asked only about paths that
 * are already known to be inside.
 *
 * The stable-host-namespace limitation the host provider documents applies here
 * too: another process can replace a directory between the moment this resolves
 * a path and the moment it uses one. That window is not what this closes.
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
import type { Stats } from "node:fs";
import { type Operation, until } from "effection";
import type {
  WorkspaceEntry,
  WorkspaceFilesystem,
  WorkspaceStat,
} from "../workspace/filesystem.ts";
import { throwWorkspaceFilesystemFailure } from "./workspace/errors.ts";
import type { HostPath } from "../remote/materialize.ts";

/** A path no Workspace operation may reach, whatever it names. */
export class WorkspacePathError extends Error {
  override name = "WorkspacePathError";

  constructor() {
    // No path, no target and no host directory: what a document may learn is
    // that it asked for somewhere it does not own.
    super("this Workspace path is outside the tree this invocation owns.");
  }
}

/** How many links one resolution will follow before calling it a loop. */
const MAX_LINKS = 32;

/**
 * The logical segments this path names, or `undefined` if it leaves the root.
 *
 * Pure arithmetic on POSIX segments, decided before anything touches the host.
 * `.` and an empty segment are nothing; a complete `..` pops, and popping past
 * the root is the escape. A segment that merely begins with two dots is an
 * ordinary name and stays.
 */
function segmentsOf(base: readonly string[], path: string): string[] | undefined {
  const segments = path.startsWith("/") ? [] : [...base];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** What one operation may act on: where it is, and whether a link was left alone. */
interface Resolved {
  readonly segments: readonly string[];
}

/**
 * Walk the path, following the links inside it, and refuse the ones that leave.
 *
 * `followFinal` is the difference between an operation about a file and an
 * operation about a link. A read follows the last link to the file it names,
 * because replacing or reporting the link would surprise a caller that asked
 * for the file; `lstat`, `readlink`, a removal and a rename act on the entry
 * the caller named, so the last segment is left exactly as written.
 *
 * A path that does not exist is not an error: the walk stops at the deepest
 * existing ancestor and keeps the rest, which is what lets a write name a file
 * it is about to create and still be judged.
 */
function* resolve(root: string, path: string, followFinal: boolean): Operation<Resolved> {
  if (path === "" || path.includes("\u0000")) {
    throw new WorkspacePathError();
  }
  const admitted = segmentsOf([], path);
  if (admitted === undefined) {
    throw new WorkspacePathError();
  }
  let segments: string[] = admitted;

  for (let followed = 0; ; followed += 1) {
    if (followed > MAX_LINKS) {
      throw new WorkspacePathError();
    }
    const crossing = yield* firstLink(root, segments, followFinal);
    if (crossing === undefined) {
      return { segments };
    }
    // The target is read in the Workspace this link belongs to: absolute means
    // the Workspace root, and relative means beside the link.
    const next = segmentsOf(segments.slice(0, crossing.depth - 1), crossing.target);
    if (next === undefined) {
      throw new WorkspacePathError();
    }
    segments = [...next, ...segments.slice(crossing.depth)];
  }
}

/**
 * The shallowest segment of this path that is a symbolic link, if any.
 *
 * Shallowest rather than any, because substituting a link's target changes
 * every segment beneath it — resolving a deeper one first would resolve it
 * against a prefix that is about to be replaced.
 */
function* firstLink(
  root: string,
  segments: readonly string[],
  followFinal: boolean,
): Operation<{ depth: number; target: string } | undefined> {
  const last = followFinal ? segments.length : segments.length - 1;
  for (let depth = 1; depth <= last; depth += 1) {
    const host = hostPath(root, segments.slice(0, depth));
    const entry: Stats | undefined = yield* describing(host);
    if (entry === undefined) {
      // Nothing here, so nothing below it exists either. What the caller named
      // is judged by the ancestor that does exist, which this walk has passed.
      return undefined;
    }
    if (entry.isSymbolicLink()) {
      return { depth, target: yield* until(readlink(host)) };
    }
  }
  return undefined;
}

/** What this entry is, or nothing when there is no entry here. */
function* describing(host: string): Operation<Stats | undefined> {
  try {
    return yield* until(lstat(host));
  } catch {
    return undefined;
  }
}

function hostPath(root: string, segments: readonly string[]): string {
  return segments.length === 0 ? root : `${root}/${segments.join("/")}`;
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
 * widening the classifier keeps one list of documented conditions. The
 * message and the host path inside it are dropped: what reaches a document is
 * the condition, never where this invocation happened to put its tree.
 */
function named(error: unknown): unknown {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  if (error instanceof Error && typeof code === "string") {
    const renamed = new Error(`the Workspace operation failed (${code})`);
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
  // through. Every host path this module builds is this root plus segments it
  // has already admitted, so no authored text reaches a syscall unexamined.
  const root = at("/");

  function* run<T>(
    path: string,
    followFinal: boolean,
    body: (host: string) => Promise<T>,
  ): Operation<T> {
    authorize();
    // Resolved immediately before the operation it authorizes, never cached: a
    // path admitted once is not a capability to use later.
    const resolved = yield* resolve(root, path, followFinal);
    try {
      return yield* until(body(hostPath(root, resolved.segments)));
    } catch (error) {
      // The same classification the Deno host applies: a documented filesystem
      // condition is the effect's own outcome, and everything else is the run
      // failing.
      return throwWorkspaceFilesystemFailure(named(error));
    }
  }

  /** Both ends of a two-path operation, each admitted at the time of use. */
  function* pair<T>(
    from: string,
    to: string,
    followFrom: boolean,
    body: (source: string, destination: string) => Promise<T>,
  ): Operation<T> {
    authorize();
    const source = yield* resolve(root, from, followFrom);
    const destination = yield* resolve(root, to, false);
    try {
      return yield* until(
        body(hostPath(root, source.segments), hostPath(root, destination.segments)),
      );
    } catch (error) {
      return throwWorkspaceFilesystemFailure(named(error));
    }
  }

  return {
    *readFile(path): Operation<Uint8Array> {
      return yield* run(path, true, (host) => readFile(host));
    },

    *readTextFile(path): Operation<string> {
      const bytes = yield* run(path, true, (host) => readFile(host));
      return new TextDecoder().decode(bytes);
    },

    *stat(path): Operation<WorkspaceStat> {
      return described(yield* run(path, true, (host) => stat(host)));
    },

    *lstat(path): Operation<WorkspaceStat> {
      // About the entry, so the last segment stays what it is.
      return described(yield* run(path, false, (host) => lstat(host)));
    },

    *readlink(path): Operation<string> {
      // The retained target, exactly as it was written. It is a Workspace path,
      // and reading it back is not resolving it.
      return yield* run(path, false, (host) => readlink(host));
    },

    *readdir(path): Operation<WorkspaceEntry[]> {
      const entries = yield* run(path, true, (host) => readdir(host, { withFileTypes: true }));
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "symlink",
      }));
    },

    *writeFile(path, content, mode): Operation<void> {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      // Follows an internal link to the file it names: replacing the link would
      // be the surprising outcome, and an outward one never got this far.
      yield* run(path, true, (host) => writeFile(host, bytes, mode === undefined ? {} : { mode }));
    },

    *mkdir(path, options = {}): Operation<void> {
      yield* run(path, true, (host) => mkdir(host, options).then(() => undefined));
    },

    *remove(path, options = {}): Operation<void> {
      // A removal takes the entry the caller named. Following a final link
      // would remove something never mentioned.
      yield* run(path, false, (host) => rm(host, options));
    },

    *rename(from, to): Operation<void> {
      yield* pair(from, to, false, (source, destination) => rename(source, destination));
    },

    *chmod(path, mode): Operation<void> {
      yield* run(path, true, (host) => chmod(host, mode));
    },

    *symlink(target, path): Operation<void> {
      // The target is not resolved: a link's target is retained text, and it is
      // interpreted when the link is walked. What is admitted here is where the
      // link itself is created.
      yield* run(path, false, (host) => symlink(target, host));
    },

    *link(existingPath, newPath): Operation<void> {
      yield* pair(existingPath, newPath, true, (source, destination) => link(source, destination));
    },
  };
}
