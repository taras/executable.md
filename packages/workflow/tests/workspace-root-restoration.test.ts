import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, type Operation, spawn, suspend, withResolvers } from "effection";
import {
  WorkflowDatabaseCorruptError,
  type WorkflowRunDatabase,
  WorkflowRunStorage,
} from "../mod.ts";
import {
  encodeWorkspaceManifest,
  parseWorkspaceManifest,
  type StoredWorkspaceRoot,
  workspaceRootId,
} from "../src/deno/workspace/manifest.ts";
import {
  type PrivateWorkspaceTransaction,
  setPrivateWorkspaceClock,
  transactWorkspaceRoots,
} from "../src/deno/workspace/private.ts";
import { createRun, runPath, tamper, useStorageRoot, withStorage } from "./support/storage.ts";

const SQLITE_MAX_INTEGER = "9223372036854775807";

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

function count(database: DatabaseSync, table: string): number {
  const value = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"];
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function* createCorruptionFixture(storage: string, runId: string): Operation<void> {
  yield* withStorage(storage, function* () {
    const database = yield* createRun({ runId });
    yield* setPrivateWorkspaceClock(database, () => 1_000);
    yield* capture(database, function* (workspace) {
      yield* workspace.filesystem.mkdir("/dir");
      yield* workspace.filesystem.writeFile("/dir/file.txt", "first retained bytes", 0o640);
    });
    yield* setPrivateWorkspaceClock(database, () => 2_000);
    yield* capture(database, function* (workspace) {
      yield* workspace.filesystem.writeFile("/dir/file.txt", "second retained bytes", 0o600);
    });
  });
}

describe("Tier WRR — private Workspace root restoration", () => {
  it("WRR4: an older root restores exact state and clears authoritative negative caches", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "restore-history");
    let historical: StoredWorkspaceRoot | undefined;
    let later: StoredWorkspaceRoot | undefined;

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "restore-history" });
      yield* setPrivateWorkspaceClock(database, () => 10_000);
      historical = yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.mkdir("/tree", { mode: 0o750 });
        yield* workspace.filesystem.writeFile("/tree/file.txt", "historical", 0o640);
        yield* workspace.filesystem.link("/tree/file.txt", "/tree/hardlink.txt");
        yield* workspace.filesystem.symlink("file.txt", "/tree/current.txt");
      });

      yield* setPrivateWorkspaceClock(database, () => 20_000);
      later = yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/tree/file.txt", "later", 0o600);
        yield* workspace.filesystem.rename("/tree/file.txt", "/renamed.txt");
        yield* workspace.filesystem.remove("/tree/current.txt");
        yield* workspace.filesystem.remove("/tree/hardlink.txt");
        yield* workspace.filesystem.mkdir("/later", { mode: 0o700 });
      });

      const historicalRoot = historical;
      const laterRoot = later;
      if (historicalRoot === undefined || laterRoot === undefined) {
        throw new Error("the historical roots were not captured");
      }
      expect(historicalRoot.rootId).not.toBe(laterRoot.rootId);

      const restored = yield* transact(database, function* (workspace) {
        let absent: unknown;
        try {
          yield* workspace.filesystem.readTextFile("/tree/file.txt");
        } catch (error) {
          absent = error;
        }
        expect(absent).toBeInstanceOf(Error);

        const selected = yield* workspace.restore(historicalRoot.rootId, { publish: true });
        expect(yield* workspace.filesystem.readTextFile("/tree/file.txt")).toBe("historical");
        expect(yield* workspace.filesystem.readTextFile("/tree/hardlink.txt")).toBe("historical");
        expect(yield* workspace.filesystem.readlink("/tree/current.txt")).toBe("file.txt");
        expect(yield* workspace.filesystem.lstat("/tree/file.txt")).toEqual({
          kind: "file",
          mode: 0o640,
          mtime: 10_000,
          size: 10,
        });
        expect(
          new Set((yield* workspace.filesystem.readdir("/tree")).map((entry) => entry.name)),
        ).toEqual(new Set(["current.txt", "file.txt", "hardlink.txt"]));
        const resnapshot = yield* workspace.capture({ publish: true });
        expect(resnapshot).toEqual(selected);
        return selected;
      });
      expect(restored.rootId).toBe(historicalRoot.rootId);
    });

    if (historical === undefined || later === undefined) {
      throw new Error("the retained roots are unavailable");
    }
    const sqlite = new DatabaseSync(path);
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      const historicalManifest = sqlite
        .prepare("SELECT manifest_hash FROM workspace_root_manifest_refs WHERE root_id = ?")
        .get(historical.rootId)?.["manifest_hash"];
      const historicalBlob = sqlite
        .prepare("SELECT blob_hash FROM workspace_root_blob_refs WHERE root_id = ?")
        .get(historical.rootId)?.["blob_hash"];
      if (!(historicalManifest instanceof Uint8Array) || !(historicalBlob instanceof Uint8Array)) {
        throw new Error("the historical root has no retained content references");
      }
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_root_manifest_refs WHERE root_id = ? AND manifest_hash = ?",
          )
          .get(later.rootId, historicalManifest)?.["count"],
      ).toBe(0);

      const before = {
        manifests: count(sqlite, "vfs_manifests"),
        blobs: count(sqlite, "vfs_blobs"),
        bytes: count(sqlite, "vfs_blob_bytes"),
      };
      expect(() =>
        sqlite.prepare("DELETE FROM vfs_manifests WHERE hash = ?").run(historicalManifest),
      ).toThrow();
      expect(() =>
        sqlite.prepare("DELETE FROM vfs_blobs WHERE hash = ?").run(historicalBlob),
      ).toThrow();
      expect(() =>
        sqlite.prepare("DELETE FROM vfs_blob_bytes WHERE hash = ?").run(historicalBlob),
      ).toThrow();
      expect({
        manifests: count(sqlite, "vfs_manifests"),
        blobs: count(sqlite, "vfs_blobs"),
        bytes: count(sqlite, "vfs_blob_bytes"),
      }).toEqual(before);
    } finally {
      sqlite.close();
    }

    yield* withStorage(storage, function* () {
      const result = yield* WorkflowRunStorage.operations.lookup("restore-history");
      if (!result.ok) {
        throw result.error;
      }
      expect(
        yield* transact(result.value, function* (workspace) {
          expect(yield* workspace.filesystem.readTextFile("/tree/file.txt")).toBe("historical");
          return yield* workspace.currentRoot();
        }),
      ).toBe(historical?.rootId);
    });
  });

  it("WRR5: an in-savepoint restoration failure preserves the prior frontier and pointer", function* () {
    const storage = yield* useStorageRoot();
    let historical = "";
    let current = "";

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "restore-rollback" });
      yield* setPrivateWorkspaceClock(database, () => 100);
      historical = (yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/historical.txt", "historical");
      })).rootId;
      yield* setPrivateWorkspaceClock(database, () => 200);
      current = (yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.remove("/historical.txt");
        yield* workspace.filesystem.writeFile("/current.txt", "current");
      })).rootId;

      const fault = new DatabaseSync(runPath(storage, "restore-rollback"));
      fault.exec(`
        CREATE TRIGGER fail_workspace_restore
        BEFORE INSERT ON vfs_nodes
        WHEN NEW.inode <> 1
        BEGIN
          SELECT raise(ABORT, 'restoration insertion refused');
        END
      `);
      yield* transact(database, function* (workspace) {
        let failure: unknown;
        try {
          yield* workspace.restore(historical, { publish: true });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(yield* workspace.currentRoot()).toBe(current);
        expect(yield* workspace.filesystem.readTextFile("/current.txt")).toBe("current");
        let historicalFile: unknown;
        try {
          yield* workspace.filesystem.readTextFile("/historical.txt");
        } catch (error) {
          historicalFile = error;
        }
        expect(historicalFile).toBeInstanceOf(Error);
      });
      fault.exec("DROP TRIGGER fail_workspace_restore");
      fault.close();
    });

    const sqlite = new DatabaseSync(runPath(storage, "restore-rollback"));
    try {
      expect(
        sqlite
          .prepare("SELECT current_root_id FROM workspace_state WHERE singleton_id = 1")
          .get()?.["current_root_id"],
      ).toBe(current);
    } finally {
      sqlite.close();
    }
  });

  it("WRR6: retained-root, content, topology, and live mismatches are read-only corruption", function* () {
    const storage = yield* useStorageRoot();
    const cases: Array<{ runId: string; damage(database: DatabaseSync): void }> = [
      {
        runId: "missing-manifest-ref",
        damage(database) {
          const current = currentRoot(database);
          database
            .prepare("DELETE FROM workspace_root_manifest_refs WHERE root_id = ?")
            .run(current);
        },
      },
      {
        runId: "extra-blob-ref",
        damage(database) {
          const current = currentRoot(database);
          const blob = database
            .prepare("SELECT blob_hash FROM workspace_root_blob_refs WHERE root_id <> ? LIMIT 1")
            .get(current)?.["blob_hash"];
          if (!(blob instanceof Uint8Array)) {
            throw new Error("the historical root has no blob reference");
          }
          database
            .prepare("INSERT INTO workspace_root_blob_refs (root_id, blob_hash) VALUES (?, ?)")
            .run(current, blob);
        },
      },
      {
        runId: "altered-root-bytes",
        damage(database) {
          database
            .prepare("UPDATE workspace_roots SET manifest = ? WHERE root_id = ?")
            .run('{"format":1,"entries":[]}', currentRoot(database));
        },
      },
      {
        runId: "wrong-root-id",
        damage(database) {
          const current = currentRoot(database);
          const wrong = "0".repeat(64);
          database.exec("PRAGMA foreign_keys = OFF");
          database
            .prepare("UPDATE workspace_roots SET root_id = ? WHERE root_id = ?")
            .run(wrong, current);
          database
            .prepare("UPDATE workspace_root_manifest_refs SET root_id = ? WHERE root_id = ?")
            .run(wrong, current);
          database
            .prepare("UPDATE workspace_root_blob_refs SET root_id = ? WHERE root_id = ?")
            .run(wrong, current);
          database.prepare("UPDATE workspace_state SET current_root_id = ?").run(wrong);
        },
      },
      {
        runId: "malformed-root-path",
        damage(database) {
          const current = currentRoot(database);
          const manifest = JSON.parse(
            String(
              database
                .prepare("SELECT manifest FROM workspace_roots WHERE root_id = ?")
                .get(current)?.["manifest"],
            ),
          );
          manifest.entries[1].path = "relative";
          database
            .prepare("UPDATE workspace_roots SET manifest = ? WHERE root_id = ?")
            .run(JSON.stringify(manifest), current);
        },
      },
      {
        runId: "corrupt-manifest-bytes",
        damage(database) {
          database.prepare("UPDATE vfs_manifests SET encoded = X'7b7d'").run();
        },
      },
      {
        runId: "corrupt-blob-bytes",
        damage(database) {
          database.prepare("UPDATE vfs_blob_bytes SET bytes = X'00'").run();
        },
      },
      {
        runId: "corrupt-blob-size",
        damage(database) {
          database.prepare("UPDATE vfs_blobs SET size = size + 1").run();
        },
      },
      {
        runId: "unordered-chunks",
        damage(database) {
          database.prepare("UPDATE vfs_chunks SET idx = idx + 1").run();
        },
      },
      {
        runId: "missing-live-manifest",
        damage(database) {
          database.prepare("UPDATE vfs_nodes SET manifest_hash = NULL WHERE type = 'file'").run();
        },
      },
      {
        runId: "dangling-dirent",
        damage(database) {
          database
            .prepare("UPDATE vfs_dirents SET child_inode = 999 WHERE name = 'file.txt'")
            .run();
        },
      },
      {
        runId: "directory-cycle",
        damage(database) {
          database.prepare("UPDATE vfs_dirents SET child_inode = 1 WHERE name = 'dir'").run();
        },
      },
      {
        runId: "live-root-mismatch",
        damage(database) {
          database.prepare("UPDATE vfs_nodes SET mode = 448 WHERE inode = 1").run();
        },
      },
    ];

    for (const one of cases) {
      yield* createCorruptionFixture(storage, one.runId);
      const path = runPath(storage, one.runId);
      tamper(path, one.damage);
      const before = readFileSync(path);
      const result = yield* withStorage(storage, function* () {
        return yield* WorkflowRunStorage.operations.lookup(one.runId);
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
      expect(readFileSync(path)).toEqual(before);
    }
  });

  it("WRR7: retained-root integer corruption is redacted, typed, and read-only", function* () {
    const storage = yield* useStorageRoot();
    const cases: Array<{ runId: string; damage(database: DatabaseSync): void }> = [
      {
        runId: "huge-root-format",
        damage(database) {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database.exec(`UPDATE workspace_roots SET format_version = ${SQLITE_MAX_INTEGER}`);
        },
      },
      {
        runId: "huge-root-singleton",
        damage(database) {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database.exec(`UPDATE workspace_state SET singleton_id = ${SQLITE_MAX_INTEGER}`);
        },
      },
      {
        runId: "huge-node-mode",
        damage(database) {
          database.exec(`UPDATE vfs_nodes SET mode = ${SQLITE_MAX_INTEGER} WHERE inode = 1`);
        },
      },
      {
        runId: "huge-chunk-index",
        damage(database) {
          database.exec(`UPDATE vfs_chunks SET idx = ${SQLITE_MAX_INTEGER}`);
        },
      },
      {
        runId: "huge-manifest-size",
        damage(database) {
          database.exec(`UPDATE vfs_manifests SET size = ${SQLITE_MAX_INTEGER}`);
        },
      },
      {
        runId: "huge-blob-last-seen",
        damage(database) {
          database.exec(`UPDATE vfs_blobs SET last_seen = ${SQLITE_MAX_INTEGER}`);
        },
      },
      {
        runId: "huge-revision",
        damage(database) {
          database.exec(`UPDATE vfs_meta SET v = ${SQLITE_MAX_INTEGER} WHERE k = 'rev'`);
        },
      },
      {
        runId: "huge-watermark",
        damage(database) {
          database.exec(`UPDATE _vfs_watermark SET v = ${SQLITE_MAX_INTEGER} WHERE k = 'fetchRev'`);
        },
      },
      {
        runId: "huge-change-id",
        damage(database) {
          database.exec(
            `INSERT INTO vfs_changes (id, rev, path, op)
             VALUES (${SQLITE_MAX_INTEGER}, 1, '/gone', 'delete')`,
          );
        },
      },
    ];

    for (const one of cases) {
      yield* createCorruptionFixture(storage, one.runId);
      const path = runPath(storage, one.runId);
      tamper(path, one.damage);
      const before = readFileSync(path);
      const result = yield* withStorage(storage, function* () {
        return yield* WorkflowRunStorage.operations.lookup(one.runId);
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
      expect(result.error).not.toBeInstanceOf(RangeError);
      expect(errorSurface(result.error)).not.toContain(SQLITE_MAX_INTEGER);
      expect(readFileSync(path)).toEqual(before);
    }
  });

  it("WRR8: cleanup mutations finish before final root validation and cannot commit", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "cleanup-mutation");
    let baselineRoot = "";
    let baselineRoots = 0;
    let baselineJournal = 0;

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "cleanup-mutation" });
      baselineRoot = (yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/baseline.txt", "baseline");
      })).rootId;
      yield* database.journal.append({
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "baseline" },
      });

      const observer = new DatabaseSync(path);
      baselineRoots = count(observer, "workspace_roots");
      baselineJournal = count(observer, "journal_events");
      observer.close();
      const started = withResolvers<void>();
      const result = yield* transactWorkspaceRoots(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/captured.txt", "captured");
        yield* spawn(function* () {
          yield* ensure(function* () {
            yield* workspace.filesystem.writeFile("/cleanup.txt", "cleanup");
          });
          started.resolve();
          yield* suspend();
        });
        yield* started.operation;
        yield* workspace.capture({ publish: true });
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
      const after = new DatabaseSync(path);
      expect(count(after, "workspace_roots")).toBe(baselineRoots);
      expect(count(after, "journal_events")).toBe(baselineJournal);
      after.close();

      const observed = yield* transact(database, function* (workspace) {
        const missing: string[] = [];
        for (const file of ["/captured.txt", "/cleanup.txt"]) {
          try {
            yield* workspace.filesystem.readTextFile(file);
          } catch {
            missing.push(file);
          }
        }
        return { root: yield* workspace.currentRoot(), missing };
      });
      expect(observed).toEqual({
        root: baselineRoot,
        missing: ["/captured.txt", "/cleanup.txt"],
      });
      expect(yield* database.journal.readAll()).toHaveLength(baselineJournal);
    });

    yield* withStorage(storage, function* () {
      const found = yield* WorkflowRunStorage.operations.lookup("cleanup-mutation");
      if (!found.ok) {
        throw found.error;
      }
      expect(
        yield* transact(found.value, function* (workspace) {
          expect(yield* workspace.filesystem.readTextFile("/baseline.txt")).toBe("baseline");
          return yield* workspace.currentRoot();
        }),
      ).toBe(baselineRoot);
      expect(yield* found.value.journal.readAll()).toHaveLength(baselineJournal);
    });

    const reopened = new DatabaseSync(path);
    try {
      expect(count(reopened, "workspace_roots")).toBe(baselineRoots);
      expect(count(reopened, "journal_events")).toBe(baselineJournal);
    } finally {
      reopened.close();
    }
  });

  it("WRR10: outer failure rollback invalidates authoritative DOFS caches", function* () {
    const storage = yield* useStorageRoot();

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "rollback-cache" });
      const baselineRoot = (yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/kept.txt", "known retained bytes");
      })).rootId;
      yield* database.journal.append({
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "baseline" },
      });
      const baselineJournal = yield* database.journal.readAll();

      const failed = yield* transactWorkspaceRoots(database, function* (workspace) {
        yield* workspace.filesystem.remove("/kept.txt");
        let missing: unknown;
        try {
          yield* workspace.filesystem.readTextFile("/kept.txt");
        } catch (error) {
          missing = error;
        }
        expect(missing).toBeInstanceOf(Error);
        throw new Error("force the caller-owned transaction to roll back");
      });
      expect(failed.ok).toBe(false);

      const observed = yield* transact(database, function* (workspace) {
        return {
          content: yield* workspace.filesystem.readTextFile("/kept.txt"),
          root: yield* workspace.currentRoot(),
        };
      });
      expect(observed).toEqual({ content: "known retained bytes", root: baselineRoot });
      expect(yield* database.journal.readAll()).toEqual(baselineJournal);
    });
  });

  it("WRR10b: outer cancellation rollback invalidates authoritative DOFS caches", function* () {
    const storage = yield* useStorageRoot();

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "cancel-cache" });
      const baselineRoot = (yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/kept.txt", "known retained bytes");
      })).rootId;
      yield* database.journal.append({
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "baseline" },
      });
      const baselineJournal = yield* database.journal.readAll();
      const reached = withResolvers<void>();

      const transacting = yield* spawn(function* () {
        yield* transactWorkspaceRoots(database, function* (workspace) {
          yield* workspace.filesystem.remove("/kept.txt");
          let missing: unknown;
          try {
            yield* workspace.filesystem.readTextFile("/kept.txt");
          } catch (error) {
            missing = error;
          }
          expect(missing).toBeInstanceOf(Error);
          reached.resolve();
          yield* suspend();
        });
      });
      yield* reached.operation;
      yield* transacting.halt();

      const observed = yield* transact(database, function* (workspace) {
        return {
          content: yield* workspace.filesystem.readTextFile("/kept.txt"),
          root: yield* workspace.currentRoot(),
        };
      });
      expect(observed).toEqual({ content: "known retained bytes", root: baselineRoot });
      expect(yield* database.journal.readAll()).toEqual(baselineJournal);
    });
  });

  it("WRR11: historical file sizes must agree with retained DOFS manifests", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "historical-size");
    let historicalRoot = "";
    let currentRootId = "";

    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: "historical-size" });
      historicalRoot = (yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/historical.txt", "historical bytes");
      })).rootId;
      yield* database.journal.append({
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "historical" },
      });
      currentRootId = (yield* capture(database, function* (workspace) {
        yield* workspace.filesystem.remove("/historical.txt");
        yield* workspace.filesystem.writeFile("/current.txt", "current bytes");
      })).rootId;
    });

    tamper(path, (database) => {
      const stored = database
        .prepare("SELECT manifest FROM workspace_roots WHERE root_id = ?")
        .get(historicalRoot)?.["manifest"];
      if (typeof stored !== "string") {
        throw new Error("the historical Workspace root is missing");
      }
      const parsed = parseWorkspaceManifest(stored, path);
      let changed = false;
      const entries = parsed.entries.map((entry) => {
        if (entry.kind !== "file") {
          return entry;
        }
        changed = true;
        return { ...entry, size: entry.size + 1 };
      });
      if (!changed) {
        throw new Error("the historical Workspace root contains no file");
      }
      const manifest = encodeWorkspaceManifest(entries, path);
      const rootId = workspaceRootId(manifest);

      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare("UPDATE workspace_roots SET root_id = ?, manifest = ? WHERE root_id = ?")
        .run(rootId, manifest, historicalRoot);
      database
        .prepare("UPDATE workspace_root_manifest_refs SET root_id = ? WHERE root_id = ?")
        .run(rootId, historicalRoot);
      database
        .prepare("UPDATE workspace_root_blob_refs SET root_id = ? WHERE root_id = ?")
        .run(rootId, historicalRoot);
      database
        .prepare("UPDATE journal_events SET workspace_root_id = ? WHERE workspace_root_id = ?")
        .run(rootId, historicalRoot);
      expect(currentRoot(database)).toBe(currentRootId);
    });

    const before = readFileSync(path);
    const result = yield* withStorage(storage, function* () {
      return yield* WorkflowRunStorage.operations.lookup("historical-size");
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
    expect(readFileSync(path)).toEqual(before);
  });
});

function errorSurface(error: unknown): string {
  const parts: string[] = [String(error), inspect(error)];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.name, current.message, current.stack ?? "");
    current = current.cause;
  }
  return parts.join("\n");
}

function currentRoot(database: DatabaseSync): string {
  return String(
    database.prepare("SELECT current_root_id FROM workspace_state WHERE singleton_id = 1").get()?.[
      "current_root_id"
    ],
  );
}
