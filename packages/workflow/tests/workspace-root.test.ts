import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation } from "effection";
import type { WorkflowRunDatabase } from "../mod.ts";
import { workflowRunConnection } from "../src/deno/database.ts";
import {
  EMPTY_WORKSPACE_MANIFEST,
  EMPTY_WORKSPACE_ROOT_ID,
  type StoredWorkspaceRoot,
  WORKSPACE_ROOT_DOMAIN,
} from "../src/deno/workspace/manifest.ts";
import {
  type PrivateWorkspaceTransaction,
  setPrivateWorkspaceClock,
  transactWorkspaceRoots,
} from "../src/deno/workspace/private.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";

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

function* capture(
  database: WorkflowRunDatabase,
  body: (workspace: PrivateWorkspaceTransaction) => Operation<void>,
): Operation<StoredWorkspaceRoot> {
  return yield* transact(database, function* (workspace) {
    yield* body(workspace);
    return yield* workspace.capture({ publish: true });
  });
}

function parseRoot(root: StoredWorkspaceRoot): {
  format: number;
  entries: Array<Record<string, unknown>>;
} {
  return JSON.parse(root.manifest);
}

describe("Tier WRR — immutable retained Workspace roots", () => {
  it("WRR1: the canonical empty root remains byte-for-byte compatible with schema v1", function* () {
    const storage = yield* useStorageRoot();

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const observed = yield* transact(database, function* (workspace) {
        expect(yield* workspace.currentRoot()).toBe(EMPTY_WORKSPACE_ROOT_ID);
        return yield* workspace.capture({ publish: true });
      });

      expect(observed.rootId).toBe(EMPTY_WORKSPACE_ROOT_ID);
      expect(observed.manifest).toBe(EMPTY_WORKSPACE_MANIFEST);
      expect(observed.manifestHashes).toEqual([]);
      expect(observed.blobHashes).toEqual([]);
    });

    const sqlite = new DatabaseSync(runPath(storage, "release-1.4"));
    try {
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_roots").get()?.["count"]).toBe(
        1,
      );
      expect(WORKSPACE_ROOT_DOMAIN).toBe("xmd-workspace-root\0v1\0");
    } finally {
      sqlite.close();
    }
  });

  it("WRR2: complete topology is canonical, content-addressed, and idempotently retained", function* () {
    const storage = yield* useStorageRoot();
    let first: StoredWorkspaceRoot | undefined;
    let independentlyBuilt: StoredWorkspaceRoot | undefined;

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "canonical-a" });
      setPrivateWorkspaceClock(database, () => 1_700_000_000_000);
      first = yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.mkdir("/tree", { mode: 0o750 });
        yield* workspace.filesystem.mkdir("/tree/nested", { mode: 0o700 });
        yield* workspace.filesystem.writeFile(
          "/tree/nested/file.txt",
          "retained-only-in-dofs-blobs",
          0o640,
        );
        workflowRunConnection(database)
          .database.prepare("UPDATE vfs_nodes SET manifest_hash = NULL WHERE type = 'file'")
          .run();
        yield* workspace.filesystem.link("/tree/nested/file.txt", "/tree/hardlink.txt");
        yield* workspace.filesystem.symlink("nested/file.txt", "/tree/current.txt");
      });

      const repeated = yield* transact(database, function* (workspace) {
        return yield* workspace.capture({ publish: true });
      });
      expect(repeated).toEqual(first);

      const other = yield* createRun({ runId: "canonical-b" });
      setPrivateWorkspaceClock(other, () => 1_700_000_000_000);
      independentlyBuilt = yield* capture(other, function* (workspace) {
        yield* workspace.filesystem.mkdir("/tree", { mode: 0o750 });
        yield* workspace.filesystem.mkdir("/tree/nested", { mode: 0o700 });
        yield* workspace.filesystem.writeFile(
          "/tree/nested/file.txt",
          "retained-only-in-dofs-blobs",
          0o640,
        );
        yield* workspace.filesystem.link("/tree/nested/file.txt", "/tree/hardlink.txt");
        yield* workspace.filesystem.symlink("nested/file.txt", "/tree/current.txt");
      });
    });

    if (first === undefined || independentlyBuilt === undefined) {
      throw new Error("the canonical roots were not captured");
    }
    expect(independentlyBuilt.rootId).toBe(first.rootId);
    expect(independentlyBuilt.manifest).toBe(first.manifest);
    const parsed = parseRoot(first);
    expect(parsed).toEqual({
      format: 1,
      entries: [
        { path: "/", kind: "directory", mode: 0o755, mtime: 0 },
        { path: "/tree", kind: "directory", mode: 0o750, mtime: 1_700_000_000_000 },
        {
          path: "/tree/current.txt",
          kind: "symlink",
          mode: 0o777,
          mtime: 1_700_000_000_000,
          target: "nested/file.txt",
        },
        {
          path: "/tree/hardlink.txt",
          kind: "file",
          mode: 0o640,
          mtime: 1_700_000_000_000,
          size: 27,
          manifest: first.manifestHashes[0],
          hardlink: "h0",
        },
        {
          path: "/tree/nested",
          kind: "directory",
          mode: 0o700,
          mtime: 1_700_000_000_000,
        },
        {
          path: "/tree/nested/file.txt",
          kind: "file",
          mode: 0o640,
          mtime: 1_700_000_000_000,
          size: 27,
          manifest: first.manifestHashes[0],
          hardlink: "h0",
        },
      ],
    });
    expect(first.manifest).not.toContain("retained-only-in-dofs-blobs");

    const sqlite = new DatabaseSync(runPath(storage, "canonical-a"));
    try {
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_roots").get()?.["count"]).toBe(
        2,
      );
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_root_manifest_refs").get()?.[
          "count"
        ],
      ).toBe(1);
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_root_blob_refs").get()?.["count"],
      ).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM vfs_blob_bytes").get()?.["count"]).toBe(
        1,
      );
    } finally {
      sqlite.close();
    }
  });

  it("WRR3: every observable mutation produces the corresponding immutable root", function* () {
    const storage = yield* useStorageRoot();
    const roots: StoredWorkspaceRoot[] = [];

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "root-sequence" });
      let time = 100;
      setPrivateWorkspaceClock(database, () => time);

      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.mkdir("/dir", { mode: 0o750 });
          yield* workspace.filesystem.writeFile("/dir/file.txt", "first", 0o640);
          yield* workspace.filesystem.writeFile("/delete.txt", "delete-me", 0o600);
          yield* workspace.filesystem.link("/dir/file.txt", "/hardlink.txt");
          yield* workspace.filesystem.symlink("/dir/file.txt", "/current");
        }),
      );

      time += 1;
      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.writeFile("/dir/file.txt", "second", 0o640);
        }),
      );
      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.remove("/delete.txt");
        }),
      );
      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.rename("/dir/file.txt", "/renamed.txt");
        }),
      );
      time += 1;
      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.mkdir("/later", { mode: 0o700 });
        }),
      );
      time += 1;
      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.chmod("/renamed.txt", 0o600);
        }),
      );
      time += 1;
      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.remove("/current");
          yield* workspace.filesystem.symlink("/renamed.txt", "/current");
        }),
      );
      roots.push(
        yield* capture(database, function* (workspace) {
          yield* workspace.filesystem.remove("/hardlink.txt");
        }),
      );

      const repeated = yield* transact(database, function* (workspace) {
        return yield* workspace.capture({ publish: true });
      });
      expect(repeated.rootId).toBe(roots.at(-1)?.rootId);
    });

    expect(new Set(roots.map((root) => root.rootId)).size).toBe(roots.length);
    const final = roots.at(-1);
    if (final === undefined) {
      throw new Error("the final root was not captured");
    }
    const entries = parseRoot(final).entries;
    expect(entries.map((entry) => entry.path)).toEqual([
      "/",
      "/current",
      "/dir",
      "/later",
      "/renamed.txt",
    ]);
    expect(entries.find((entry) => entry.path === "/current")).toEqual({
      path: "/current",
      kind: "symlink",
      mode: 0o777,
      mtime: 104,
      target: "/renamed.txt",
    });
    expect(entries.find((entry) => entry.path === "/renamed.txt")?.["mode"]).toBe(0o600);
    expect(entries.find((entry) => entry.path === "/renamed.txt")?.["hardlink"]).toBe(null);

    const sqlite = new DatabaseSync(runPath(storage, "root-sequence"));
    try {
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_roots").get()?.["count"]).toBe(
        roots.length + 1,
      );
    } finally {
      sqlite.close();
    }
  });

  it("WRR7: the production closure contains no DOFS garbage-collection path", function* () {
    // deno-lint-ignore require-yield
    const denoAdapter = fileURLToPath(new URL("../src/deno", import.meta.url));
    const vendorManifest = fileURLToPath(
      new URL("../vendor/cloudflare-computer-dofs/MANIFEST.json", import.meta.url),
    );
    const sources = sourceFiles(denoAdapter);
    expect(sources.some((source) => /from\s+["'][^"']*\/gc(?:\.[^"']*)?["']/.test(source))).toBe(
      false,
    );
    expect(sources.some((source) => /\.gc\s*\(/.test(source))).toBe(false);
    const manifest = JSON.parse(readFileSync(vendorManifest, "utf8"));
    expect(
      manifest.files.some((file: { path: string }) => /(^|\/)gc(?:\.[^/]*)?$/.test(file.path)),
    ).toBe(false);
  });
});

function sourceFiles(directory: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...sourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources.push(readFileSync(path, "utf8"));
    }
  }
  return sources;
}
