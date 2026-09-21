import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createApi } from "@effectionx/context-api";
import { readTextFile } from "@effectionx/fs";
import {
  type ActivateDurabilityFailure,
  durableCall,
  durableRun,
  guardDurableStream,
  InMemoryStream,
  preserveJournalProvenance,
  type DurableEvent,
  type DurableEventGate,
  type DurableStream,
  DurablePersistenceError,
  type Json,
  type JournalProvenance,
  type Result,
  type Workflow,
  type Yield,
} from "@executablemd/durable-streams";
import { ensure, type Operation, scoped, spawn, suspend, until, withResolvers } from "effection";
import {
  createDurableWorkspaceOperation,
  WorkspaceCoordination,
  type WorkflowRunDatabase,
} from "../mod.ts";
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
  createWorkflowWorkspaceEffect,
  useWorkspaceEffects,
  withWorkspaceEffects,
  type WorkflowWorkspaceMutation,
  type WorkflowWorkspaceTransaction,
} from "../src/deno/workspace/effect.ts";
import { readWorkflowWorkspace } from "../src/deno/workspace/inspect.ts";
import type { WorkflowWorkspaceSnapshot } from "../src/deno/workspace/inspect.ts";
import type {
  WorkflowWorkspaceParameter,
  WorkflowWorkspaceStorage,
} from "../src/deno/workspace/storage.ts";
import { WorkflowTransactionError } from "../src/storage/errors.ts";
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

interface InvocationCollisionApi {
  coordinate(request: unknown): Operation<unknown>;
}

const WorkspaceInvocationCollision = createApi<InvocationCollisionApi>(
  "executablemd.workflow.workspace.coordination.invocation",
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<unknown> {
      throw new Error("the collision handler did not delegate");
    },
  },
);

/** The diagnostic a provenance refusal must carry, and no other. */
const PROVENANCE_REFUSAL =
  "the live Workspace journal does not have the provenance of the selected WorkflowRun.";

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * The trusted secret-filter composition, as `packages/core` performs it.
 *
 * A guard alone is policy-neutral and leaves an unproven wrapper. Preserving
 * provenance at the wrapping site is what an authorized filter does, so a test
 * that means to exercise an accepted filtered journal says so here.
 */
function trustedFilter(stream: DurableStream, gate: DurableEventGate): DurableStream {
  return preserveJournalProvenance(stream, guardDurableStream(stream, gate));
}

/** A second evaluation of the canonical provenance module, as a loaded copy. */
function* foreignDurableStreamsGuard(): Operation<typeof import("../../durable-streams/guard.ts")> {
  const specifier =
    new URL("../../durable-streams/guard.ts", import.meta.url).href + "?loaded-copy=wac11";
  const load: () => Promise<typeof import("../../durable-streams/guard.ts")> = () =>
    import(specifier);
  return yield* until(load());
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
  yield createWorkflowWorkspaceEffect(
    database,
    { type: "workspace-proof", name },
    ({ filesystem }) => mutate(filesystem),
  );
}

/** The same effect, given the whole transaction rather than its filesystem. */
function* workspaceTransactionStep(
  database: WorkflowRunDatabase,
  name: string,
  mutate: WorkflowWorkspaceMutation<Json>,
): Workflow<void> {
  yield createWorkflowWorkspaceEffect(database, { type: "workspace-proof", name }, mutate);
}

/**
 * A row this suite writes through the storage view, in the view's own terms.
 *
 * Raw SQL and bound parameters rather than a repository helper: what is being
 * proven is the generic boundary, and a feature's own parser reaching it would
 * make the case about that parser instead.
 */
const INSERT_PROOF_REPOSITORY = `INSERT INTO workspace_repositories
  (name, locator, locator_fingerprint, requested_base,
   creation_commit, primary_branch, object_format, checkout_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const PROOF_REPOSITORY = [
  "proof",
  "/remote.git",
  "f".repeat(64),
  null,
  "abcdef0",
  "main",
  "sha1",
  "/kept",
] as const;

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function retainedRepositoryNames(path: string): string[] {
  const sqlite = new DatabaseSync(path);
  try {
    return sqlite
      .prepare("SELECT name FROM workspace_repositories ORDER BY name")
      .all()
      .flatMap((row) => {
        const name = asText(row["name"]);
        return name === undefined ? [] : [name];
      });
  } finally {
    sqlite.close();
  }
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
    const connection = yield* connections.at(path);
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
        const guardedOnce = trustedFilter(database.journal, function* (event) {
          if (event.type === "yield") {
            gateCalls += 1;
          }
        });
        const guarded = trustedFilter(guardedOnce, function* () {});

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
      const guarded = trustedFilter(database.journal, function* (event) {
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

  it("WAC10: a closed and a foreign database handle reach no mutation", function* () {
    const root = yield* useStorageRoot();
    let closed: WorkflowRunDatabase | undefined;
    const savepoints: string[] = [];
    yield* SavepointObservation.set((event) => {
      if (event.kind === "create") {
        savepoints.push(event.name);
      }
    });

    yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "atomic-handle-first" });
      const second = yield* createRun({ runId: "atomic-handle-second" });
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
          { type: "workspace-proof", name: "missing-handle" },
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
          { type: "workspace-proof", name: "forged-handle" },
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
      const current = yield* createRun({ runId: "atomic-handle-first" });
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

  it("WAC11: journal provenance decides the publication destination", function* () {
    const root = yield* useStorageRoot();
    const savepoints: string[] = [];
    yield* SavepointObservation.set((event) => {
      if (event.kind === "create") {
        savepoints.push(event.name);
      }
    });
    const foreignCopy = yield* foreignDurableStreamsGuard();

    yield* withStorage(root, function* () {
      // The selected raw journal and explicitly preserved trusted wrappers of
      // it all carry the same witness, so each reaches mutation and commit.
      // Each gets its own run: a journal that already holds a Close has
      // nothing left to execute.
      const accepted: [string, (journal: DurableStream) => DurableStream][] = [
        ["raw", (journal) => journal],
        ["filtered", (journal) => trustedFilter(journal, function* () {})],
        [
          "nested",
          (journal) =>
            trustedFilter(
              trustedFilter(journal, function* () {}),
              function* () {},
            ),
        ],
      ];
      for (const [name, wrap] of accepted) {
        const database = yield* createRun({ runId: `atomic-destination-${name}` });
        const path = `/accepted-${name}.txt`;
        let mutations = 0;
        function* workflow(): Workflow<void> {
          yield* workspaceStep(database, `accepted-${name}`, function* (filesystem) {
            mutations += 1;
            yield* filesystem.writeFile(path, name);
            return null;
          });
        }

        yield* withWorkspaceEffects(
          database,
          durableRun(workflow, { stream: wrap(database.journal) }),
        );

        expect(mutations).toBe(1);
        expect((yield* inspectWorkspace(database, path)).content).toBe(name);
        expect(workspaceYields(yield* database.journal.readAll())).toHaveLength(1);
      }

      const selected = yield* createRun({ runId: "atomic-destination-selected" });
      const other = yield* createRun({ runId: "atomic-destination-other" });
      const selectedPath = runPath(root, "atomic-destination-selected");
      const baseline = yield* inspectWorkspace(selected, "/wrong-destination.txt");
      const roots = retainedRootCount(selectedPath);

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

      const lookAlike: DurableStream = {
        readAll: () => selected.journal.readAll(),
        append: (event) => selected.journal.append(event),
      };

      const refused: [string, DurableStream][] = [
        ["in-memory", new InMemoryStream()],
        ["another-run", other.journal],
        ["copied", copied],
        ["look-alike", lookAlike],
        // A guard is policy-neutral, so wrapping the right journal proves
        // nothing on its own.
        ["ordinary-guard", guardDurableStream(selected.journal, function* () {})],
        // Another loaded copy holds no association for this journal, so its
        // preservation carries nothing into this copy's provenance.
        [
          "foreign-copy",
          foreignCopy.preserveJournalProvenance(
            selected.journal,
            guardDurableStream(selected.journal, function* () {}),
          ),
        ],
      ];

      for (const [name, stream] of refused) {
        savepoints.length = 0;
        let mutations = 0;
        let caught: unknown;
        let laterExecutions = 0;
        function* workflow(): Workflow<void> {
          try {
            yield* workspaceStep(selected, `wrong-destination-${name}`, function* (filesystem) {
              mutations += 1;
              yield* filesystem.writeFile("/wrong-destination.txt", "must not run");
              return null;
            });
          } catch (error) {
            caught = error;
          }
          yield* durableCall(`fenced-after-${name}`, function* () {
            laterExecutions += 1;
            return null;
          });
        }

        const failure = yield* raised(
          withWorkspaceEffects(selected, durableRun(workflow, { stream })),
        );
        expect(failure).toBe(caught);
        expect(failure).toBeInstanceOf(Error);
        // The refusal names the fact that failed. A generic, stale-identity or
        // unrelated pre-transaction error would satisfy every other assertion
        // here while reporting the wrong thing to whoever reads the run.
        expect(Reflect.get(failure ?? {}, "message")).toBe(PROVENANCE_REFUSAL);
        expect(mutations).toBe(0);
        expect(laterExecutions).toBe(0);
        // Refused before the transaction does any work: no savepoint opened,
        // no root retained, no journal row committed, and the frontier is
        // where it was.
        expect(savepoints).toEqual([]);
        expect(retainedRootCount(selectedPath)).toBe(roots);
        expect(committedEventCount(selectedPath)).toBe(0);
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
        const guarded = trustedFilter(database.journal, function* (event) {
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
        const guarded = trustedFilter(database.journal, function* (event) {
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

  it("WAC19: enclosing coordination middleware cannot suppress publication", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "atomic-middleware-publication" });
      let selections = 0;
      let replacementRuns = 0;
      const replacingMiddleware = {
        provider(_args: [], next: () => object | undefined): object | undefined {
          selections += 1;
          return next();
        },
        *run<T extends Json>(
          [execute, _publish, activateFailure, identity]: [
            () => Operation<T>,
            (result: Result) => Operation<void>,
            ActivateDurabilityFailure,
            JournalProvenance | undefined,
          ],
          next: (
            execute: () => Operation<T>,
            publish: (result: Result) => Operation<void>,
            activateFailure: ActivateDurabilityFailure,
            identity: JournalProvenance | undefined,
          ) => Operation<Result>,
        ): Operation<Result> {
          replacementRuns += 1;
          return yield* next(
            execute,
            // deno-lint-ignore require-yield
            function* () {},
            activateFailure,
            identity,
          );
        },
      };
      function* workflow(): Workflow<void> {
        yield* workspaceStep(database, "middleware-publication", function* (filesystem) {
          yield* filesystem.writeFile("/middleware.txt", "committed together");
          return null;
        });
      }

      yield* scoped(function* () {
        yield* WorkspaceCoordination.around(replacingMiddleware);
        yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));
      });

      expect(selections).toBe(1);
      expect(replacementRuns).toBe(0);
      expect((yield* inspectWorkspace(database, "/middleware.txt")).content).toBe(
        "committed together",
      );
      expect(workspaceYields(yield* database.journal.readAll())).toHaveLength(1);
    });
  });

  it("WAC20: enclosing middleware cannot replace infrastructure failure activation", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const runId = "atomic-middleware-failure";
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/middleware-failure.txt");
      const roots = retainedRootCount(path);
      let replacementRuns = 0;
      let caught: unknown;
      let laterExecutions = 0;
      const replacingMiddleware = {
        provider(_args: [], next: () => object | undefined): object | undefined {
          return next();
        },
        *run<T extends Json>(
          [execute, publish, _activateFailure, identity]: [
            () => Operation<T>,
            (result: Result) => Operation<void>,
            ActivateDurabilityFailure,
            JournalProvenance | undefined,
          ],
          next: (
            execute: () => Operation<T>,
            publish: (result: Result) => Operation<void>,
            activateFailure: ActivateDurabilityFailure,
            identity: JournalProvenance | undefined,
          ) => Operation<Result>,
        ): Operation<Result> {
          replacementRuns += 1;
          return yield* next(execute, publish, () => new Error("replacement failure"), identity);
        },
      };
      tamper(path, (sqlite) => {
        sqlite.exec(`
          CREATE TRIGGER refuse_middleware_root BEFORE INSERT ON workspace_roots
          BEGIN
            SELECT raise(ABORT, 'middleware root capture refused');
          END
        `);
      });
      function* workflow(): Workflow<void> {
        try {
          yield* workspaceStep(database, "middleware-failure", function* (filesystem) {
            yield* filesystem.writeFile("/middleware-failure.txt", "must roll back");
            return null;
          });
        } catch (error) {
          caught = error;
        }
        yield* durableCall("fenced-after-middleware-failure", function* () {
          laterExecutions += 1;
          return null;
        });
      }

      let failure: unknown;
      yield* scoped(function* () {
        yield* WorkspaceCoordination.around(replacingMiddleware);
        failure = yield* raised(
          withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
        );
      });
      tamper(path, (sqlite) => sqlite.exec("DROP TRIGGER refuse_middleware_root"));

      expect(replacementRuns).toBe(0);
      expect(failure).toBe(caught);
      expect(failure).toBeInstanceOf(Error);
      expect(laterExecutions).toBe(0);
      expect(yield* inspectWorkspace(database, "/middleware-failure.txt")).toEqual(baseline);
      expect(retainedRootCount(path)).toBe(roots);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC21: substituted provider selection is refused before transaction work", function* () {
    const root = yield* useStorageRoot();
    const savepoints: string[] = [];
    yield* SavepointObservation.set((event) => {
      if (event.kind === "create") {
        savepoints.push(event.name);
      }
    });

    yield* withStorage(root, function* () {
      const runId = "atomic-substituted-provider";
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/substituted.txt");
      const roots = retainedRootCount(path);
      let mutations = 0;
      function* workflow(): Workflow<void> {
        yield* workspaceStep(database, "substituted-provider", function* (filesystem) {
          mutations += 1;
          yield* filesystem.writeFile("/substituted.txt", "must not run");
          return null;
        });
      }

      savepoints.length = 0;
      let failure: unknown;
      yield* scoped(function* () {
        yield* WorkspaceCoordination.around({ provider: () => Object.freeze({}) });
        failure = yield* raised(
          withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
        );
      });

      expect(failure).toBeInstanceOf(Error);
      expect(mutations).toBe(0);
      expect(savepoints).toEqual([]);
      expect(yield* inspectWorkspace(database, "/substituted.txt")).toEqual(baseline);
      expect(retainedRootCount(path)).toBe(roots);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC22: minimum-priority middleware cannot split publication from commit", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const runId = "atomic-minimum-publication";
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/minimum.txt");
      const roots = retainedRootCount(path);
      const observed: unknown[] = [];
      function* workflow(): Workflow<void> {
        yield* workspaceStep(database, "minimum-publication", function* (filesystem) {
          yield* filesystem.writeFile("/minimum.txt", "committed with Yield");
          return null;
        });
      }

      yield* scoped(function* () {
        yield* WorkspaceInvocationCollision.around(
          {
            // deno-lint-ignore require-yield
            *coordinate(args): Operation<unknown> {
              observed.push(args[0]);
              return { type: "published" };
            },
          },
          { at: "min" },
        );
        yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));
      });

      const committed = yield* inspectWorkspace(database, "/minimum.txt");
      const events = yield* database.journal.readAll();
      expect(observed).toEqual([]);
      expect(committed.content).toBe("committed with Yield");
      expect(committed.root).not.toBe(baseline.root);
      expect(retainedRootCount(path)).toBe(roots + 1);
      expect(workspaceYields(events)).toHaveLength(1);
      expect(journalRoot(path, "minimum-publication")).toBe(committed.root);
    });
  });

  it("WAC23: minimum-priority middleware cannot replace failure activation", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const runId = "atomic-minimum-failure";
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/minimum-failure.txt");
      const roots = retainedRootCount(path);
      let collisions = 0;
      let caught: unknown;
      let laterExecutions = 0;
      tamper(path, (sqlite) => {
        sqlite.exec(`
          CREATE TRIGGER refuse_minimum_root BEFORE INSERT ON workspace_roots
          BEGIN
            SELECT raise(ABORT, 'minimum root capture refused');
          END
        `);
      });
      function* workflow(): Workflow<void> {
        try {
          yield* workspaceStep(database, "minimum-failure", function* (filesystem) {
            yield* filesystem.writeFile("/minimum-failure.txt", "must roll back");
            return null;
          });
        } catch (error) {
          caught = error;
        }
        yield* durableCall("fenced-after-minimum-failure", function* () {
          laterExecutions += 1;
          return null;
        });
      }

      let failure: unknown;
      yield* scoped(function* () {
        yield* WorkspaceInvocationCollision.around(
          {
            // deno-lint-ignore require-yield
            *coordinate(): Operation<unknown> {
              collisions += 1;
              return { type: "failure", failure: new Error("replacement failure") };
            },
          },
          { at: "min" },
        );
        failure = yield* raised(
          withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal })),
        );
      });
      tamper(path, (sqlite) => sqlite.exec("DROP TRIGGER refuse_minimum_root"));

      expect(collisions).toBe(0);
      expect(failure).toBe(caught);
      expect(failure).toBeInstanceOf(Error);
      expect(laterExecutions).toBe(0);
      expect(yield* inspectWorkspace(database, "/minimum-failure.txt")).toEqual(baseline);
      expect(retainedRootCount(path)).toBe(roots);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC24: a row written through the storage view commits with the effect's bytes", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-storage-commit";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/kept/marker.txt");
      let readBackInside: string | undefined;

      function* workflow(): Workflow<void> {
        yield* workspaceTransactionStep(
          database,
          "retain",
          function* ({ filesystem, storage }): Operation<Json> {
            yield* filesystem.mkdir("/kept", { mode: 0o750 });
            yield* filesystem.writeFile("/kept/marker.txt", "checkout bytes", 0o640);
            storage.run(INSERT_PROOF_REPOSITORY, ...PROOF_REPOSITORY);
            // Inside the same transaction and before any commit: the write is
            // visible to the mutation that made it, which is what makes the
            // two halves one fact rather than two.
            readBackInside = asText(
              storage.get("SELECT name FROM workspace_repositories WHERE name = ?", "proof")?.[
                "name"
              ],
            );
            return null;
          },
        );
      }

      yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));

      expect(readBackInside).toBe("proof");
      const committed = yield* inspectWorkspace(database, "/kept/marker.txt");
      expect(committed.content).toBe("checkout bytes");
      expect(committed.root).not.toBe(baseline.root);
      // The row and the bytes are published together, against the same root the
      // journal entry names.
      expect(retainedRepositoryNames(path)).toEqual(["proof"]);
      expect(journalRoot(path, "retain")).toBe(committed.root);
    });
  });

  it("WAC25: a refused mutation takes its rows back with its bytes", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-storage-rollback";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const baseline = yield* inspectWorkspace(database, "/kept/marker.txt");
      const roots = retainedRootCount(path);
      let caught: unknown;

      function* workflow(): Workflow<void> {
        try {
          yield* workspaceTransactionStep(
            database,
            "refused",
            function* ({ filesystem, storage }): Operation<Json> {
              yield* filesystem.mkdir("/kept", { mode: 0o750 });
              yield* filesystem.writeFile("/kept/marker.txt", "must roll back", 0o640);
              storage.run(INSERT_PROOF_REPOSITORY, ...PROOF_REPOSITORY);
              // A known Workspace failure, which is this effect's *failed*
              // durable outcome rather than infrastructure.
              yield* filesystem.readTextFile("/missing.txt");
              return null;
            },
          );
        } catch (error) {
          caught = error;
        }
      }

      yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));

      expect(caught).toBeInstanceOf(Error);
      // Nothing the attempt wrote survives: not the bytes, not the row, and not
      // a published root — and the failed Yield names the root it started from.
      expect(yield* inspectWorkspace(database, "/kept/marker.txt")).toEqual(baseline);
      expect(retainedRepositoryNames(path)).toEqual([]);
      expect(retainedRootCount(path)).toBe(roots);
      const events = workspaceYields(yield* database.journal.readAll());
      expect(events).toHaveLength(1);
      expect(events[0]?.result.status).toBe("err");
      expect(journalRoot(path, "refused")).toBe(baseline.root);
    });
  });

  /**
   * The window a retained view would otherwise still be inside.
   *
   * Not after the run — by then the transaction has ended and its own
   * authorization would refuse anyway, so a case that only looked there would
   * pass with no fence at all. This reaches the view from `beforeCommit`, while
   * the mutation has returned but the transaction that captured and published
   * its root is still open, which is exactly where "for this callback" has to
   * be a fact rather than a convention.
   */
  it("WAC26: every capability a mutation retained answers nothing once it returned", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-storage-retained";
    const path = join(root, `${runId}.sqlite`);
    let selected: WorkflowRunDatabase | undefined;
    let retained: WorkflowWorkspaceTransaction | undefined;
    /**
     * Operations built while the mutation was still valid.
     *
     * The hole a call-time check alone leaves open: a callback creates every
     * operation it wants before returning, and yields them afterwards. So these
     * are made inside the callback and executed from `beforeCommit`, where the
     * mutation has returned and the transaction is still open.
     */
    let prepared: { name: string; operation: Operation<unknown> }[] = [];
    let members: string[] = [];
    let storageMembers: string[] = [];
    let attempted = false;
    const refusals: { name: string; message: string }[] = [];

    yield* withDirectWorkspaceStorage(
      root,
      runId,
      () => {},
      function* (database) {
        selected = database;

        function* workflow(): Workflow<void> {
          yield* workspaceTransactionStep(
            database,
            "retain-view",
            // deno-lint-ignore require-yield
            function* (transaction): Operation<Json> {
              members = Object.keys(transaction).sort();
              storageMembers = Object.keys(transaction.storage).sort();
              retained = transaction;
              prepared = [
                {
                  name: "readTextFile",
                  operation: transaction.filesystem.readTextFile("/kept.txt"),
                },
                {
                  name: "writeFile",
                  operation: transaction.filesystem.writeFile("/escaped.txt", "escaped", 0o640),
                },
                { name: "mkdir", operation: transaction.filesystem.mkdir("/escaped") },
                {
                  name: "savepoint",
                  operation: transaction.savepoint(
                    // deno-lint-ignore require-yield
                    (function* (): Operation<null> {
                      throw new Error("the retained savepoint entered its body");
                    })(),
                  ),
                },
              ];
              return null;
            },
          );
        }

        yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));

        // Three members and no more: no connection, no lease, no journal route
        // and no transaction token travel with the mutation.
        expect(members).toEqual(["filesystem", "savepoint", "storage"]);
        expect(storageMembers).toEqual(["all", "get", "run"]);

        expect(attempted).toBe(true);
        // Every retained capability, synchronous and deferred alike.
        expect(refusals.map((refusal) => refusal.name).sort()).toEqual([
          "all",
          "get",
          "mkdir",
          "readTextFile",
          "run",
          "savepoint",
          "writeFile",
        ]);
        for (const refusal of refusals) {
          expect({
            name: refusal.name,
            held: refusal.message.includes(
              "valid only while the callback that received it is running",
            ),
          }).toEqual({ name: refusal.name, held: true });
        }
        // And nothing any of them attempted reached the run.
        expect(retainedRepositoryNames(path)).toEqual([]);
        const settled = yield* inspectWorkspace(database, "/escaped.txt");
        expect(settled.content).toBe(undefined);
      },
      {
        *beforeCommit(candidate): Operation<void> {
          const transaction = retained;
          if (candidate !== selected || transaction === undefined || attempted) {
            return;
          }
          attempted = true;

          function record(name: string, reach: () => void): void {
            try {
              reach();
            } catch (error) {
              refusals.push({
                name,
                message: error instanceof WorkflowTransactionError ? error.message : "",
              });
            }
          }

          // The synchronous half: called after the callback returned.
          record("run", () =>
            transaction.storage.run(INSERT_PROOF_REPOSITORY, ...PROOF_REPOSITORY),
          );
          record("get", () => {
            transaction.storage.get("SELECT name FROM workspace_repositories");
          });
          record("all", () => {
            transaction.storage.all("SELECT name FROM workspace_repositories");
          });

          // The deferred half: operations built while the callback was valid,
          // executed now. A wrapper that only checked at creation admits these.
          for (const { name, operation } of prepared) {
            try {
              yield* operation;
              refusals.push({ name, message: "" });
            } catch (error) {
              refusals.push({
                name,
                message: error instanceof WorkflowTransactionError ? error.message : "",
              });
            }
          }
        },
      },
    );
  });
});

/**
 * Tier WAR — reading the Workspace without performing an effect.
 *
 * The other half of the same authority. An inspection opens the run's own
 * transaction, reads, and closes it; it journals nothing, publishes nothing,
 * and has no writing surface at all. What these measure is that the narrowing
 * is real — not a promise the callback is trusted to keep — and that reading a
 * root the run has moved on from leaves the run exactly where it was.
 */
describe("Tier WAR — read-only Workspace inspection", () => {
  /** One effect that writes a file and a row, so there is history to read back. */
  function* retain(
    database: WorkflowRunDatabase,
    content: string,
    row?: readonly WorkflowWorkspaceParameter[],
  ): Operation<void> {
    function* workflow(): Workflow<void> {
      yield* workspaceTransactionStep(
        database,
        "retain",
        function* ({ filesystem, storage }): Operation<Json> {
          yield* filesystem.writeFile("/kept.txt", content, 0o640);
          if (row !== undefined) {
            storage.run(INSERT_PROOF_REPOSITORY, ...row);
          }
          return null;
        },
      );
    }
    yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));
  }

  /**
   * Two effects in one run, and the root the first of them published.
   *
   * One `durableRun` rather than two: a second run over the same journal reads
   * a recorded `Close` and replays its result without entering the body, so two
   * calls would leave the Workspace holding only what the first one wrote.
   */
  function* retainTwice(database: WorkflowRunDatabase, path: string): Operation<string> {
    function* workflow(): Workflow<void> {
      yield* workspaceTransactionStep(
        database,
        "first",
        function* ({ filesystem }): Operation<Json> {
          yield* filesystem.writeFile("/kept.txt", "the earlier bytes", 0o640);
          return null;
        },
      );
      yield* workspaceTransactionStep(
        database,
        "second",
        function* ({ filesystem }): Operation<Json> {
          yield* filesystem.writeFile("/kept.txt", "the later bytes", 0o640);
          return null;
        },
      );
    }
    yield* withWorkspaceEffects(database, durableRun(workflow, { stream: database.journal }));
    const earlier = journalRoot(path, "first");
    if (earlier === undefined) {
      throw new Error("the first effect published no Workspace root");
    }
    return earlier;
  }

  it("WAR1: reads the current root's bytes and rows, and writes through neither", function* () {
    const root = yield* useStorageRoot();
    const runId = "inspect-current";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      yield* retain(database, "current bytes", PROOF_REPOSITORY);
      const current = (yield* inspectWorkspace(database, "/kept.txt")).root;
      const roots = retainedRootCount(path);

      let members: string[] = [];
      let storageMembers: string[] = [];
      const read = yield* readWorkflowWorkspace(database, {}, function* (snapshot) {
        members = Object.keys(snapshot).sort();
        storageMembers = Object.keys(snapshot.storage).sort();
        return {
          content: yield* snapshot.filesystem.readTextFile("/kept.txt"),
          names: snapshot.storage
            .all("SELECT name FROM workspace_repositories ORDER BY name")
            .flatMap((entry) => {
              const name = asText(entry["name"]);
              return name === undefined ? [] : [name];
            }),
        };
      });
      if (!read.ok) {
        throw read.error;
      }

      expect(read.value).toEqual({ content: "current bytes", names: ["proof"] });
      expect(members).toEqual(["filesystem", "storage"]);
      // No `run`, and no write on the filesystem either: an inspection holds
      // objects that have no writing member for a guard to be the only thing in
      // front of.
      expect(storageMembers).toEqual(["all", "get"]);
      // Nothing moved: not the current root, and not the retained ones.
      expect((yield* inspectWorkspace(database, "/kept.txt")).root).toBe(current);
      expect(retainedRootCount(path)).toBe(roots);
    });
  });

  it("WAR2: reads a retained root and leaves the run on the one it was on", function* () {
    const root = yield* useStorageRoot();
    const runId = "inspect-retained";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const earlier = yield* retainTwice(database, path);
      const current = yield* inspectWorkspace(database, "/kept.txt");
      expect(current.content).toBe("the later bytes");
      expect(current.root).not.toBe(earlier);
      const roots = retainedRootCount(path);

      const read = yield* readWorkflowWorkspace(database, { rootId: earlier }, (snapshot) =>
        snapshot.filesystem.readTextFile("/kept.txt"),
      );
      if (!read.ok) {
        throw read.error;
      }

      // The historical bytes, and the run still on the root it was on. The
      // materialization that produced them is rolled back before anything else
      // can observe the Workspace selected at the earlier root.
      expect(read.value).toBe("the earlier bytes");
      expect(yield* inspectWorkspace(database, "/kept.txt")).toEqual(current);
      expect(retainedRootCount(path)).toBe(roots);
    });
  });

  /**
   * What takes the materialization back on these two paths, and what does not.
   *
   * WAR2 is the case that discriminates the rollback-only savepoint: there the
   * inspection *succeeds*, the transaction commits, and only that savepoint
   * stands between a historical read and a run left on a root it never
   * published. Here the transaction itself ends without committing, so the
   * rollback is over-determined — which is the point. The claim is the outcome
   * the caller is owed on every exit, and the case also proves the run is still
   * usable afterwards rather than poisoned by a materialization that was
   * interrupted half way through.
   */
  it("WAR3: a failure and a cancellation each leave the run where they found it", function* () {
    const root = yield* useStorageRoot();
    const runId = "inspect-rollback";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      const earlier = yield* retainTwice(database, path);
      const current = yield* inspectWorkspace(database, "/kept.txt");
      const roots = retainedRootCount(path);

      // A failure inside the callback, after the retained root materialized.
      const raised = new Error("the inspection failed after materializing");
      const failed = yield* readWorkflowWorkspace(
        database,
        { rootId: earlier },
        // deno-lint-ignore require-yield
        function* (snapshot): Operation<string> {
          void snapshot;
          throw raised;
        },
      );
      expect(failed.ok).toBe(false);
      expect(failed.ok ? undefined : failed.error).toBe(raised);
      expect(yield* inspectWorkspace(database, "/kept.txt")).toEqual(current);
      expect(retainedRootCount(path)).toBe(roots);

      // And a cancellation, halted while the callback is suspended inside the
      // materialized root.
      const entered = withResolvers<void>();
      yield* scoped(function* () {
        const inspecting = yield* spawn(() =>
          readWorkflowWorkspace(database, { rootId: earlier }, function* (snapshot) {
            void snapshot;
            entered.resolve();
            yield* suspend();
            return "unreachable";
          }),
        );
        yield* entered.operation;
        yield* inspecting.halt();
      });

      expect(yield* inspectWorkspace(database, "/kept.txt")).toEqual(current);
      expect(retainedRootCount(path)).toBe(roots);

      // And the connection is still usable: a later inspection opens the run's
      // transaction again and reads the root the cancellation left it on,
      // rather than finding a half-materialized Workspace or a poisoned handle.
      const after = yield* readWorkflowWorkspace(database, {}, (snapshot) =>
        snapshot.filesystem.readTextFile("/kept.txt"),
      );
      if (!after.ok) {
        throw after.error;
      }
      expect(after.value).toBe(current.content);
    });
  });

  it("WAR4: a retained snapshot answers nothing once its inspection returned", function* () {
    const root = yield* useStorageRoot();
    const runId = "inspect-retained-view";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      yield* retain(database, "current bytes", PROOF_REPOSITORY);

      let escaped: WorkflowWorkspaceSnapshot | undefined;
      const read = yield* readWorkflowWorkspace(database, {}, function* (snapshot) {
        escaped = snapshot;
        return yield* snapshot.filesystem.readTextFile("/kept.txt");
      });
      if (!read.ok) {
        throw read.error;
      }
      expect(read.value).toBe("current bytes");

      const held = escaped;
      if (held === undefined) {
        throw new Error("the inspection was never given a snapshot");
      }
      expect(() => held.storage.all("SELECT name FROM workspace_repositories")).toThrow(
        WorkflowTransactionError,
      );
      expect(() => held.storage.get("SELECT name FROM workspace_repositories")).toThrow(
        WorkflowTransactionError,
      );
      // The filesystem half is revoked by the same gate, before the operation
      // it would return is ever entered.
      expect(() => held.filesystem.readTextFile("/kept.txt")).toThrow(WorkflowTransactionError);
    });
  });

  it("WAR5: an operation built inside the inspection refuses when it is run after", function* () {
    const root = yield* useStorageRoot();
    const runId = "inspect-deferred";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      yield* retain(database, "current bytes", PROOF_REPOSITORY);
      const current = yield* inspectWorkspace(database, "/kept.txt");
      const roots = retainedRootCount(path);

      // Built while the snapshot was valid, carried out of the callback, and
      // yielded afterwards. A gate checked only when the member is called would
      // let this one through.
      let deferred: Operation<string> | undefined;
      const read = yield* readWorkflowWorkspace(database, {}, function* (snapshot) {
        deferred = snapshot.filesystem.readTextFile("/kept.txt");
        return yield* snapshot.filesystem.readTextFile("/kept.txt");
      });
      if (!read.ok) {
        throw read.error;
      }
      expect(read.value).toBe("current bytes");

      const escaped = deferred;
      if (escaped === undefined) {
        throw new Error("the inspection built no deferred operation");
      }
      let refusal: unknown;
      try {
        yield* escaped;
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(WorkflowTransactionError);
      expect(refusal instanceof Error ? refusal.message : "").toContain(
        "valid only while the callback that received it is running",
      );
      expect(yield* inspectWorkspace(database, "/kept.txt")).toEqual(current);
      expect(retainedRootCount(path)).toBe(roots);
    });
  });

  /**
   * Why removing `run` is not what makes a view read-only.
   *
   * `INSERT … RETURNING` is a statement that returns rows, and
   * `StatementSync.all()` runs it and keeps the insertion. A view narrowed by
   * its interface alone would therefore write through the member named `all`.
   * So the refusal has to come from SQLite, before the statement executes.
   */
  it("WAR6: a write dressed as a read is refused before it executes", function* () {
    const root = yield* useStorageRoot();
    const runId = "inspect-write-as-read";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      const path = runPath(root, runId);
      yield* retain(database, "current bytes");
      const current = yield* inspectWorkspace(database, "/kept.txt");
      const roots = retainedRootCount(path);
      expect(retainedRepositoryNames(path)).toEqual([]);

      const attempts: { sql: string; refused: boolean }[] = [];
      const read = yield* readWorkflowWorkspace(database, {}, function* (snapshot) {
        const WRITES: readonly string[] = [
          `INSERT INTO workspace_repositories
             (name, locator, locator_fingerprint, requested_base,
              creation_commit, primary_branch, object_format, checkout_path)
             VALUES ('proof', '/remote.git', '${"f".repeat(64)}', NULL,
                     'abcdef0', 'main', 'sha1', '/kept') RETURNING name`,
          "UPDATE workspace_repositories SET locator = 'moved' RETURNING name",
          "DELETE FROM workspace_repositories RETURNING name",
          "CREATE TABLE smuggled (a TEXT)",
          "DROP TABLE workspace_worktrees",
          "PRAGMA user_version = 99",
        ];
        for (const sql of WRITES) {
          try {
            snapshot.storage.all(sql);
            attempts.push({ sql, refused: false });
          } catch {
            attempts.push({ sql, refused: true });
          }
        }
        // The same view still reads, so the refusal is about what the statement
        // does rather than about the view being broken.
        return snapshot.storage
          .all("SELECT name FROM workspace_repositories ORDER BY name")
          .flatMap((row) => {
            const name = asText(row["name"]);
            return name === undefined ? [] : [name];
          });
      });
      if (!read.ok) {
        throw read.error;
      }

      expect(attempts.every((attempt) => attempt.refused)).toBe(true);
      expect(attempts).toHaveLength(6);
      expect(read.value).toEqual([]);
      // Nothing was written, nothing was dropped, and the run did not move.
      expect(retainedRepositoryNames(path)).toEqual([]);
      expect(retainedRootCount(path)).toBe(roots);

      // And the connection is the one every other caller expects. This runs on
      // the run's own handle and opens a private transaction whose verification
      // reads the schema and its pragmas — all of which an authorizer left
      // installed by the read above would refuse.
      expect(yield* inspectWorkspace(database, "/kept.txt")).toEqual(current);
    });
  });
});
