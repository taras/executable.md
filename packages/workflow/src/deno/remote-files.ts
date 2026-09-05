/**
 * The runner's own filesystem, as materialization needs to see it.
 *
 * `@effectionx/fs` covers the ordinary work but not the whole Workspace
 * contract: a retained root carries symbolic links, hardlink groups, modes and
 * modification times, and preserving those is what makes an untouched
 * materialization capture back to the root it came from. The operations it
 * lacks are adapted here from the runtime's own asynchronous primitives with
 * `until`, which is the sanctioned way to reach one — not by making production
 * code asynchronous and not by reaching for a synchronous call.
 *
 * `node:fs/promises` rather than a runtime global, because the same adapter has
 * to work wherever the runner runs. Nothing above this module names a runtime,
 * and nothing in this module decides anything about a Workspace: it moves bytes
 * and metadata where it is told, and the rules live in shared code.
 */

import {
  chmod,
  link,
  lstat,
  lchmod,
  lutimes,
  mkdir,
  readdir,
  readFile,
  mkdtemp,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensure, type Operation, resource, until } from "effection";
import type { RunnerFiles, RunnerNode } from "../remote/materialize.ts";
import type { TemporaryTrees } from "../remote/invocation.ts";

/**
 * Whole milliseconds, which is the unit a retained entry records.
 *
 * Not seconds. The Workspace format carries whatever the retaining host's clock
 * produced, and that clock is `Date.now`, so an adapter that reported seconds
 * would describe every retained tree as a different one — and setting a
 * millisecond value as though it were seconds would put the file tens of
 * thousands of years from now, where the filesystem cannot keep it.
 */
function milliseconds(value: number): number {
  return Math.round(value);
}

function describeStats(
  name: string,
  stats: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    mtimeMs: number;
    size: number;
    ino: number | bigint;
    nlink: number | bigint;
  },
  target: string | undefined,
): RunnerNode {
  const kind = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
  return {
    name,
    kind,
    // The permission bits only. The type bits are what `kind` already said, and
    // a retained mode that carried them would not round-trip through the
    // format's own bound.
    mode: stats.mode & 0o7777,
    mtime: milliseconds(stats.mtimeMs),
    size: kind === "file" ? stats.size : 0,
    // Only a file reached by more than one name can be part of a group, so
    // anything else reports no identity and is captured on its own.
    identity: kind === "file" && Number(stats.nlink) > 1 ? String(stats.ino) : undefined,
    target,
  };
}

/**
 * `lchmod`, when the platform actually has it.
 *
 * BSD-derived systems do; Linux does not, and Node exposes the export
 * regardless on some releases. Probing the export is the only honest test
 * available before a real call.
 */
function lchmodOf(): ((path: string, mode: number) => Operation<void>) | undefined {
  if (typeof lchmod !== "function") {
    return undefined;
  }
  return function* (path: string, mode: number): Operation<void> {
    yield* until(lchmod(path, mode));
  };
}

/** The runner's filesystem operations, for one materialized tree. */
export function runnerFiles(): RunnerFiles {
  return {
    *makeDirectory(path: string, mode: number): Operation<void> {
      yield* until(mkdir(path, { recursive: false, mode }));
    },

    *writeFile(path: string, bytes: Uint8Array, mode: number): Operation<void> {
      yield* until(writeFile(path, bytes, { mode }));
    },

    *makeSymlink(target: string, path: string): Operation<void> {
      yield* until(symlink(target, path));
    },

    *makeHardlink(existing: string, path: string): Operation<void> {
      yield* until(link(existing, path));
    },

    *setMode(path: string, mode: number): Operation<void> {
      // Explicit rather than relying on the creation mode, which the process
      // umask narrows. A retained mode is durable identity.
      yield* until(chmod(path, mode));
    },

    *setModifiedAt(path: string, mtime: number): Operation<void> {
      // `utimes` speaks seconds; the format speaks milliseconds.
      yield* until(utimes(path, mtime / 1000, mtime / 1000));
    },

    /**
     * A link's own time, set without following it.
     *
     * `lutimes` is what makes this possible at all: `utimes` would follow the
     * link and rewrite whatever it points at, which may be outside the tree
     * entirely.
     */
    *setLinkModifiedAt(path: string, mtime: number): Operation<void> {
      yield* until(lutimes(path, mtime / 1000, mtime / 1000));
    },

    /**
     * A link's own permissions, where the platform has them.
     *
     * Linux ignores symbolic-link permission bits and offers no `lchmod`, so
     * this is deliberately absent there rather than faked. Materialization
     * checks what it actually got and refuses a root this host cannot
     * represent, which is the honest outcome; quietly writing a different mode
     * would change durable identity.
     */
    setLinkMode: lchmodOf(),

    *readFile(path: string): Operation<Uint8Array> {
      return new Uint8Array(yield* until(readFile(path)));
    },

    *list(path: string): Operation<RunnerNode[]> {
      const names = yield* until(readdir(path));
      const found: RunnerNode[] = [];
      for (const name of names) {
        const entry = join(path, name);
        const stats = yield* until(lstat(entry));
        // Read, never resolved: what a retained link points at is part of the
        // Workspace's description of itself, not somewhere to go looking.
        const target: string | undefined = stats.isSymbolicLink()
          ? yield* until(readlink(entry))
          : undefined;
        found.push(describeStats(name, stats, target));
      }
      return found;
    },

    *describe(path: string): Operation<RunnerNode> {
      const stats = yield* until(lstat(path));
      return describeStats("", stats, undefined);
    },
  };
}

/**
 * Temporary trees for one invocation, owned by the scope that asked for them.
 *
 * Every tree this hands out is removed when that scope ends, however it ends.
 * A run that left one behind would leave a materialized Workspace on a machine
 * that has stopped being responsible for it.
 */
export function useRunnerTrees(): Operation<TemporaryTrees> {
  return resource(function* (provide) {
    const roots: string[] = [];
    yield* ensure(function* () {
      // In reverse, so a nested tree goes before whatever contains it.
      for (const root of roots.toReversed()) {
        yield* until(rm(root, { recursive: true, force: true }));
      }
    });
    yield* provide({
      *create(purpose: string): Operation<string> {
        const root = yield* until(mkdtemp(join(tmpdir(), `xmd-workflow-${purpose}-`)));
        roots.push(root);
        return root;
      },
      *remove(path: string): Operation<void> {
        yield* until(rm(path, { recursive: true, force: true }));
        const found = roots.indexOf(path);
        if (found >= 0) {
          roots.splice(found, 1);
        }
      },
    });
  });
}
