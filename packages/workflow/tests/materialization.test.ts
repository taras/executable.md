/**
 * Tier WF — moving a checkout between the Workspace and a place Git can run.
 *
 * The Workspace is a database and native Git is a program that reads
 * directories, so every native operation happens in a disposable host tree
 * exported from one. Everything the rest of #293 claims rests on that export
 * being a faithful copy of what the database holds, and on it staying inside
 * the directory this provider owns.
 *
 * These drive the exporter directly rather than through a component, because
 * the properties are the exporter's own and no component exists to reach them
 * yet. A path that arrives from a retained row is not this provider's word by
 * the time it is read back, which is why containment is proven from the string
 * rather than from what the filesystem resolved.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { exists } from "@effectionx/fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensure, resource, until } from "effection";
import { RepositoryStaleStateError } from "../src/composition/errors.ts";
import { exportTree, importTree } from "../src/deno/composition/materialize.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";

/** A host directory that exists for the test that asked for it. */
function useHostRoot(): Operation<string> {
  return resource<string>(function* (provide) {
    const created = yield* until(mkdtemp(join(tmpdir(), "xmd-materialization-")));
    yield* ensure(function* () {
      yield* until(rm(created, { recursive: true, force: true }));
    });
    // The resolved path, as the provider's own host resource returns: `/var` on
    // macOS is `/private/var`, and the containment proof compares exact strings.
    yield* provide(yield* until(realpath(created)));
  });
}

/** What an operation threw, so a suite can assert on it rather than fail. */
function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("workflow Workspace materialization", () => {
  it("refuses to join a traversal-shaped retained path to a host root", function* () {
    const root = yield* useStorageRoot();
    const host = yield* useHostRoot();
    const escaped = join(host, "..", "escaped-by-traversal");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const attempted = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* raised(
          exportTree(workspace.filesystem, host, "/../../etc", "a retained checkout"),
        );
      });
      expect(attempted.ok).toBe(true);
      expect(attempted.ok && attempted.value).toBeInstanceOf(RepositoryStaleStateError);

      // Refused from the string, before anything was created outside the root.
      expect(yield* exists(escaped)).toBe(false);
    });
  });

  it("refuses a retained path that is not absolute", function* () {
    const root = yield* useStorageRoot();
    const host = yield* useHostRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const attempted = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* raised(
          exportTree(workspace.filesystem, host, "relative/checkout", "a retained checkout"),
        );
      });
      expect(attempted.ok && attempted.value).toBeInstanceOf(RepositoryStaleStateError);
    });
  });

  it("refuses to delete a Workspace subtree a malformed path names", function* () {
    const root = yield* useStorageRoot();
    const host = yield* useHostRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // `importTree` proves its path before the removal it would otherwise
      // perform, so a malformed one is refused rather than acted on first.
      const attempted = yield* transactWorkspaceRoots(database, function* (workspace) {
        yield* workspace.filesystem.mkdir("/kept", { recursive: true });
        yield* workspace.filesystem.writeFile("/kept/file.txt", "still here");
        const failure = yield* raised(importTree(workspace.filesystem, host, "/kept/../kept"));
        const kept = yield* workspace.filesystem.readTextFile("/kept/file.txt");
        const captured = yield* workspace.capture();
        yield* workspace.publish(captured.rootId);
        return { failure, kept };
      });
      if (!attempted.ok) {
        throw attempted.error;
      }
      expect(attempted.value.failure).toBeInstanceOf(RepositoryStaleStateError);
      expect(attempted.value.kept).toBe("still here");
    });
  });

  it("carries bytes, modes and symbolic links out and back unchanged", function* () {
    const root = yield* useStorageRoot();
    const host = yield* useHostRoot();
    const binary = new Uint8Array([0, 1, 2, 250, 251, 252, 0]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const carried = yield* transactWorkspaceRoots(database, function* (workspace) {
        const files = workspace.filesystem;
        yield* files.mkdir("/tree/nested", { recursive: true });
        yield* files.writeFile("/tree/text.txt", "plain\n");
        yield* files.writeFile("/tree/blob.bin", binary);
        yield* files.writeFile("/tree/tool.sh", "#!/bin/sh\n", 0o755);
        yield* files.symlink("text.txt", "/tree/link.txt");
        yield* files.symlink("/outside/the/workspace", "/tree/escaping.txt");

        // Out to the host, then back over a Workspace path of its own.
        yield* exportTree(files, host, "/tree", "a retained checkout");
        yield* files.remove("/tree", { recursive: true, force: true });
        yield* importTree(files, host, "/tree");

        const observed = {
          text: yield* files.readTextFile("/tree/text.txt"),
          blob: yield* files.readFile("/tree/blob.bin"),
          tool: (yield* files.lstat("/tree/tool.sh")).mode & 0o111,
          link: yield* files.readlink("/tree/link.txt"),
          escaping: yield* files.readlink("/tree/escaping.txt"),
        };
        const captured = yield* workspace.capture();
        yield* workspace.publish(captured.rootId);
        return observed;
      });
      if (!carried.ok) {
        throw carried.error;
      }

      expect(carried.value.text).toBe("plain\n");
      expect(carried.value.blob).toEqual(binary);
      expect(carried.value.tool).not.toBe(0);
      // A tracked link is content: retained as its target, never resolved,
      // including one whose target leaves the Workspace entirely.
      expect(carried.value.link).toBe("text.txt");
      expect(carried.value.escaping).toBe("/outside/the/workspace");
    });
  });

  it("refuses a checkout root that is not a real directory", function* () {
    const root = yield* useStorageRoot();
    const host = yield* useHostRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const attempted = yield* transactWorkspaceRoots(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/not-a-checkout", "a file");
        const failure = yield* raised(
          exportTree(workspace.filesystem, host, "/not-a-checkout", "a retained checkout"),
        );
        const captured = yield* workspace.capture();
        yield* workspace.publish(captured.rootId);
        return failure;
      });
      expect(attempted.ok && attempted.value).toBeInstanceOf(RepositoryStaleStateError);
      expect(String(attempted.ok && attempted.value)).toContain("is not a directory");
    });
  });
});
