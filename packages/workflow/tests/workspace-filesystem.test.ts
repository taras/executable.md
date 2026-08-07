import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  type DurableEvent,
  type DurableStream,
  durableRun,
  guardDurableStream,
  type Json,
  type Workflow,
} from "@executablemd/durable-streams";
import { ensure, type Operation, scoped, spawn, suspend, withResolvers } from "effection";
import { exec } from "@effectionx/process";
import { exec as runProcess } from "@executablemd/runtime";
import {
  WorkflowDatabaseCorruptError,
  WorkflowRunStorage,
  WorkflowTransactionError,
} from "../mod.ts";
import {
  allowJournalInserts,
  createRun,
  refuseJournalInsertNamed,
  runPath,
  tamper,
  useStorageRoot,
  withStorage,
} from "./support/storage.ts";
import { createWorkflowRunConnections } from "../src/deno/connections.ts";
import { createWorkspaceFilesystem } from "../src/deno/workspace/filesystem.ts";
import { materializeWorkspaceRoot } from "../src/deno/workspace/root.ts";
import {
  type JournalDestination,
  routeJournalAppend,
  useJournalDestination,
} from "../src/deno/journal-route.ts";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const CRASH_CHILD = fileURLToPath(new URL("./support/workspace-crash-child.ts", import.meta.url));
const RESTART_CHILD = fileURLToPath(
  new URL("./support/workspace-restart-child.ts", import.meta.url),
);

describe("Tier WW — retained provider Workspace", () => {
  it("WW1: a successful mutation publishes the filesystem, root, pointer, and result", function* () {
    const storage = yield* useStorageRoot();

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const before = yield* database.workspace.currentRoot();
      if (!before.ok) {
        throw before.error;
      }

      function* work(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "create" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.mkdir("/notes", { mode: 0o750 });
            yield* filesystem.writeFile("/notes/release.txt", "ready", 0o640);
            return { written: true };
          },
        );
        return { written: true };
      }

      expect(yield* durableRun(work, { stream: database.journal })).toEqual({ written: true });
      const after = yield* database.workspace.currentRoot();
      if (!after.ok) {
        throw after.error;
      }
      expect(after.value).not.toBe(before.value);
    });

    const sqlite = new DatabaseSync(runPath(storage, "release-1.4"));
    try {
      const state = sqlite.prepare("SELECT current_root_id FROM workspace_state").get();
      const event = sqlite
        .prepare(
          'SELECT workspace_root_id, record FROM journal_events WHERE record LIKE \'%"name":"create"%\'',
        )
        .get();
      expect(event?.["workspace_root_id"]).toBe(state?.["current_root_id"]);
      expect(sqlite.prepare("SELECT COUNT(*) AS total FROM workspace_roots").get()?.["total"]).toBe(
        2,
      );
      expect(sqlite.prepare("SELECT COUNT(*) AS total FROM vfs_manifests").get()?.["total"]).toBe(
        1,
      );
      expect(
        sqlite.prepare("SELECT COUNT(*) AS total FROM workspace_root_blob_refs").get()?.["total"],
      ).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("WW2: a known mutation failure retains the previous root and one failed Yield", function* () {
    const storage = yield* useStorageRoot();

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const before = yield* database.workspace.currentRoot();
      if (!before.ok) {
        throw before.error;
      }

      function* work(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "missing" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/missing/file.txt", "no parent");
            return null;
          },
        );
        return null;
      }

      let failure: unknown;
      try {
        yield* durableRun(work, { stream: database.journal });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);

      const after = yield* database.workspace.currentRoot();
      if (!after.ok) {
        throw after.error;
      }
      expect(after.value).toBe(before.value);
      const events = yield* database.journal.readAll();
      const failed = events.filter(
        (event) => event.type === "yield" && event.description.name === "missing",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.type === "yield" ? failed[0].result.status : undefined).toBe("err");
    });
  });

  it("WW3: an older root reconstructs topology, metadata, links, and retained bytes", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "release-1.4");
    let historical = "";

    yield* withStorage(storage, function* () {
      const database = yield* createRun();

      function* changes(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "first-root" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.mkdir("/a");
            yield* filesystem.writeFile("/a/x.txt", "group one");
            yield* filesystem.link("/a/x.txt", "/z-one.txt");
            yield* filesystem.writeFile("/a-.txt", "group zero");
            yield* filesystem.link("/a-.txt", "/z-zero.txt");
            yield* filesystem.mkdir("/tree", { mode: 0o750 });
            yield* filesystem.writeFile("/tree/file.txt", "first", 0o640);
            yield* filesystem.link("/tree/file.txt", "/tree/hardlink.txt");
            yield* filesystem.symlink("file.txt", "/tree/current.txt");
            return null;
          },
        );
        yield database.workspace.effect(
          { type: "workspace", name: "later-root" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/tree/file.txt", "second");
            yield* filesystem.rename("/tree/file.txt", "/renamed.txt");
            yield* filesystem.remove("/tree/current.txt");
            yield* filesystem.mkdir("/later", { mode: 0o700 });
            yield* filesystem.chmod("/tree/hardlink.txt", 0o600);
            return null;
          },
        );
        return null;
      }
      yield* durableRun(changes, { stream: database.journal });
    });

    const roots = new DatabaseSync(path);
    try {
      const first = roots
        .prepare(
          `SELECT e.workspace_root_id, r.manifest
             FROM journal_events e
             JOIN workspace_roots r ON r.root_id = e.workspace_root_id
            WHERE e.record LIKE '%"name":"first-root"%'`,
        )
        .get();
      const current = roots
        .prepare("SELECT current_root_id FROM workspace_state WHERE singleton_id = 1")
        .get();
      historical = String(first?.["workspace_root_id"]);
      expect(current?.["current_root_id"]).not.toBe(historical);
      const manifest = JSON.parse(String(first?.["manifest"]));
      const hardlinks = Object.fromEntries(
        manifest.entries
          .filter((entry: { hardlink?: string | null }) => entry.hardlink !== undefined)
          .map((entry: { path: string; hardlink: string | null }) => [entry.path, entry.hardlink]),
      );
      expect(hardlinks).toEqual({
        "/a-.txt": "h0",
        "/a/x.txt": "h1",
        "/tree/file.txt": "h2",
        "/tree/hardlink.txt": "h2",
        "/z-one.txt": "h1",
        "/z-zero.txt": "h0",
      });
    } finally {
      roots.close();
    }

    const connections = createWorkflowRunConnections();
    try {
      const connection = connections.at(path);
      connection.database.exec("BEGIN IMMEDIATE");
      connection.transactionOpen = true;
      try {
        materializeWorkspaceRoot(
          connection.database,
          connection.dofs,
          connection.savepoints,
          path,
          historical,
        );
        connection.transactionOpen = false;
        connection.database.exec("COMMIT");
      } catch (error) {
        connection.transactionOpen = false;
        connection.database.exec("ROLLBACK");
        throw error;
      }
      const filesystem = createWorkspaceFilesystem(connection);
      expect(yield* filesystem.readTextFile("/tree/file.txt")).toBe("first");
      expect(yield* filesystem.readTextFile("/tree/hardlink.txt")).toBe("first");
      expect((yield* filesystem.lstat("/tree/file.txt")).mode).toBe(0o640);
      expect(yield* filesystem.readlink("/tree/current.txt")).toBe("file.txt");
      expect((yield* filesystem.readdir("/tree")).map((entry) => entry.name).sort()).toEqual([
        "current.txt",
        "file.txt",
        "hardlink.txt",
      ]);
    } finally {
      connections.close();
    }

    yield* withStorage(storage, function* () {
      const found = yield* createRun();
      const root = yield* found.workspace.currentRoot();
      if (!root.ok) {
        throw root.error;
      }
      expect(root.value).toBe(historical);
    });

    const sqlite = new DatabaseSync(path);
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      let refused: unknown;
      try {
        sqlite.prepare("DELETE FROM vfs_manifests").run();
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(Error);
      let bytesRefused: unknown;
      try {
        sqlite.prepare("DELETE FROM vfs_blob_bytes").run();
      } catch (error) {
        bytesRefused = error;
      }
      expect(bytesRefused).toBeInstanceOf(Error);
    } finally {
      sqlite.close();
    }
  });

  it("WW4: a journal insertion failure rolls back the mutation and root publication", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "release-1.4");

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const before = yield* database.workspace.currentRoot();
      if (!before.ok) {
        throw before.error;
      }
      refuseJournalInsertNamed(path, "refused-workspace");

      function* work(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "refused-workspace" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/must-roll-back.txt", "uncommitted");
            return null;
          },
        );
        return null;
      }

      let failure: unknown;
      try {
        yield* durableRun(work, { stream: database.journal });
      } catch (error) {
        failure = error;
      } finally {
        allowJournalInserts(path);
      }
      expect(failure).toBeInstanceOf(Error);
      const after = yield* database.workspace.currentRoot();
      expect(after.ok && after.value).toBe(before.value);
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare("SELECT COUNT(*) AS total FROM vfs_dirents").get()?.["total"]).toBe(0);
      } finally {
        raw.close();
      }
    });
  });

  it("WW5: gate rejection happens before routing and rolls back everything", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "release-1.4");

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const before = yield* database.workspace.currentRoot();
      if (!before.ok) {
        throw before.error;
      }
      const guarded = guardDurableStream(database.journal, function* () {
        throw new Error("rejected before storage");
      });

      function* work(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "secret-rejected" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/secret.txt", "never retained");
            return null;
          },
        );
        return null;
      }

      let failure: unknown;
      try {
        yield* durableRun(work, { stream: guarded });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const after = yield* database.workspace.currentRoot();
      expect(after.ok && after.value).toBe(before.value);
      expect(yield* database.journal.readAll()).toEqual([]);
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare("SELECT COUNT(*) AS total FROM vfs_dirents").get()?.["total"]).toBe(0);
      } finally {
        raw.close();
      }
    });
  });

  it("WW6: cancellation during mutation teardown publishes nothing", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "release-1.4");

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const before = yield* database.workspace.currentRoot();
      if (!before.ok) {
        throw before.error;
      }
      const tearingDown = withResolvers<void>();
      const finishTeardown = withResolvers<void>();

      function* work(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "cancelled-teardown" },
          function* (filesystem): Operation<Json> {
            yield* ensure(function* () {
              tearingDown.resolve();
              yield* finishTeardown.operation;
            });
            yield* filesystem.writeFile("/cancelled.txt", "uncommitted");
            return null;
          },
        );
        return null;
      }

      const running = yield* spawn(function* () {
        yield* durableRun(work, { stream: database.journal });
      });
      yield* tearingDown.operation;
      const halting = yield* spawn(function* () {
        yield* running.halt();
      });
      finishTeardown.resolve();
      yield* halting;

      const after = yield* database.workspace.currentRoot();
      expect(after.ok && after.value).toBe(before.value);
      expect(yield* database.journal.readAll()).toEqual([]);
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare("SELECT COUNT(*) AS total FROM vfs_dirents").get()?.["total"]).toBe(0);
      } finally {
        raw.close();
      }
    });
  });

  it("WW6b: cancellation before and during mutation publishes nothing", function* () {
    const storage = yield* useStorageRoot();

    yield* withStorage(storage, function* () {
      const holder = yield* createRun({ runId: "cancel-before" });
      const waiting = yield* createRun({ runId: "cancel-before" });
      const held = withResolvers<void>();
      const release = withResolvers<void>();
      const holding = yield* spawn(function* () {
        const result = yield* holder.transact(function* () {
          held.resolve();
          yield* release.operation;
        });
        if (!result.ok) {
          throw result.error;
        }
      });
      yield* held.operation;

      const attempted = withResolvers<void>();
      function* queued(): Workflow<Json> {
        yield waiting.workspace.effect(
          { type: "workspace", name: "cancelled-before" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/before.txt", "must not run");
            return null;
          },
        );
        return null;
      }
      const queuedRun = yield* spawn(function* () {
        attempted.resolve();
        yield* durableRun(queued, { stream: waiting.journal });
      });
      yield* attempted.operation;
      yield* queuedRun.halt();
      release.resolve();
      yield* holding;
      expect(yield* waiting.journal.readAll()).toEqual([]);

      const during = yield* createRun({ runId: "cancel-during" });
      const entered = withResolvers<void>();
      function* interrupted(): Workflow<Json> {
        yield during.workspace.effect(
          { type: "workspace", name: "cancelled-during" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/during.txt", "uncommitted");
            entered.resolve();
            yield* suspend();
            return null;
          },
        );
        return null;
      }
      const running = yield* spawn(function* () {
        yield* durableRun(interrupted, { stream: during.journal });
      });
      yield* entered.operation;
      yield* running.halt();
      expect(yield* during.journal.readAll()).toEqual([]);
    });

    for (const runId of ["cancel-before", "cancel-during"]) {
      const sqlite = new DatabaseSync(runPath(storage, runId));
      try {
        expect(sqlite.prepare("SELECT COUNT(*) AS total FROM vfs_dirents").get()?.["total"]).toBe(
          0,
        );
        expect(
          sqlite.prepare("SELECT COUNT(*) AS total FROM workspace_roots").get()?.["total"],
        ).toBe(1);
      } finally {
        sqlite.close();
      }
    }
  });

  it("WW7: SIGKILL after a real write exposes none of the open transaction", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "release-1.4");
    let baseline = "";

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const root = yield* database.workspace.currentRoot();
      if (!root.ok) {
        throw root.error;
      }
      baseline = root.value;
    });

    const reached = withResolvers<void>();
    let output = "";
    const child = yield* exec(process.execPath, {
      arguments: ["run", "--allow-all", "--frozen", CRASH_CHILD, storage],
      cwd: REPOSITORY,
    });
    yield* child.around({
      *stdout([bytes], next) {
        output += new TextDecoder().decode(bytes);
        if (output.includes("XMD_UNCOMMITTED_WORKSPACE_WRITE")) {
          reached.resolve();
        }
        return yield* next(bytes);
      },
    });
    yield* reached.operation;
    process.kill(child.pid, "SIGKILL");
    const status = yield* child.join();
    expect(status.signal).toBe("SIGKILL");

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      const root = yield* database.workspace.currentRoot();
      if (!root.ok) {
        throw root.error;
      }
      expect(root.value).toBe(baseline);
      expect(yield* database.journal.readAll()).toEqual([]);
    });

    const sqlite = new DatabaseSync(path);
    try {
      expect(sqlite.prepare("SELECT COUNT(*) AS total FROM vfs_dirents").get()?.["total"]).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS total FROM workspace_roots").get()?.["total"]).toBe(
        1,
      );
      expect(sqlite.prepare("SELECT COUNT(*) AS total FROM journal_events").get()?.["total"]).toBe(
        0,
      );
    } finally {
      sqlite.close();
    }
  });

  it("WW8: serialized handles share the authoritative filesystem and its cache", function* () {
    const storage = yield* useStorageRoot();
    const path = runPath(storage, "release-1.4");
    let retained = "";

    yield* withStorage(storage, function* () {
      const first = yield* createRun();
      const second = yield* createRun();

      function* sequence(): Workflow<Json> {
        try {
          yield first.workspace.effect(
            { type: "workspace", name: "negative-cache" },
            function* (filesystem): Operation<Json> {
              yield* filesystem.readTextFile("/later.txt");
              return null;
            },
          );
        } catch {
          // The expected failed effect does not stop the workflow from
          // exercising the next serialized provider turn.
        }
        yield second.workspace.effect(
          { type: "workspace", name: "create-later" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/later.txt", "visible");
            return null;
          },
        );
        yield first.workspace.effect(
          { type: "workspace", name: "observe-later" },
          function* (filesystem): Operation<Json> {
            expect(yield* filesystem.readTextFile("/later.txt")).toBe("visible");
            return null;
          },
        );
        return null;
      }
      yield* durableRun(sequence, { stream: first.journal });
      const observed = yield* first.workspace.currentRoot();
      if (!observed.ok) {
        throw observed.error;
      }
      retained = observed.value;
      const events = yield* first.journal.readAll();
      expect(
        events.flatMap((event) => (event.type === "yield" ? [event.description.name] : [])),
      ).toEqual(["negative-cache", "create-later", "observe-later"]);
    });

    const sqlite = new DatabaseSync(path);
    try {
      const roots = sqlite.prepare("SELECT COUNT(*) AS total FROM workspace_roots").get();
      expect(roots?.["total"]).toBe(2);
      const references = sqlite
        .prepare(
          `SELECT workspace_root_id FROM journal_events
           WHERE record LIKE '%"name":"create-later"%'
              OR record LIKE '%"name":"observe-later"%'
           ORDER BY sequence`,
        )
        .all();
      expect(references.map((row) => row["workspace_root_id"])).toEqual([retained, retained]);
    } finally {
      sqlite.close();
    }
  });

  it("WW9: Workspace corruption is distinguished and left byte-for-byte unchanged", function* () {
    const storage = yield* useStorageRoot();
    const cases: Array<{ runId: string; damage(database: DatabaseSync): void }> = [
      {
        runId: "partial-root-schema",
        damage(database) {
          database.exec("DROP TABLE workspace_root_blob_refs");
        },
      },
      {
        runId: "changed-root-constraint",
        damage(database) {
          database.exec(`
            ALTER TABLE workspace_state RENAME TO workspace_state_original;
            CREATE TABLE workspace_state (
              singleton_id INTEGER PRIMARY KEY,
              current_root_id TEXT NOT NULL
            );
            INSERT INTO workspace_state SELECT * FROM workspace_state_original;
            DROP TABLE workspace_state_original;
          `);
        },
      },
      {
        runId: "malformed-root",
        damage(database) {
          database
            .prepare("UPDATE workspace_roots SET manifest = ?")
            .run('{"format":1,"entries":[]}');
        },
      },
      {
        runId: "live-frontier-mismatch",
        damage(database) {
          database.prepare("UPDATE vfs_nodes SET mode = 448 WHERE inode = 1").run();
        },
      },
    ];

    for (const one of cases) {
      yield* withStorage(storage, function* () {
        yield* createRun({ runId: one.runId });
      });
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

    const blobRun = "corrupt-retained-blob";
    yield* withStorage(storage, function* () {
      const database = yield* createRun({ runId: blobRun });
      function* write(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "blob" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/blob.txt", "retained bytes");
            return null;
          },
        );
        return null;
      }
      yield* durableRun(write, { stream: database.journal });
    });
    const blobPath = runPath(storage, blobRun);
    tamper(blobPath, (database) => {
      database.prepare("UPDATE vfs_blob_bytes SET bytes = X'00'").run();
    });
    const before = readFileSync(blobPath);
    const corrupted = yield* withStorage(storage, function* () {
      return yield* WorkflowRunStorage.operations.lookup(blobRun);
    });
    expect(corrupted.ok).toBe(false);
    expect(!corrupted.ok && corrupted.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
    expect(readFileSync(blobPath)).toEqual(before);
  });

  it("WW10: a second process observes the retained Workspace and ordered journal", function* () {
    const storage = yield* useStorageRoot();
    let rootId = "";

    yield* withStorage(storage, function* () {
      const database = yield* createRun();
      function* write(): Workflow<Json> {
        yield database.workspace.effect(
          { type: "workspace", name: "first-process" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/survives.txt", "across processes");
            return null;
          },
        );
        return null;
      }
      yield* durableRun(write, { stream: database.journal });
      const root = yield* database.workspace.currentRoot();
      if (!root.ok) {
        throw root.error;
      }
      rootId = root.value;
    });

    const child = yield* runProcess({
      command: [process.execPath, "run", "--allow-all", "--frozen", RESTART_CHILD, storage],
      cwd: REPOSITORY,
    });
    expect(child.exitCode).toBe(0);
    const restored = JSON.parse(child.stdout.trim());
    expect(restored.rootId).toBe(rootId);
    expect(restored.events).toEqual(["first-process", "close"]);
  });

  it("WW11: explicit journal destinations fence foreign, completed, and stale handles", function* () {
    const storage = yield* useStorageRoot();
    const connections = createWorkflowRunConnections();
    yield* ensure(() => {
      connections.close();
    });
    const connection = connections.at(runPath(storage, "route-a"));
    const foreign = connections.at(runPath(storage, "route-b"));
    const event: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "workspace", name: "routed" },
      result: { status: "ok", value: null },
    };
    let standalone = 0;
    let enlisted = 0;
    const standaloneAppend = function* (): Operation<void> {
      standalone += 1;
    };
    const journal: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [];
      },
      *append(): Operation<void> {
        enlisted += 1;
      },
    };
    const active = { id: "active", connection, open: true };
    connection.transactionOpen = true;
    connection.activeTransactionId = active.id;

    yield* routeJournalAppend(connection, standaloneAppend, event);
    expect(standalone).toBe(1);
    expect(enlisted).toBe(0);

    function destination(overrides: Partial<JournalDestination> = {}): JournalDestination {
      return {
        path: connection.path,
        generation: connection.generation,
        transaction: active,
        journal,
        workspaceRootId: "root",
        used: false,
        ...overrides,
      };
    }

    function* appendThrough(offered: JournalDestination): Operation<unknown> {
      try {
        yield* scoped(function* () {
          yield* useJournalDestination(offered);
          yield* routeJournalAppend(connection, standaloneAppend, event);
        });
      } catch (error) {
        return error;
      }
      return undefined;
    }

    const foreignTransaction = { id: "foreign", connection: foreign, open: true };
    const completed = { id: active.id, connection, open: false };
    const fabricated = { id: "fabricated", connection, open: true };
    const refusals = [
      yield* appendThrough(destination({ path: foreign.path, transaction: foreignTransaction })),
      yield* appendThrough(destination({ transaction: completed })),
      yield* appendThrough(destination({ generation: "stale-generation" })),
      yield* appendThrough(destination({ transaction: fabricated })),
      yield* appendThrough(destination({ workspaceRootId: "" })),
    ];
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(WorkflowTransactionError);
    }
    expect(enlisted).toBe(0);

    const valid = destination();
    expect(yield* appendThrough(valid)).toBeUndefined();
    expect(enlisted).toBe(1);
    expect(yield* appendThrough(valid)).toBeInstanceOf(WorkflowTransactionError);
    expect(enlisted).toBe(1);
    connection.transactionOpen = false;
    connection.activeTransactionId = undefined;
  });
});
