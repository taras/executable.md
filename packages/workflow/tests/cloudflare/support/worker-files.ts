/**
 * A filesystem for the runner half, inside the worker.
 *
 * The owner in these tests is real: a real Durable Object, real SQLite, a real
 * accepted WebSocket, and the production client and coordinator on the other
 * end of it. The runner's *host filesystem* cannot be. workerd has no native
 * filesystem, and the vendored DOFS cannot set a modification time — so it
 * cannot reproduce a retained mtime, which is exactly what materialization
 * refuses a host for.
 *
 * So this stands in for the one thing the runtime cannot provide, and nothing
 * else. It is not a model of the owner, and it is not a model of the
 * coordinator: it stores modes, whole-second times, symbolic links and hardlink
 * identity the way a filesystem does, and the production
 * `materializeWorkspaceRoot`, `captureWorkspace` and coordinator run against it
 * unchanged. The native adapter this stands in for is proved against real files
 * in `packages/workflow/tests/remote-workspace-files.test.ts`.
 */

import { type Operation } from "effection";
import type { RunnerFiles, RunnerNode } from "../../../src/remote/materialize.ts";
import type { TemporaryTrees } from "../../../src/remote/invocation.ts";
import type {
  WorkspaceEntry,
  WorkspaceFilesystem,
  WorkspaceStat,
} from "../../../src/workspace/filesystem.ts";

/** One file's bytes, shared by every path hardlinked to it. */
interface Content {
  bytes: Uint8Array;
  readonly identity: string;
}

interface Node {
  kind: "directory" | "file" | "symlink";
  mode: number;
  mtime: number;
  content?: Content;
  target?: string;
}

function failure(code: string): Error {
  const error = new Error(`the Workspace operation failed (${code})`);
  error.name = "WorkspaceFsError";
  Reflect.set(error, "code", code);
  return error;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

/** One tree, addressed by absolute path. */
export function createWorkerFiles(): {
  files: RunnerFiles;
  trees: TemporaryTrees;
  workspace(root: string): WorkspaceFilesystem;
} {
  // The tree's own root exists from the start, the way a filesystem's does.
  const nodes = new Map<string, Node>([["/", { kind: "directory", mode: 0o755, mtime: 0 }]]);
  let identities = 0;
  let roots = 0;
  let clock = 1_700_000_000;

  function node(path: string): Node {
    const found = nodes.get(path);
    if (found === undefined) {
      throw failure("ENOENT");
    }
    return found;
  }

  function requireParent(path: string): void {
    const parent = nodes.get(parentOf(path));
    if (parent === undefined || parent.kind !== "directory") {
      throw failure("ENOENT");
    }
  }

  function children(path: string): string[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    return [...nodes.keys()].filter(
      (candidate) =>
        candidate !== path &&
        candidate.startsWith(prefix) &&
        !candidate.slice(prefix.length).includes("/"),
    );
  }

  function describe(path: string, name: string): RunnerNode {
    const held = node(path);
    return {
      name,
      kind: held.kind,
      mode: held.mode,
      mtime: held.mtime,
      size: held.content?.bytes.length ?? held.target?.length ?? 0,
      identity: held.content?.identity,
      target: held.target,
    };
  }

  function nameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  const files: RunnerFiles = {
    // deno-lint-ignore require-yield
    *makeDirectory(path, mode): Operation<void> {
      if (nodes.has(path)) {
        throw failure("EEXIST");
      }
      if (path !== "/") {
        requireParent(path);
      }
      nodes.set(path, { kind: "directory", mode, mtime: (clock += 1) });
    },

    // deno-lint-ignore require-yield
    *writeFile(path, bytes, mode): Operation<void> {
      requireParent(path);
      identities += 1;
      nodes.set(path, {
        kind: "file",
        mode,
        mtime: (clock += 1),
        content: { bytes: new Uint8Array(bytes), identity: `content-${identities}` },
      });
    },

    // deno-lint-ignore require-yield
    *makeSymlink(target, path): Operation<void> {
      requireParent(path);
      nodes.set(path, { kind: "symlink", mode: 0o777, mtime: (clock += 1), target });
    },

    // deno-lint-ignore require-yield
    *makeHardlink(existing, path): Operation<void> {
      requireParent(path);
      const source = node(existing);
      if (source.content === undefined) {
        throw failure("EPERM");
      }
      // The same content, so both paths are one file and capture sees it.
      nodes.set(path, {
        kind: "file",
        mode: source.mode,
        mtime: source.mtime,
        content: source.content,
      });
    },

    // deno-lint-ignore require-yield
    *setMode(path, mode): Operation<void> {
      node(path).mode = mode;
    },

    // deno-lint-ignore require-yield
    *setModifiedAt(path, mtime): Operation<void> {
      node(path).mtime = mtime;
    },

    setLinkModifiedAt: function* (path, mtime): Operation<void> {
      node(path).mtime = mtime;
    },

    setLinkMode: function* (path, mode): Operation<void> {
      node(path).mode = mode;
    },

    // deno-lint-ignore require-yield
    *readFile(path): Operation<Uint8Array> {
      const held = node(path);
      if (held.content === undefined) {
        throw failure("EISDIR");
      }
      return new Uint8Array(held.content.bytes);
    },

    // deno-lint-ignore require-yield
    *list(path): Operation<RunnerNode[]> {
      const held = node(path);
      if (held.kind !== "directory") {
        throw failure("ENOTDIR");
      }
      return children(path).map((child) => describe(child, nameOf(child)));
    },

    // deno-lint-ignore require-yield
    *describe(path): Operation<RunnerNode> {
      return describe(path, nameOf(path));
    },
  };

  const trees: TemporaryTrees = {
    *create(purpose): Operation<string> {
      roots += 1;
      const root = `/${purpose}-${roots}`;
      yield* files.makeDirectory(root, 0o755);
      return root;
    },

    // deno-lint-ignore require-yield
    *remove(path): Operation<void> {
      for (const candidate of [...nodes.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) {
          nodes.delete(candidate);
        }
      }
    },
  };

  /**
   * The Workspace filesystem over one tree in it.
   *
   * Containment is the native adapter's subject and is proved there; what this
   * needs to be is a filesystem the coordinator can really change, so a commit
   * carries bytes a document actually wrote.
   */
  function workspace(root: string): WorkspaceFilesystem {
    const at = (logical: string) => (logical === "/" ? root : `${root}${logical}`);
    function stat(path: string): WorkspaceStat {
      const held = node(path);
      return {
        kind: held.kind,
        mode: held.mode,
        mtime: held.mtime,
        size: held.content?.bytes.length ?? 0,
      };
    }
    return {
      *readFile(path): Operation<Uint8Array> {
        return yield* files.readFile(at(path));
      },
      *readTextFile(path): Operation<string> {
        return new TextDecoder().decode(yield* files.readFile(at(path)));
      },
      // deno-lint-ignore require-yield
      *stat(path): Operation<WorkspaceStat> {
        return stat(at(path));
      },
      // deno-lint-ignore require-yield
      *lstat(path): Operation<WorkspaceStat> {
        return stat(at(path));
      },
      // deno-lint-ignore require-yield
      *readlink(path): Operation<string> {
        const target = node(at(path)).target;
        if (target === undefined) {
          throw failure("EINVAL");
        }
        return target;
      },
      // deno-lint-ignore require-yield
      *readdir(path): Operation<WorkspaceEntry[]> {
        return children(at(path)).map((child) => ({
          name: nameOf(child),
          kind: node(child).kind,
        }));
      },
      *writeFile(path, content, mode): Operation<void> {
        const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
        yield* files.writeFile(at(path), bytes, mode ?? 0o644);
      },
      *mkdir(path, options = {}): Operation<void> {
        yield* files.makeDirectory(at(path), options.mode ?? 0o755);
      },
      *remove(path): Operation<void> {
        yield* trees.remove(at(path));
      },
      // deno-lint-ignore require-yield
      *rename(from, to): Operation<void> {
        const held = node(at(from));
        nodes.delete(at(from));
        nodes.set(at(to), held);
      },
      // deno-lint-ignore require-yield
      *chmod(path, mode): Operation<void> {
        node(at(path)).mode = mode;
      },
      *symlink(target, path): Operation<void> {
        yield* files.makeSymlink(target, at(path));
      },
      *link(existing, path): Operation<void> {
        yield* files.makeHardlink(at(existing), at(path));
      },
    };
  }

  return { files, trees, workspace };
}
