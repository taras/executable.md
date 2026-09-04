/**
 * Tier WRH — the two capture implementations describe one Workspace.
 *
 * The local host walks the DOFS tables inside its own SQLite file. The runner
 * walks a real directory. Neither walk can be shared, and a root identity is a
 * digest of what the walk produced — so if the two ever disagreed, a run would
 * change its Workspace by moving between hosts, and every no-op remote effect
 * would propose a root the local host had never seen.
 *
 * Nothing here is produced by the code under test. The fixture is built through
 * the authoritative Workspace transaction and captured by the local provider's
 * own `capture()`, exactly as a real run retains a root. That root is then
 * served over the remote read boundary, materialized by the production runner
 * adapter, and captured again by the runner's implementation. The two
 * identities have to be the same string.
 *
 * The tree is the discriminating one: two hardlink groups holding identical
 * bytes, two independent files holding identical bytes, an empty file, a
 * symbolic link, distinct modes and modification times, and a file large enough
 * to cross more than one chunk.
 */

import type { RemoteInvocationSnapshot } from "../src/remote/records.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { DatabaseSync } from "node:sqlite";
import { type Operation, scoped } from "effection";
import type { WorkflowRunDatabase } from "../mod.ts";
import { runnerFiles, useRunnerTrees } from "../src/deno/remote-files.ts";
import {
  type PrivateWorkspaceTransaction,
  transactWorkspaceRoots,
} from "../src/deno/workspace/private.ts";
import { captureWorkspace, materializeWorkspaceRoot } from "../src/remote/materialize.ts";
import type { RemoteContent, RemoteContentRequest, RemoteReadLink } from "../src/remote/read.ts";
import { parseWorkspaceRootManifest } from "../src/workspace/root-manifest.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";

function reject(reason: string): never {
  throw new Error(reason);
}

function* transact<T>(
  database: WorkflowRunDatabase,
  body: (workspace: PrivateWorkspaceTransaction) => Operation<T>,
): Operation<T> {
  const result = yield* transactWorkspaceRoots(database, body);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * The content one retained root closes over, read out of the run's own store.
 *
 * The owner would read these rows; here the test does, so what crosses the
 * remote read boundary is exactly what the local host retained rather than
 * anything the runner computed.
 */
function retainedContent(path: string): {
  manifests: Map<string, Uint8Array>;
  blobs: Map<string, Uint8Array>;
} {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const manifests = new Map<string, Uint8Array>();
    for (const row of database.prepare("SELECT hash, encoded FROM vfs_manifests").all()) {
      manifests.set(hex(row["hash"]), bytes(row["encoded"]));
    }
    const blobs = new Map<string, Uint8Array>();
    for (const row of database.prepare("SELECT hash, bytes FROM vfs_blob_bytes").all()) {
      blobs.set(hex(row["hash"]), bytes(row["bytes"]));
    }
    return { manifests, blobs };
  } finally {
    database.close();
  }
}

function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("expected retained content to be bytes");
  }
  return value;
}

function hex(value: unknown): string {
  return Array.from(bytes(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The retained root and its content, served the way an owner serves them. */
function servedBy(
  manifest: string,
  rootId: string,
  content: { manifests: Map<string, Uint8Array>; blobs: Map<string, Uint8Array> },
): RemoteReadLink {
  return {
    // Materialization never asks for this; a stub that answered would say this
    // test proved something it did not.
    *invocationSnapshot(): Operation<RemoteInvocationSnapshot> {
      throw new Error("this read link carries no invocation snapshot");
    },
    // deno-lint-ignore require-yield
    *frontier(): Operation<never> {
      throw new Error("this owner serves only a root and its content");
    },
    // deno-lint-ignore require-yield
    *root(workspaceRootId: string) {
      if (workspaceRootId !== rootId) {
        throw new Error("asked for a root this owner does not hold");
      }
      return parseWorkspaceRootManifest(manifest, reject);
    },
    // deno-lint-ignore require-yield
    *content(_rootId: string, request: RemoteContentRequest): Operation<RemoteContent> {
      const found =
        request.kind === "manifest"
          ? content.manifests.get(request.digest)
          : content.blobs.get(request.digest);
      if (found === undefined) {
        throw new Error(`the run retains no ${request.kind} ${request.digest}`);
      }
      return { kind: request.kind, digest: request.digest, bytes: found };
    },
  };
}

/** Everything the format carries, written through the authoritative surface. */
function* buildWorkspace(workspace: PrivateWorkspaceTransaction): Operation<void> {
  const files = workspace.filesystem;
  yield* files.mkdir("/docs", { mode: 0o755 });
  yield* files.mkdir("/docs/deep", { mode: 0o700 });
  yield* files.writeFile("/README.md", "a workspace\n", 0o644);
  yield* files.writeFile("/empty", new Uint8Array(0), 0o600);
  yield* files.writeFile("/docs/guide.md", "# guide\n", 0o644);
  // Larger than one chunk, so its manifest names more than one piece.
  yield* files.writeFile("/docs/deep/large.bin", new Uint8Array(700 * 1024).fill(7), 0o644);
  yield* files.symlink("../README.md", "/docs/link");

  // Two hardlink groups holding identical bytes: one manifest, two files.
  yield* files.writeFile("/shared-a", "shared bytes\n", 0o644);
  yield* files.link("/shared-a", "/shared-b");
  yield* files.writeFile("/other-a", "shared bytes\n", 0o644);
  yield* files.link("/other-a", "/other-b");

  // Two independent files holding identical bytes, which stay independent.
  yield* files.writeFile("/loose-a", "loose bytes\n", 0o644);
  yield* files.writeFile("/loose-b", "loose bytes\n", 0o644);

  // A mode a umask would narrow if a creation mode were trusted.
  yield* files.writeFile("/group-writable", "wide\n", 0o666);
  yield* files.mkdir("/wide-dir", { mode: 0o777 });
}

describe("a root the local host retained", () => {
  it("materializes and recaptures to the same identity on the runner", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const retained = yield* transact(database, function* (workspace) {
        yield* buildWorkspace(workspace);
        return yield* workspace.capture({ publish: true });
      });

      // The fixture is the local provider's own capture, not the runner's.
      const entries = parseWorkspaceRootManifest(retained.manifest, reject).entries;
      const linked = entries.filter((entry) => entry.kind === "file" && entry.hardlink !== null);
      expect(linked).toHaveLength(4);
      expect(new Set(linked.map((entry) => (entry.kind === "file" ? entry.hardlink : "")))).toEqual(
        new Set(["h0", "h1"]),
      );
      expect(entries.some((entry) => entry.kind === "symlink")).toBe(true);
      expect(entries.some((entry) => entry.kind === "file" && entry.size === 0)).toBe(true);

      const content = retainedContent(runPath(root, database.record.runId));
      const reads = servedBy(retained.manifest, retained.rootId, content);

      yield* scoped(function* () {
        const files = runnerFiles();
        const trees = yield* useRunnerTrees();
        const tree = yield* trees.create("interoperability");
        const at = (logical: string) => (logical === "/" ? tree : `${tree}${logical}`);

        yield* materializeWorkspaceRoot(files, reads, at, retained.rootId, reject);
        const recaptured = yield* captureWorkspace(files, at, reject);

        // One Workspace, two implementations, one identity.
        expect(recaptured.root.rootId).toBe(retained.rootId);
        expect(recaptured.root.manifest).toBe(retained.manifest);
        expect([...recaptured.root.manifests]).toEqual([...retained.manifestHashes]);
        expect([...recaptured.root.blobs]).toEqual([...retained.blobHashes]);
      });
    });
  });
});
