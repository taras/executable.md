import { DatabaseSync } from "node:sqlite";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  durableCall,
  durableRun,
  guardDurableStream,
  type DurableEvent,
  DurablePersistenceError,
  type Json,
  type Workflow,
  type Yield,
} from "@executablemd/durable-streams";
import { ensure, type Operation, scoped, spawn, suspend, withResolvers } from "effection";
import type { WorkflowRunDatabase } from "../mod.ts";
import {
  createDenoWorkspaceOperation,
  withDenoWorkspaceEffectCoordination,
  WorkspaceEffectPhases,
  type WorkspaceEffectPhase,
} from "../src/deno/workspace/effect.ts";
import type { DenoWorkspaceFilesystem } from "../src/deno/workspace/filesystem.ts";
import {
  setPrivateWorkspaceClock,
  withPrivateWorkspaceTransaction,
} from "../src/deno/workspace/private.ts";
import {
  allowJournalInserts,
  committedEventCount,
  createRun,
  refuseJournalInsertNamed,
  runPath,
  useStorageRoot,
  withStorage,
} from "./support/storage.ts";

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
  yield createDenoWorkspaceOperation(database, { type: "workspace-proof", name }, mutate);
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

describe("Tier WAC — atomic provider-level Workspace effects", () => {
  it("WAC1: mutation, root, filtered Yield and commit become visible together", function* () {
    const root = yield* useStorageRoot();
    const runId = "atomic-success";

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId });
      yield* setPrivateWorkspaceClock(database, () => 1_750_000_000_000);
      const baseline = yield* inspectWorkspace(database, "/kept.txt");
      const path = runPath(root, runId);
      const phases: WorkspaceEffectPhase[] = [];
      yield* WorkspaceEffectPhases.around({
        *reach([phase]: [WorkspaceEffectPhase]): Operation<void> {
          phases.push(phase);
          if (phase === "before-commit") {
            const observer = new DatabaseSync(path);
            try {
              expect(committedEventCount(path)).toBe(0);
              expect(
                observer.prepare("SELECT current_root_id FROM workspace_state").get()?.[
                  "current_root_id"
                ],
              ).toBe(baseline.root);
              expect(
                observer
                  .prepare("SELECT COUNT(*) AS count FROM vfs_dirents WHERE name = 'kept.txt'")
                  .get()?.["count"],
              ).toBe(0);
            } finally {
              observer.close();
            }
          }
        },
      });

      function* workflow(): Workflow<string> {
        yield* workspaceStep(database, "write", function* (filesystem) {
          yield* filesystem.writeFile("/kept.txt", "atomic bytes", 0o640);
          return "written";
        });
        return "done";
      }

      expect(
        yield* withDenoWorkspaceEffectCoordination(
          database,
          durableRun(workflow, { stream: database.journal }),
        ),
      ).toBe("done");
      const committed = yield* inspectWorkspace(database, "/kept.txt");
      expect(committed.content).toBe("atomic bytes");
      expect(committed.root).not.toBe(baseline.root);
      expect(journalRoot(path, "write")).toBe(committed.root);
      expect(phases).toEqual([
        "transaction-open",
        "before-mutation",
        "mutation-complete",
        "root-published",
        "before-publication",
        "publication-complete",
        "before-commit",
      ]);

      const next = yield* database.transact(function* (transaction) {
        return yield* withPrivateWorkspaceTransaction(database, transaction, function* (workspace) {
          return {
            content: yield* workspace.filesystem.readTextFile("/kept.txt"),
            root: yield* workspace.currentRoot(),
            events: yield* transaction.journal.readAll(),
          };
        });
      });
      if (!next.ok) {
        throw next.error;
      }
      expect(next.value.content).toBe("atomic bytes");
      expect(next.value.root).toBe(committed.root);
      expect(workspaceYields(next.value.events)).toHaveLength(1);
    });
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

      yield* withDenoWorkspaceEffectCoordination(
        database,
        durableRun(workflow, { stream: database.journal }),
      );
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

      yield* withDenoWorkspaceEffectCoordination(
        database,
        durableRun(workflow, { stream: database.journal }),
      );
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
        withDenoWorkspaceEffectCoordination(
          database,
          durableRun(workflow, { stream: database.journal }),
        ),
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
        withDenoWorkspaceEffectCoordination(database, durableRun(workflow, { stream: guarded })),
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
          if (point === "before") {
            yield* WorkspaceEffectPhases.around({
              *reach([phase]: [WorkspaceEffectPhase]): Operation<void> {
                if (phase === "before-mutation") {
                  reached.resolve();
                  yield* suspend();
                }
              },
            });
          }

          function* workflow(): Workflow<void> {
            yield* workspaceStep(database, `cancel-${point}`, function* (filesystem) {
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
            withDenoWorkspaceEffectCoordination(
              database,
              durableRun(workflow, { stream: database.journal }),
            ),
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
    const infrastructureFailure = new Error("root publication phase failed");

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "atomic-poison" });
      const baseline = yield* inspectWorkspace(database, "/poisoned.txt");
      let caught: unknown;
      let laterWorkspace = 0;
      let laterOrdinary = 0;
      yield* WorkspaceEffectPhases.around({
        *reach([phase]: [WorkspaceEffectPhase]): Operation<void> {
          if (phase === "root-published") {
            throw infrastructureFailure;
          }
        },
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
        withDenoWorkspaceEffectCoordination(
          database,
          durableRun(workflow, { stream: database.journal }),
        ),
      );
      expect(escaped).toBe(infrastructureFailure);
      expect(caught).toBe(infrastructureFailure);
      expect({ laterWorkspace, laterOrdinary }).toEqual({ laterWorkspace: 0, laterOrdinary: 0 });
      expect(yield* inspectWorkspace(database, "/poisoned.txt")).toEqual(baseline);
      expect(yield* database.journal.readAll()).toEqual([]);
    });
  });

  it("WAC8: unrelated same-run work waits, while another run remains usable", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "atomic-concurrent-first" });
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
        withDenoWorkspaceEffectCoordination(first, durableRun(workflow, { stream: first.journal })),
      );
      yield* mutationStarted.operation;
      const append = yield* spawn(function* () {
        yield* first.journal.append(unrelated);
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
      let phases = 0;
      yield* WorkspaceEffectPhases.around({
        *reach(): Operation<void> {
          phases += 1;
        },
      });
      function* workflow(): Workflow<string> {
        yield* workspaceStep(database, "replayed", function* () {
          mutations += 1;
          return "live";
        });
        return "done";
      }

      expect(
        yield* withDenoWorkspaceEffectCoordination(
          database,
          durableRun(workflow, { stream: database.journal }),
        ),
      ).toBe("done");
      expect({ mutations, phases }).toEqual({ mutations: 0, phases: 0 });
    });
  });

  it("WAC10: closed and foreign database authority reaches no mutation", function* () {
    const root = yield* useStorageRoot();
    let closed: WorkflowRunDatabase | undefined;

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
      expect(
        yield* raised(
          withDenoWorkspaceEffectCoordination(
            first,
            durableRun(foreignWorkflow, { stream: first.journal }),
          ),
        ),
      ).toBeInstanceOf(Error);
      expect(foreignMutations).toBe(0);
      expect(yield* first.journal.readAll()).toEqual([]);
      expect(yield* second.journal.readAll()).toEqual([]);
    });
    if (closed === undefined) {
      throw new Error("the closed database proof did not retain its handle");
    }
    const database = closed;
    let mutations = 0;
    function* workflow(): Workflow<void> {
      yield* workspaceStep(database, "closed", function* () {
        mutations += 1;
        return null;
      });
    }
    expect(
      yield* raised(
        withDenoWorkspaceEffectCoordination(
          database,
          durableRun(workflow, { stream: database.journal }),
        ),
      ),
    ).toBeInstanceOf(Error);
    expect(mutations).toBe(0);
  });
});
