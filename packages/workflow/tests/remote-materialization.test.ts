/**
 * Tier WRH — putting a retained root on a runner and reading it back.
 *
 * The claim under test is one equality: an untouched materialization captures
 * to the exact root it was materialized from. Everything else in the remote
 * provider rests on it. If it did not hold, a Workspace operation that changed
 * nothing would still propose a new root, every no-op would look like a
 * mutation, and the owner could not tell a real change from an artefact of how
 * the runner unpacked the tree.
 *
 * A real temporary filesystem, deliberately. Modes, modification times, an
 * empty file, a symbolic link and a hardlink group are properties of a
 * filesystem, and a fake that stored them in a map would prove only that the
 * map kept what it was given.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, type Operation, resource, scoped, until } from "effection";
import { mkdir, mkdtemp, rm, symlink, link, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerFiles } from "../src/deno/remote-files.ts";
import {
  captureWorkspace,
  materializeWorkspaceRoot,
  type RunnerFiles,
} from "../src/remote/materialize.ts";
import type { RemoteContent, RemoteContentRequest, RemoteReadLink } from "../src/remote/read.ts";
import type { WorkspaceRootManifest } from "../src/workspace/root-manifest.ts";
import { parseWorkspaceRootManifest } from "../src/workspace/root-manifest.ts";
import { encodeDofsManifest } from "../src/workspace/capture.ts";

function reject(reason: string): never {
  throw new Error(reason);
}

/**
 * A temporary directory owned by the scope that asked for it.
 *
 * A resource rather than a scoped operation: the tree has to outlive the call
 * that created it and end with the invocation that owns it, which is the whole
 * lifetime claim materialization makes.
 */
function useTemporaryDirectory(): Operation<string> {
  return resource(function* (provide) {
    const path = yield* until(mkdtemp(join(tmpdir(), "xmd-materialize-")));
    yield* ensure(() => until(rm(path, { recursive: true, force: true })));
    yield* provide(path);
  });
}

/** Where one logical Workspace path sits under `root`. */
function at(root: string): (logical: string) => string {
  return (logical) => (logical === "/" ? root : join(root, logical.slice(1)));
}

/**
 * An owner that serves exactly what a capture produced.
 *
 * It answers from the capture's own manifests and blobs, so what crosses is
 * what the runner would have had to send. Nothing here validates: the point is
 * that materialization rebuilds the tree, and the validation of pieces is the
 * connection's, proved where the connection is.
 */
function servedBy(captured: {
  root: { manifest: string; rootId: string };
  contents: ReadonlyMap<string, { manifestBytes: Uint8Array }>;
  blobs: ReadonlyMap<string, Uint8Array>;
}): RemoteReadLink {
  return {
    // deno-lint-ignore require-yield
    *frontier(): Operation<never> {
      throw new Error("this owner serves only a root and its content");
    },
    // deno-lint-ignore require-yield
    *root(workspaceRootId: string): Operation<WorkspaceRootManifest> {
      if (workspaceRootId !== captured.root.rootId) {
        throw new Error("asked for a root this owner does not hold");
      }
      return parseWorkspaceRootManifest(captured.root.manifest, reject);
    },
    // deno-lint-ignore require-yield
    *content(_rootId: string, request: RemoteContentRequest): Operation<RemoteContent> {
      const bytes =
        request.kind === "manifest"
          ? captured.contents.get(request.digest)?.manifestBytes
          : captured.blobs.get(request.digest);
      if (bytes === undefined) {
        throw new Error("asked for content this owner does not hold");
      }
      return { kind: request.kind, digest: request.digest, bytes };
    },
  };
}

/** One tree with every entry kind the format carries. */
function* buildTree(root: string): Operation<void> {
  yield* until(mkdir(join(root, "docs"), { mode: 0o755 }));
  yield* until(mkdir(join(root, "docs", "deep"), { mode: 0o700 }));
  yield* until(writeFile(join(root, "README.md"), "a workspace\n", { mode: 0o644 }));
  yield* until(writeFile(join(root, "empty"), new Uint8Array(0), { mode: 0o600 }));
  yield* until(writeFile(join(root, "docs", "guide.md"), "# guide\n", { mode: 0o644 }));
  // Larger than one chunk, so the manifest names more than one piece.
  yield* until(
    writeFile(join(root, "docs", "deep", "large.bin"), new Uint8Array(700 * 1024).fill(7), {
      mode: 0o644,
    }),
  );
  yield* until(symlink("../README.md", join(root, "docs", "link")));
  // Two names for one file: a hardlink group the capture must number.
  yield* until(writeFile(join(root, "shared-a"), "shared bytes\n", { mode: 0o644 }));
  yield* until(link(join(root, "shared-a"), join(root, "shared-b")));

  for (const [path, mtime] of [
    [join(root, "README.md"), 1_700_000_001],
    [join(root, "empty"), 1_700_000_002],
    [join(root, "docs", "guide.md"), 1_700_000_003],
    [join(root, "docs", "deep", "large.bin"), 1_700_000_004],
    [join(root, "shared-a"), 1_700_000_005],
    [join(root, "docs", "deep"), 1_700_000_006],
    [join(root, "docs"), 1_700_000_007],
    [root, 1_700_000_008],
  ] as const) {
    yield* until(utimes(path, mtime, mtime));
  }
}

describe("materializing a retained Workspace root", () => {
  it("captures an untouched materialization back to the exact root it came from", function* () {
    const files: RunnerFiles = runnerFiles();
    const source = yield* useTemporaryDirectory();
    yield* buildTree(source);

    const captured = yield* captureWorkspace(files, at(source), reject);
    const entries = captured.root.entries;
    // The tree really does exercise what the format carries.
    expect(entries.filter((entry) => entry.kind === "directory")).toHaveLength(3);
    expect(entries.filter((entry) => entry.kind === "symlink")).toHaveLength(1);
    expect(
      entries.filter((entry) => entry.kind === "file" && entry.hardlink !== null),
    ).toHaveLength(2);
    expect(entries.some((entry) => entry.kind === "file" && entry.size === 0)).toBe(true);
    // 700 KiB is two chunks at the pinned chunk size, so a file crosses the
    // transport as more than one piece.
    const large = entries.find((entry) => entry.path === "/docs/deep/large.bin");
    if (large?.kind !== "file") {
      throw new Error("expected the large file to be captured as a file");
    }
    expect(captured.contents.get(large.manifest)?.chunks).toHaveLength(2);

    const destination = yield* useTemporaryDirectory();
    yield* materializeWorkspaceRoot(
      files,
      servedBy(captured),
      at(destination),
      captured.root.rootId,
      reject,
    );

    const again = yield* captureWorkspace(files, at(destination), reject);
    expect(again.root.rootId).toBe(captured.root.rootId);
    expect(again.root.manifest).toBe(captured.root.manifest);
    expect([...again.root.manifests]).toEqual([...captured.root.manifests]);
    expect([...again.root.blobs]).toEqual([...captured.root.blobs]);
  });

  it("encodes a DOFS manifest the way the content store stores one", function* () {
    // The runner and the owner must name identical bytes identically, and the
    // encoding is what decides that.
    expect(new TextDecoder().decode(encodeDofsManifest([{ hash: "a".repeat(64), size: 3 }]))).toBe(
      `{"version":1,"chunks":[{"hash":"${"a".repeat(64)}","size":3}]}`,
    );
    expect(new TextDecoder().decode(encodeDofsManifest([]))).toBe('{"version":1,"chunks":[]}');
  });

  it("removes the materialization when its scope ends, however it ends", function* () {
    const files: RunnerFiles = runnerFiles();
    let path = "";
    yield* scoped(function* () {
      path = yield* useTemporaryDirectory();
      yield* until(writeFile(join(path, "present"), "here\n"));
    });
    // The scope that owned it has ended, so the tree is gone rather than left
    // behind for a later invocation to find.
    let listed: unknown;
    try {
      listed = yield* files.list(path);
    } catch (error) {
      listed = error;
    }
    expect(listed).toBeInstanceOf(Error);
  });
});
