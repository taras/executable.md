import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import {
  durableCall,
  durableRun,
  guardDurableStream,
  InMemoryStream,
  type DurableEvent,
  type DurableStream,
  DurablePersistenceError,
  type Json,
  type Workflow,
  type Yield,
} from "@executablemd/durable-streams";
import { ensure, type Operation, scoped, spawn, suspend, withResolvers } from "effection";
import { createDurableWorkspaceOperation, type WorkflowRunDatabase } from "../mod.ts";
import {
  createWorkflowRunConnections,
  type RunConnection,
  type WorkflowRunConnectionHooks,
} from "../src/deno/connections.ts";
import { openWorkflowRunDatabase, readRunRow } from "../src/deno/database.ts";
import { useJournalRouting } from "../src/deno/journal-route.ts";
import { SavepointObservation, type SavepointObserver } from "../src/deno/savepoints.ts";
import { initializeSchema } from "../src/deno/schema.ts";
import {
  createWorkspaceProofEffect,
  useWorkspaceEffects,
  withWorkspaceEffects,
} from "../src/deno/workspace/effect.ts";
import { definitionToJson } from "../src/storage/definition.ts";
import { canonicalJson } from "../src/storage/record.ts";
import { type DenoWorkspaceFilesystem } from "../src/deno/workspace/filesystem.ts";
import {
  setPrivateWorkspaceClock,
  usePrivateWorkspace,
  withPrivateWorkspaceTransaction,
} from "../src/deno/workspace/private.ts";
import {
  allowJournalInserts,
  committedEventCount,
  createRun,
  refuseJournalInsertNamed,
  request,
  runPath,
  tamper,
  useStorageRoot,
  withStorage,
} from "./support/storage.ts";

function sqliteConstant(name: string): number {
  const value = Reflect.get(constants, name);
  if (typeof value !== "number") {
    throw new Error(`this Deno node:sqlite adapter does not expose ${name}`);
  }
  return value;
}

const SQLITE_SAVEPOINT = sqliteConstant("SQLITE_SAVEPOINT");
const SQLITE_OK = sqliteConstant("SQLITE_OK");
const SQLITE_DENY = sqliteConstant("SQLITE_DENY");

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

function workspaceYields(events: DurableEvent[]): Yield[] {
  return events.filter(
    (event): event is Yield =>
      event.type === "yield" && event.description.type === "workspace-proof",
  );
}

function* workspaceStep(
  database: WorkflowRunDatabase,
  name: string,
  mutate: (filesystem: DenoWorkspaceFilesystem) => Operation<Json>,
): Workflow<void> {
  yield createWorkspaceProofEffect(database, { type: "workspace-proof", name }, mutate);
}

function* inspectWorkspace(
  database: WorkflowRunDatabase,
  path: string,
): Operation<{ root: string; content: string | undefined }> {
  const inspected = yield* database.transact(function* (transaction) {
    return yield* withPrivateWorkspaceTransaction(database, transaction, function* (workspace) {
      let content: string | undefined;
      try {
        content = yield* workspace.filesystem.readTextFile(path);
      } catch {
        content = undefined;
      }
      return {
        root: yield* workspace.currentRoot(),
        content,
      };
    });
  });
  if (!inspected.ok) {
    throw inspected.error;
  }
  return inspected.value;
}

function journalRoot(path: string, name: string): string | undefined {
  const sqlite = new DatabaseSync(path);
  try {
    const row = sqlite
      .prepare(
        `SELECT workspace_root_id FROM journal_events
         WHERE record LIKE ? ORDER BY sequence LIMIT 1`,
      )
      .get(`%"name":"${name}"%`);
    const root = row?.["workspace_root_id"];
    return typeof root === "string" ? root : undefined;
  } finally {
    sqlite.close();
  }
}

function retainedRootCount(path: string): number {
  const sqlite = new DatabaseSync(path);
  try {
    const value = sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_roots").get()?.["count"];
    return typeof value === "number" ? value : Number(value);
  } finally {
    sqlite.close();
  }
}

function withDirectWorkspaceStorage<T>(
  root: string,
  name: string,
  observe: SavepointObserver,
  body: (database: WorkflowRunDatabase, connection: RunConnection) => Operation<T>,
  hooks: WorkflowRunConnectionHooks = {},
): Operation<T> {
  return scoped(function* () {
    const path = join(root, `${name}.sqlite`);
    const connections = createWorkflowRunConnections(observe, hooks);
    yield* ensure(() => connections.close());
    const connection = connections.at(path);
    const wanted = request({ runId: name });
    const stamp = new Date(1_750_000_000_000).toISOString();
    connection.database.exec("BEGIN IMMEDIATE");
    const initializing = connection.beginTransaction();
    try {
      initializeSchema(connection.database, connection.dofs, () => {
        connection.database
          .prepare(
            `INSERT INTO workflow_run
              (id, run_id, definition, base, props, status, created_at, updated_at)
              VALUES (1, ?, ?, ?, ?, 'running', ?, ?)`,
          )
          .run(
            wanted.runId,
            canonicalJson(definitionToJson(wanted.definition)),
            wanted.base,
            canonicalJson(wanted.props),
            stamp,
            stamp,
          );
      });
      connection.validateTransaction(initializing);
      connection.finishTransaction(initializing);
      connection.database.exec("COMMIT");
    } catch (error) {
      if (initializing.open) {
        connection.finishTransaction(initializing);
      }
      connection.database.exec("ROLLBACK");
      throw error;
    }

    yield* useJournalRouting(connections);
    yield* usePrivateWorkspace(connections);
    yield* useWorkspaceEffects(connections);
    const database = yield* openWorkflowRunDatabase({
      connection,
      connections,
      record: readRunRow(connection.database, path),
    });
    return yield* body(database, connection);
  });
}

function setSqliteAuthorizer(
  database: DatabaseSync,
  authorize: ((action: number, operation: string | null, name: string | null) => number) | null,
): void {
  const install = Reflect.get(database, "setAuthorizer");
  if (typeof install !== "function") {
    throw new Error("this Deno node:sqlite adapter does not expose setAuthorizer");
  }
  Reflect.apply(install, database, [authorize]);
}

describe("Tier WAC — atomic provider-level Workspace effects", () => {
  it("WAC1: mutation, root, filtered Yield and commit become visible together", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-success";
    const path = join(root, `${runId}.sqlite`);
    let selected: WorkflowRunDatabase | undefined;
    let baselineRoot: string | undefined;
    let observedRoutedAppend = false;

    yield* withDirectWorkspaceStorage(
      root,
      runId,
      () => {},
      function* (database) {
        selected = database;
        yield* setPrivateWorkspaceClock(database, () => 1_750_000_000_000);
        const baseline = yield* inspectWorkspace(database, "/kept.txt");
        baselineRoot = baseline.root;
        let gateCalls = 0;
        const guardedOnce = guardDurableStream(database.journal, function* (event) {
          if (event.type === "yield") {
            gateCalls += 1;
          }
        });
        const guarded = guardDurableStream(guardedOnce, function* () {});

        function* workflow(): Workflow<string> {
          yield* workspaceStep(database, "write", function* (filesystem) {
            yield* filesystem.writeFile("/kept.txt", "atomic bytes", 0o640);
            return "written";
          });
          return "done";
        }

        expect(
          yield* withWorkspaceEffects(database, durableRun(workflow, { stream: guarded })),
        ).toBe("done");
        const committed = yield* inspectWorkspace(database, "/kept.txt");
        expect(committed.content).toBe("atomic bytes");
        expect(committed.root).not.toBe(baseline.root);
        expect(journalRoot(path, "write")).toBe(committed.root);
        expect(gateCalls).toBe(1);

        const next = yield* database.transact(function* (transaction) {
          return yield* withPrivateWorkspaceTransaction(
            database,
            transaction,
            function* (workspace) {
              return {
                content: yield* workspace.filesystem.readTextFile("/kept.txt"),
                root: yield* workspace.currentRoot(),
                events: yield* transaction.journal.readAll(),
              };
            },
          );
        });
        if (!next.ok) {
          throw next.error;
        }
        expect(next.value.content).toBe("atomic bytes");
        expect(next.value.root).toBe(committed.root);
        expect(workspaceYields(next.value.events)).toHaveLength(1);
        expect(observedRoutedAppend).toBe(true);
      },
      {
        // deno-lint-ignore require-yield
        *afterRoutedJournalAppend(candidate, event): Operation<void> {
          if (candidate !== selected || event.type !== "yield") {
            return;
          }
          observedRoutedAppend = true;
          const observer = new DatabaseSync(path);
          try {
            expect(committedEventCount(path)).toBe(0);
            expect(
              observer.prepare("SELECT current_root_id FROM workspace_state").get()?.[
                "current_root_id"
              ],
            ).toBe(baselineRoot);
            expect(
              observer
                .prepare("SELECT COUNT(*) AS count FROM vfs_dirents WHERE name = 'kept.txt'")
                .get()?.["count"],
            ).toBe(0);
          } finally {
            observer.close();
          }
        },
      },
    );
  });

  it("WAC2: supported topology mutations pass through the provider proof operation", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "atomic-topology" });
      yield* setPrivateWorkspaceClock(database, () => 1_750_000_001_000);

      function* workflow(): Workflow<void> {
        yield* workspaceStep(database, "topology", function* (filesystem) {
          yield* filesystem.mkdir("/nested", { mode: 0o750 });
          yield* filesystem.writeFile("/nested/file.txt", "first");
          yield* filesystem.writeFile("/nested/file.txt", "overwritten");
          yield* filesystem.writeFile("/discard.txt", "discard");
          yield* filesystem.remove("/discard.txt");
          yield* filesystem.rename("/nested/file.txt", "/nested/renamed.txt");
          yield* filesystem.chmod("/nested/renamed.txt", 0o600);
          yield* filesystem.symlink("/nested/renamed.txt", "/current.txt");
          yield* filesystem.link("/nested/renamed.txt", "/hardlink.txt");
          return null;
        });
      }

      yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));
      const inspected = yield* database.transact(function* (transaction) {
        return yield* withPrivateWorkspaceTransaction(database, transaction, function* (workspace) {
          return {
            renamed: yield* workspace.filesystem.readTextFile("/nested/renamed.txt"),
            hardlink: yield* workspace.filesystem.readTextFile("/hardlink.txt"),
            target: yield* workspace.filesystem.readlink("/current.txt"),
            mode: (yield* workspace.filesystem.stat("/nested/renamed.txt")).mode,
            discarded: yield* raised(workspace.filesystem.stat("/discard.txt")),
          };
        });
      });
      if (!inspected.ok) {
        throw inspected.error;
      }
      expect(inspected.value).toEqual({
        renamed: "overwritten",
        hardlink: "overwritten",
        target: "/nested/renamed.txt",
        mode: 0o600,
        discarded: expect.any(Error),
      });
    });
  });

  it("WAC3: a known filesystem failure commits one failed Yield on the prior root", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-known-failure";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const baseline = yield* inspectWorkspace(database, "/temporary.txt");
      let caught: unknown;
      function* workflow(): Workflow<void> {
        try {
          yield* workspaceStep(database, "known", function* (filesystem) {
            yield* filesystem.writeFile("/temporary.txt", "rolled back");
            yield* filesystem.readTextFile("/missing.txt");
            return null;
          });
        } catch (error) {
          caught = error;
        }
      }

      yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));
      expect(caught).toBeInstanceOf(Error);
      if (!(caught instanceof Error)) {
        throw new Error("the failed Workspace result did not restore an Error");
      }
      expect(caught.name).toBe("WorkspaceFsError");
      const after = yield* inspectWorkspace(database, "/temporary.txt");
      expect(after).toEqual(baseline);
      const events = workspaceYields(yield* database.journal.readAll());
      expect(events).toHaveLength(1);
      expect(events[0]?.result.status).toBe("err");
      expect(journalRoot(runPath(root, runId), "known")).toBe(baseline.root);
    });
  });

  it("WAC4: journal insertion failure rolls back mutation, root and pointer", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-insert-failure";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const baseline = yield* inspectWorkspace(database, "/uncommitted.txt");
      const path = runPath(root, runId);
      refuseJournalInsertNamed(path, "refused");
      let caught: unknown;
      let laterExecutions = 0;
      function* workflow(): Workflow<void> {
        try {
          yield* workspaceStep(database, "refused", function* (filesystem) {
            yield* filesystem.writeFile("/uncommitted.txt", "must roll back");
            return null;
          });
        } catch (error) {
          caught = error;
        }
        yield* durableCall("fenced-after-insert", function* () {
          laterExecutions += 1;
          return null;
        });
      }

      const failure = yield* raised(
        withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
      );
      expect(failure).toBeInstanceOf(DurablePersistenceError);
      expect(failure).toBe(caught);
      expect(laterExecutions).toBe(0);
      if (!(failure instanceof DurablePersistenceError)) {
        throw new Error("the journal refusal did not activate durable persistence failure");
      }
      expect(failure.cause).toBeInstanceOf(Error);
      allowJournalInserts(path);
      expect(yield* inspectWorkspace(database, "/uncommitted.txt")).toEqual(baseline);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC5: secret-gate rejection precedes insertion and rolls back everything", function* () {
    const root = yield* useStorageRoot();
    const gateFailure = new Error("secret gate rejected Workspace output");

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "atomic-secret" });
      const baseline = yield* inspectWorkspace(database, "/secret.txt");
      let gateCalls = 0;
      const guarded = guardDurableStream(database.journal, function* (event) {
        if (event.type === "yield") {
          gateCalls += 1;
          throw gateFailure;
        }
      });
      function* workflow(): Workflow<void> {
        yield* workspaceStep(database, "secret", function* (filesystem) {
          yield* filesystem.writeFile("/secret.txt", "filtered bytes");
          return null;
        });
      }

      const failure = yield* raised(
        withWorkspaceEffects(database, durableRun(workflow, { stream: guarded })),
      );
      expect(failure).toBe(gateFailure);
      expect(gateCalls).toBe(1);
      expect(yield* inspectWorkspace(database, "/secret.txt")).toEqual(baseline);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC6: cancellation before, during and during teardown publishes nothing", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      for (const point of ["before", "during", "teardown"] as const) {
        yield* scoped(function* () {
          const database = yield* createRun({ runId: `atomic-cancel-${point}` });
          const path = `/${point}.txt`;
          const baseline = yield* inspectWorkspace(database, path);
          const reached = withResolvers<void>();
          const release = withResolvers<void>();

          function* workflow(): Workflow<void> {
            yield* workspaceStep(database, `cancel-${point}`, function* (filesystem) {
              if (point === "before") {
                reached.resolve();
                yield* suspend();
              }
              yield* filesystem.writeFile(path, "cancelled");
              if (point === "during") {
                reached.resolve();
                yield* suspend();
              }
              if (point === "teardown") {
                const childReady = withResolvers<void>();
                yield* spawn(function* () {
                  yield* ensure(function* () {
                    reached.resolve();
                    yield* release.operation;
                  });
                  childReady.resolve();
                  yield* suspend();
                });
                yield* childReady.operation;
              }
              return null;
            });
          }

          const task = yield* spawn(() =>
            withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
          );
          yield* reached.operation;
          const halting = yield* spawn(() => task.halt());
          if (point === "teardown") {
            release.resolve();
          }
          yield* halting;
          expect(yield* inspectWorkspace(database, path)).toEqual(baseline);
          expect(yield* database.journal.readAll()).toEqual([]);
        });
      }
    });
  });

  it("WAC7: infrastructure failure poisons later Workspace and ordinary effects", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const runId = "atomic-poison";
      const database = yield* createRun({ runId });
      const baseline = yield* inspectWorkspace(database, "/poisoned.txt");
      const path = runPath(root, runId);
      let caught: unknown;
      let laterWorkspace = 0;
      let laterOrdinary = 0;
      tamper(path, (sqlite) => {
        sqlite.exec(`
          CREATE TRIGGER refuse_root_capture BEFORE INSERT ON workspace_roots
          BEGIN
            SELECT raise(ABORT, 'root capture refused');
          END
        `);
      });

      function* workflow(): Workflow<void> {
        try {
          yield* workspaceStep(database, "poison", function* (filesystem) {
            yield* filesystem.writeFile("/poisoned.txt", "must roll back");
            return null;
          });
        } catch (error) {
          caught = error;
        }
        yield* workspaceStep(database, "later-workspace", function* () {
          laterWorkspace += 1;
          return null;
        });
        yield* durableCall("later-ordinary", function* () {
          laterOrdinary += 1;
          return null;
        });
      }

      const escaped = yield* raised(
        withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
      );
      expect(escaped).toBe(caught);
      expect(escaped).toBeInstanceOf(Error);
      expect({ laterWorkspace, laterOrdinary }).toEqual({ laterWorkspace: 0, laterOrdinary: 0 });
      tamper(path, (sqlite) => sqlite.exec("DROP TRIGGER refuse_root_capture"));
      expect(yield* inspectWorkspace(database, "/poisoned.txt")).toEqual(baseline);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC8: unrelated same-run work waits, while another run remains usable", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "atomic-concurrent-first" });
      const sameRun = yield* createRun({ runId: "atomic-concurrent-first" });
      const second = yield* createRun({ runId: "atomic-concurrent-second" });
      const mutationStarted = withResolvers<void>();
      const releaseMutation = withResolvers<void>();
      let unrelatedFinished = false;
      const unrelated: Yield = {
        type: "yield",
        coroutineId: "unrelated",
        description: { type: "call", name: "unrelated" },
        result: { status: "ok", value: null },
      };

      function* workflow(): Workflow<void> {
        yield* workspaceStep(first, "concurrent", function* (filesystem) {
          yield* filesystem.writeFile("/first.txt", "first");
          yield* second.journal.append({
            ...unrelated,
            coroutineId: "second-run",
          });
          mutationStarted.resolve();
          yield* releaseMutation.operation;
          return null;
        });
      }

      const effect = yield* spawn(() =>
        withWorkspaceEffects(first, durableRun(workflow, { stream: first.journal })),
      );
      yield* mutationStarted.operation;
      const append = yield* spawn(function* () {
        yield* sameRun.journal.append(unrelated);
        unrelatedFinished = true;
      });
      expect(unrelatedFinished).toBe(false);
      expect(yield* second.journal.readAll()).toHaveLength(1);
      releaseMutation.resolve();
      yield* effect;
      yield* append;
      expect(unrelatedFinished).toBe(true);
      expect(workspaceYields(yield* first.journal.readAll())).toHaveLength(1);
    });
  });

  it("WAC9: replay bypasses the Deno coordinator and mutation", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "atomic-replay" });
      yield* database.journal.append({
        type: "yield",
        coroutineId: "root",
        description: { type: "workspace-proof", name: "replayed" },
        result: { status: "ok", value: "retained" },
      });
      let mutations = 0;
      function* workflow(): Workflow<string> {
        yield* workspaceStep(database, "replayed", function* () {
          mutations += 1;
          return "live";
        });
        return "done";
      }

      expect(
        yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
      ).toBe("done");
      expect(mutations).toBe(0);
    });
  });

  it("WAC10: closed and foreign database authority reaches no mutation", function* () {
    const root = yield* useStorageRoot();
    let closed: WorkflowRunDatabase | undefined;
    const savepoints: string[] = [];
    yield* SavepointObservation.set((event) => {
      if (event.kind === "create") {
        savepoints.push(event.name);
      }
    });

    yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "atomic-authority-first" });
      const second = yield* createRun({ runId: "atomic-authority-second" });
      closed = first;
      let foreignMutations = 0;
      function* foreignWorkflow(): Workflow<void> {
        yield* workspaceStep(second, "foreign", function* () {
          foreignMutations += 1;
          return null;
        });
      }
      savepoints.length = 0;
      expect(
        yield* raised(
          withWorkspaceEffects(first, durableRun(foreignWorkflow, { stream: first.journal })),
        ),
      ).toBeInstanceOf(Error);
      expect(foreignMutations).toBe(0);
      expect(savepoints).toEqual([]);

      let missingMutations = 0;
      function* missingWorkflow(): Workflow<void> {
        yield createDurableWorkspaceOperation(
          { type: "workspace-proof", name: "missing-authority" },
          function* () {
            missingMutations += 1;
            return null;
          },
        );
      }
      expect(
        yield* raised(
          withWorkspaceEffects(first, durableRun(missingWorkflow, { stream: first.journal })),
        ),
      ).toBeInstanceOf(Error);
      expect(missingMutations).toBe(0);
      expect(savepoints).toEqual([]);

      let forgedMutations = 0;
      function* forgedExecute(): Operation<null> {
        forgedMutations += 1;
        return null;
      }
      Object.defineProperty(
        forgedExecute,
        Symbol.for("executablemd.workflow.deno.workspace.effect.owner"),
        { value: first },
      );
      function* forgedWorkflow(): Workflow<void> {
        yield createDurableWorkspaceOperation(
          { type: "workspace-proof", name: "forged-authority" },
          forgedExecute,
        );
      }
      expect(
        yield* raised(
          withWorkspaceEffects(first, durableRun(forgedWorkflow, { stream: first.journal })),
        ),
      ).toBeInstanceOf(Error);
      expect(forgedMutations).toBe(0);
      expect(savepoints).toEqual([]);
      expect(yield* first.journal.readAll()).toEqual([]);
      expect(yield* second.journal.readAll()).toEqual([]);
    });
    if (closed === undefined) {
      throw new Error("the closed database proof did not retain its handle");
    }
    const stale = closed;
    yield* withStorage(root, function* () {
      const current = yield* createRun({ runId: "atomic-authority-first" });
      let mutations = 0;
      function* workflow(): Workflow<void> {
        yield* workspaceStep(stale, "closed", function* () {
          mutations += 1;
          return null;
        });
      }
      savepoints.length = 0;
      expect(
        yield* raised(withWorkspaceEffects(stale, durableRun(workflow, { stream: stale.journal }))),
      ).toBeInstanceOf(Error);
      expect(mutations).toBe(0);
      expect(savepoints).toEqual([]);
      expect(yield* current.journal.readAll()).toEqual([]);
    });
  });

  it("WAC11: foreign publication destinations are refused before mutation", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const selected = yield* createRun({ runId: "atomic-destination-selected" });
      const other = yield* createRun({ runId: "atomic-destination-other" });
      const baseline = yield* inspectWorkspace(selected, "/wrong-destination.txt");
      const copied: DurableStream = {
        readAll: () => selected.journal.readAll(),
        append: (event) => selected.journal.append(event),
      };
      for (const key of Reflect.ownKeys(selected.journal)) {
        const descriptor = Object.getOwnPropertyDescriptor(selected.journal, key);
        if (descriptor !== undefined) {
          Object.defineProperty(copied, key, descriptor);
        }
      }
      Object.defineProperty(copied, Symbol.for("executablemd.durable-stream.inherit-provenance"), {
        value: () => undefined,
      });

      for (const stream of [new InMemoryStream(), other.journal, copied]) {
        let mutations = 0;
        let caught: unknown;
        let laterExecutions = 0;
        function* workflow(): Workflow<void> {
          try {
            yield* workspaceStep(selected, "wrong-destination", function* (filesystem) {
              mutations += 1;
              yield* filesystem.writeFile("/wrong-destination.txt", "must not run");
              return null;
            });
          } catch (error) {
            caught = error;
          }
          yield* durableCall("fenced-after-wrong-destination", function* () {
            laterExecutions += 1;
            return null;
          });
        }

        const failure = yield* raised(
          withWorkspaceEffects(selected, durableRun(workflow, { stream })),
        );
        expect(failure).toBe(caught);
        expect(failure).toBeInstanceOf(Error);
        expect(mutations).toBe(0);
        expect(laterExecutions).toBe(0);
        expect(yield* inspectWorkspace(selected, "/wrong-destination.txt")).toEqual(baseline);
        expect(yield* selected.journal.readAll()).toEqual([]);
        expect(yield* other.journal.readAll()).toEqual([]);
        if (stream instanceof InMemoryStream) {
          expect(stream.snapshot()).toEqual([]);
        }
      }
    });
  });

  it("WAC12: failure after routed publication rolls the whole transaction back", function* () {
    const root = yield* useStorageRoot();
    const commitFailure = new Error("transaction owner refused commit");
    const runId = "atomic-post-publication";
    const path = join(root, `${runId}.sqlite`);
    let selected: WorkflowRunDatabase | undefined;
    let armed = false;

    yield* withDirectWorkspaceStorage(
      root,
      runId,
      () => {},
      function* (database) {
        selected = database;
        const baseline = yield* inspectWorkspace(database, "/post-publication.txt");
        const roots = retainedRootCount(path);
        let gateCalls = 0;
        let caught: unknown;
        let laterExecutions = 0;
        const guarded = guardDurableStream(database.journal, function* (event) {
          if (event.type === "yield") {
            gateCalls += 1;
          }
        });
        function* workflow(): Workflow<void> {
          try {
            yield* workspaceStep(database, "post-publication", function* (filesystem) {
              yield* filesystem.writeFile("/post-publication.txt", "rolled back");
              return null;
            });
          } catch (error) {
            caught = error;
          }
          yield* durableCall("fenced-after-commit", function* () {
            laterExecutions += 1;
            return null;
          });
        }

        armed = true;
        const failure = yield* raised(
          withWorkspaceEffects(database, durableRun(workflow, { stream: guarded })),
        );
        armed = false;
        expect(failure).toBe(commitFailure);
        expect(caught).toBe(commitFailure);
        expect(gateCalls).toBe(1);
        expect(laterExecutions).toBe(0);
        expect(yield* inspectWorkspace(database, "/post-publication.txt")).toEqual(baseline);
        expect(retainedRootCount(path)).toBe(roots);
        expect(yield* database.journal.readAll()).toEqual([]);
      },
      {
        // deno-lint-ignore require-yield
        *beforeCommit(candidate): Operation<void> {
          if (armed && candidate === selected) {
            throw commitFailure;
          }
        },
      },
    );
  });

  it("WAC13: cancellation before commit publishes no protocol event", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-cancel-before-commit";
    const path = join(root, `${runId}.sqlite`);
    const reachedPublication = withResolvers<void>();
    let selected: WorkflowRunDatabase | undefined;

    yield* withDirectWorkspaceStorage(
      root,
      runId,
      () => {},
      function* (database) {
        selected = database;
        const baseline = yield* inspectWorkspace(database, "/cancel-before-commit.txt");
        const roots = retainedRootCount(path);
        let gateCalls = 0;
        const guarded = guardDurableStream(database.journal, function* (event) {
          if (event.type === "yield") {
            gateCalls += 1;
          }
        });
        function* workflow(): Workflow<void> {
          yield* workspaceStep(database, "cancel-before-commit", function* (filesystem) {
            yield* filesystem.writeFile("/cancel-before-commit.txt", "rolled back");
            return null;
          });
        }

        const task = yield* spawn(() =>
          withWorkspaceEffects(database, durableRun(workflow, { stream: guarded })),
        );
        yield* reachedPublication.operation;
        yield* task.halt();
        expect(gateCalls).toBe(1);
        expect(yield* inspectWorkspace(database, "/cancel-before-commit.txt")).toEqual(baseline);
        expect(retainedRootCount(path)).toBe(roots);
        expect(yield* database.journal.readAll()).toEqual([]);
      },
      {
        *afterRoutedJournalAppend(candidate, event): Operation<void> {
          if (candidate === selected && event.type === "yield") {
            reachedPublication.resolve();
            yield* suspend();
          }
        },
      },
    );
  });

  it("WAC14: cancellation leaves no DOFS continuation beyond savepoint teardown", function* () {
    const source = yield* readTextFile(
      new URL("../src/deno/workspace/filesystem.ts", import.meta.url),
    );
    expect(source.includes("writeFileSync")).toBe(true);
    expect(source.includes("readRangeSync")).toBe(true);
    for (const forbidden of [
      "until(",
      "Response",
      "ReadableStream",
      "WorkspaceFilesystemOperations",
    ]) {
      expect(source.includes(forbidden)).toBe(false);
    }

    const root = yield* useStorageRoot();
    let activeOrder: string[] | undefined;
    yield* SavepointObservation.set((event) => {
      if (event.kind === "rollback") {
        activeOrder?.push("savepoint-rollback");
      }
    });

    yield* withStorage(root, function* () {
      for (const phase of ["before", "after"] as const) {
        yield* scoped(function* () {
          const runId = `atomic-synchronous-${phase}`;
          const database = yield* createRun({ runId });
          const baseline = yield* inspectWorkspace(database, "/pending.txt");
          const reached = withResolvers<void>();
          const order: string[] = [];
          activeOrder = order;

          function* workflow(): Workflow<void> {
            yield* workspaceStep(database, `synchronous-${phase}`, function* (filesystem) {
              yield* ensure(function* () {
                order.push("mutation-teardown");
              });
              if (phase === "before") {
                order.push("before-call");
                reached.resolve();
                yield* suspend();
              }
              yield* filesystem.writeFile("/pending.txt", "cancelled bytes");
              order.push("after-call");
              reached.resolve();
              yield* suspend();
              return null;
            });
          }
          const task = yield* spawn(() =>
            withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
          );
          yield* reached.operation;
          yield* task.halt();
          activeOrder = undefined;
          expect(order[0]).toBe(`${phase}-call`);
          expect(order.indexOf("mutation-teardown")).toBeGreaterThan(0);
          expect(order.indexOf("savepoint-rollback")).toBeGreaterThan(
            order.indexOf("mutation-teardown"),
          );
          expect(yield* inspectWorkspace(database, "/pending.txt")).toEqual(baseline);
          expect(yield* database.journal.readAll()).toEqual([]);
        });
      }
    });
  });

  it("WAC15: mutation-child teardown failure is infrastructure failure", function* () {
    const root = yield* useStorageRoot();
    const teardownFailure = new Error("mutation child teardown failed");

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "atomic-teardown-failure" });
      const baseline = yield* inspectWorkspace(database, "/teardown.txt");
      let caught: unknown;
      let laterExecutions = 0;
      function* workflow(): Workflow<void> {
        try {
          yield* workspaceStep(database, "teardown-failure", function* (filesystem) {
            const ready = withResolvers<void>();
            yield* spawn(function* () {
              yield* ensure(function* () {
                throw teardownFailure;
              });
              ready.resolve();
              yield* suspend();
            });
            yield* ready.operation;
            yield* filesystem.writeFile("/teardown.txt", "rolled back");
            return null;
          });
        } catch (error) {
          caught = error;
        }
        yield* durableCall("fenced-after-teardown", function* () {
          laterExecutions += 1;
          return null;
        });
      }

      const failure = yield* raised(
        withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
      );
      expect(failure).toBe(caught);
      expect(failure).toBe(teardownFailure);
      expect(laterExecutions).toBe(0);
      expect(yield* inspectWorkspace(database, "/teardown.txt")).toEqual(baseline);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC16: current-root publication failure rolls retained state back", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const runId = "atomic-current-root-failure";
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/current-root.txt");
      const roots = retainedRootCount(path);
      let caught: unknown;
      let laterExecutions = 0;
      tamper(path, (sqlite) => {
        sqlite.exec(`
          CREATE TRIGGER refuse_current_root BEFORE UPDATE OF current_root_id ON workspace_state
          BEGIN
            SELECT raise(ABORT, 'current root publication refused');
          END
        `);
      });
      function* workflow(): Workflow<void> {
        try {
          yield* workspaceStep(database, "current-root-failure", function* (filesystem) {
            yield* filesystem.writeFile("/current-root.txt", "rolled back");
            return null;
          });
        } catch (error) {
          caught = error;
        }
        yield* durableCall("fenced-after-current-root", function* () {
          laterExecutions += 1;
          return null;
        });
      }

      const failure = yield* raised(
        withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
      );
      expect(failure).toBe(caught);
      expect(failure).toBeInstanceOf(Error);
      expect(laterExecutions).toBe(0);
      tamper(path, (sqlite) => sqlite.exec("DROP TRIGGER refuse_current_root"));
      expect(yield* inspectWorkspace(database, "/current-root.txt")).toEqual(baseline);
      expect(retainedRootCount(path)).toBe(roots);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC17: an existing durability failure wins before Workspace coordination", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const runId = "atomic-existing-failure";
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/never-runs.txt");
      refuseJournalInsertNamed(path, "first-failure");
      let caught: unknown;
      let workspaceExecutions = 0;
      function* workflow(): Workflow<void> {
        try {
          yield* durableCall("first-failure", function* () {
            return null;
          });
        } catch (error) {
          caught = error;
        }
        yield* workspaceStep(database, "blocked-workspace", function* (filesystem) {
          workspaceExecutions += 1;
          yield* filesystem.writeFile("/never-runs.txt", "blocked");
          return null;
        });
      }

      const failure = yield* raised(
        withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
      );
      allowJournalInserts(path);
      expect(failure).toBe(caught);
      expect(failure).toBeInstanceOf(DurablePersistenceError);
      expect(workspaceExecutions).toBe(0);
      expect(yield* inspectWorkspace(database, "/never-runs.txt")).toEqual(baseline);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC18: savepoint SQL failure poisons the coordinated outer transaction", function* () {
    const root = yield* useStorageRoot();

    for (const phase of ["create", "release", "rollback"] as const) {
      let armed = false;
      let operationName: string | undefined;
      const observed: Array<{ kind: string; name: string }> = [];
      const observe: SavepointObserver = (event) => {
        observed.push(event);
        if (armed && operationName === undefined && event.kind === "create") {
          operationName = event.name;
        }
      };

      yield* withDirectWorkspaceStorage(
        root,
        `atomic-savepoint-${phase}`,
        observe,
        function* (database, connection) {
          const baseline = yield* inspectWorkspace(database, "/savepoint.txt");
          const roots = retainedRootCount(connection.path);
          let caught: unknown;
          let laterExecutions = 0;
          observed.length = 0;
          armed = true;
          setSqliteAuthorizer(connection.database, (action, operation, name) => {
            if (!armed || action !== SQLITE_SAVEPOINT) {
              return SQLITE_OK;
            }
            if (phase === "create" && operation === "BEGIN") {
              return SQLITE_DENY;
            }
            if (phase === "release" && operation === "RELEASE" && name === operationName) {
              return SQLITE_DENY;
            }
            if (phase === "rollback" && operation === "ROLLBACK" && name === operationName) {
              return SQLITE_DENY;
            }
            return SQLITE_OK;
          });

          function* workflow(): Workflow<void> {
            try {
              yield* workspaceStep(database, `savepoint-${phase}`, function* (filesystem) {
                yield* filesystem.writeFile("/savepoint.txt", "rolled back");
                if (phase === "rollback") {
                  throw new Error("force operation savepoint rollback");
                }
                return null;
              });
            } catch (error) {
              caught = error;
            }
            yield* durableCall(`fenced-after-savepoint-${phase}`, function* () {
              laterExecutions += 1;
              return null;
            });
          }

          const failure = yield* raised(
            withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
          );
          armed = false;
          setSqliteAuthorizer(connection.database, null);
          expect(failure).toBe(caught);
          expect(failure).toBeInstanceOf(Error);
          expect(laterExecutions).toBe(0);
          expect(yield* inspectWorkspace(database, "/savepoint.txt")).toEqual(baseline);
          expect(retainedRootCount(connection.path)).toBe(roots);
          expect(yield* database.journal.readAll()).toEqual([]);
          if (phase === "create") {
            expect(observed.some((event) => event.kind === "create")).toBe(false);
          } else {
            expect(operationName).toBeDefined();
            expect(
              observed.some((event) => event.kind === phase && event.name === operationName),
            ).toBe(false);
          }
        },
      );
    }
  });
});
