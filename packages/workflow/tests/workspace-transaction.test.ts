import { join } from "node:path";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Yield } from "@executablemd/durable-streams";
import { ensure, type Operation, spawn, suspend, withResolvers } from "effection";
import {
  type WorkflowRunDatabase,
  type WorkflowRunTransaction,
  WorkflowRunStorage,
  WorkflowTransactionError,
} from "../mod.ts";
import {
  createWorkflowRunConnections,
  WorkflowRunTransactionToken,
} from "../src/deno/connections.ts";
import { SavepointObservation, type SavepointObservationEvent } from "../src/deno/savepoints.ts";
import { savepoint } from "../src/deno/transaction.ts";
import {
  type PrivateWorkspaceTransaction,
  setPrivateWorkspaceClock,
  validateWorkflowRunTransactionToken,
  withPrivateWorkspaceTransaction,
  workflowRunTransactionToken,
} from "../src/deno/workspace/private.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";

function yielded(name: string): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "call", name },
    result: { status: "ok", value: name },
  };
}

function names(events: DurableEvent[]): string[] {
  return events.flatMap((event) => (event.type === "yield" ? [event.description.name] : []));
}

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

function fabricatedDatabase(value: unknown, seed: WorkflowRunDatabase): WorkflowRunDatabase {
  const container: { database: WorkflowRunDatabase } = {
    database: seed,
  };
  Object.defineProperty(container, "database", { value, enumerable: true });
  return container.database;
}

describe("Tier WTX — unified WorkflowRun savepoints", () => {
  it("WTX1: operation savepoints release after child teardown and retain successful work", function* () {
    const root = yield* useStorageRoot();
    const order: string[] = [];
    yield* SavepointObservation.set((event) => {
      order.push(`${event.kind}:${event.name}`);
    });

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      order.length = 0;
      const result = yield* database.transact(function* (transaction) {
        yield* transaction.journal.append(yielded("before"));
        yield* savepoint(
          (function* () {
            yield* transaction.journal.append(yielded("inside"));
            const ready = withResolvers<void>();
            yield* spawn(function* () {
              yield* ensure(function* () {
                yield* transaction.journal.append(yielded("cleanup"));
                order.push("cleanup");
              });
              ready.resolve();
              yield* suspend();
            });
            yield* ready.operation;
          })(),
        );
        yield* transaction.journal.append(yielded("after"));
      });
      if (!result.ok) {
        throw result.error;
      }
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["before", "inside", "cleanup", "after"]);
    const created = order.findIndex((entry) => entry.startsWith("create:"));
    const cleaned = order.indexOf("cleanup");
    const released = order.findIndex((entry) => entry.startsWith("release:"));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(cleaned).toBeGreaterThan(created);
    expect(released).toBeGreaterThan(cleaned);
  });

  it("WTX2: failures and nested rollback discard only their own operation savepoint", function* () {
    const root = yield* useStorageRoot();
    const observed: SavepointObservationEvent[] = [];
    yield* SavepointObservation.set((event) => observed.push(event));

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      observed.length = 0;
      const result = yield* database.transact(function* (transaction) {
        yield* savepoint(
          (function* () {
            yield* transaction.journal.append(yielded("outer-savepoint"));
            const innerFailure = yield* raised(
              savepoint(
                (function* () {
                  yield* transaction.journal.append(yielded("inner-rolled-back"));
                  throw new Error("inner failure");
                })(),
              ),
            );
            expect(innerFailure).toBeInstanceOf(Error);
            yield* transaction.journal.append(yielded("outer-after-inner"));
          })(),
        );

        const failed = yield* raised(
          savepoint(
            (function* () {
              yield* transaction.journal.append(yielded("ordinary-rolled-back"));
              throw new Error("ordinary failure");
            })(),
          ),
        );
        expect(failed).toBeInstanceOf(Error);
        yield* transaction.journal.append(yielded("transaction-continues"));
      });
      if (!result.ok) {
        throw result.error;
      }
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual([
      "outer-savepoint",
      "outer-after-inner",
      "transaction-continues",
    ]);
    expect(observed.filter((event) => event.kind === "create")).toHaveLength(3);
    expect(observed.filter((event) => event.kind === "rollback")).toHaveLength(2);
    expect(observed.filter((event) => event.kind === "release")).toHaveLength(1);
    expect(new Set(observed.map((event) => event.name)).size).toBe(3);
  });

  it("WTX3: a cleanup failure rolls the operation savepoint back", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const result = yield* database.transact(function* (transaction) {
        const failed = yield* raised(
          savepoint(
            (function* () {
              yield* transaction.journal.append(yielded("cleanup-failure"));
              const ready = withResolvers<void>();
              yield* spawn(function* () {
                yield* ensure(() => {
                  throw new Error("cleanup failed");
                });
                ready.resolve();
                yield* suspend();
              });
              yield* ready.operation;
            })(),
          ),
        );
        expect(failed).toBeInstanceOf(Error);
        yield* transaction.journal.append(yielded("survives"));
      });
      if (!result.ok) {
        throw result.error;
      }
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["survives"]);
  });

  it("WTX4: cancellation before, during, and during teardown strands no savepoint", function* () {
    const root = yield* useStorageRoot();
    const observed: SavepointObservationEvent[] = [];
    yield* SavepointObservation.set((event) => observed.push(event));

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      observed.length = 0;

      const before = withResolvers<void>();
      const beforeTask = yield* spawn(function* () {
        yield* database.transact(function* () {
          before.resolve();
          yield* suspend();
          yield* savepoint((function* () {})());
        });
      });
      yield* before.operation;
      yield* beforeTask.halt();
      expect(observed).toEqual([]);

      const during = withResolvers<void>();
      const duringTask = yield* spawn(function* () {
        yield* database.transact(function* (transaction) {
          yield* savepoint(
            (function* () {
              yield* transaction.journal.append(yielded("cancelled-during"));
              during.resolve();
              yield* suspend();
            })(),
          );
        });
      });
      yield* during.operation;
      yield* duringTask.halt();
      expect(observed.at(-1)?.kind).toBe("rollback");

      const childReady = withResolvers<void>();
      const tearingDown = withResolvers<void>();
      const releaseCleanup = withResolvers<void>();
      const teardownTask = yield* spawn(function* () {
        yield* database.transact(function* (transaction) {
          yield* savepoint(
            (function* () {
              yield* transaction.journal.append(yielded("cancelled-teardown"));
              yield* spawn(function* () {
                yield* ensure(function* () {
                  tearingDown.resolve();
                  yield* releaseCleanup.operation;
                });
                childReady.resolve();
                yield* suspend();
              });
              yield* childReady.operation;
            })(),
          );
        });
      });
      yield* tearingDown.operation;
      const halting = yield* spawn(function* () {
        yield* teardownTask.halt();
      });
      releaseCleanup.resolve();
      yield* halting;
      expect(observed.at(-1)?.kind).toBe("rollback");

      yield* database.journal.append(yielded("after-cancellation"));
      expect(names(yield* database.journal.readAll())).toEqual(["after-cancellation"]);
    });
  });

  it("WTX5: synchronous DOFS nesting shares the operation-savepoint allocator", function* () {
    const root = yield* useStorageRoot();
    const observed: SavepointObservationEvent[] = [];
    yield* SavepointObservation.set((event) => observed.push(event));

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      observed.length = 0;
      const result = yield* database.transact(function* (transaction) {
        return yield* withPrivateWorkspaceTransaction(database, transaction, function* (workspace) {
          const failure = yield* raised(
            savepoint(
              (function* () {
                yield* workspace.filesystem.writeFile("/rolled-back.txt", "temporary");
                throw new Error("discard the DOFS mutation");
              })(),
            ),
          );
          expect(failure).toBeInstanceOf(Error);
        });
      });
      if (!result.ok) {
        throw result.error;
      }
    });

    const creates = observed.filter((event) => event.kind === "create");
    expect(creates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(creates.map((event) => event.name)).size).toBe(creates.length);
    const outer = creates[0];
    if (outer === undefined) {
      throw new Error("the operation savepoint was not observed");
    }
    expect(observed.at(-1)).toEqual({ kind: "rollback", name: outer.name });
  });

  it("WTX6: savepoint SQL failures poison the outer transaction identity", function* () {
    const root = yield* useStorageRoot();

    const phases: Array<"release" | "rollback"> = ["release", "rollback"];
    for (const phase of phases) {
      let activeName = "";
      const connections = createWorkflowRunConnections((event) => {
        if (event.kind === "create") {
          activeName = event.name;
        }
      });
      const connection = connections.at(join(root, `${phase}.sqlite`));
      connection.database.exec("BEGIN IMMEDIATE");
      const transaction = connection.beginTransaction();
      const failure = yield* raised(
        connection.savepoints.operation(
          transaction,
          (function* () {
            connection.database.exec(`RELEASE ${activeName}`);
            if (phase === "rollback") {
              throw new Error("force rollback after removing the savepoint");
            }
          })(),
        ),
      );
      expect(failure).toBeInstanceOf(Error);
      expect(() => connection.validateTransaction(transaction)).toThrow(WorkflowTransactionError);
      connection.finishTransaction(transaction);
      connection.database.exec("ROLLBACK");
      connections.close();
    }

    const connections = createWorkflowRunConnections();
    const connection = connections.at(join(root, "creation.sqlite"));
    connection.database.exec("BEGIN IMMEDIATE");
    const transaction = connection.beginTransaction();
    connection.database.close();
    const creationFailure = yield* raised(
      connection.savepoints.operation(transaction, (function* () {})()),
    );
    expect(creationFailure).toBeInstanceOf(Error);
    expect(() => connection.validateTransaction(transaction)).toThrow(WorkflowTransactionError);
    connection.finishTransaction(transaction);
  });
});

describe("Tier WTX — WorkflowRun identity fences", () => {
  it("WTX7: exact handles and tokens work only during their active transaction", function* () {
    const root = yield* useStorageRoot();
    let escapedTransaction: WorkflowRunTransaction | undefined;
    let escapedToken: WorkflowRunTransactionToken | undefined;
    let escapedWorkspace: PrivateWorkspaceTransaction | undefined;

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const first = yield* database.transact(function* (transaction) {
        escapedTransaction = transaction;
        escapedToken = yield* workflowRunTransactionToken(database, transaction);
        yield* validateWorkflowRunTransactionToken(database, escapedToken);
        yield* withPrivateWorkspaceTransaction(database, transaction, function* (workspace) {
          escapedWorkspace = workspace;
        });
      });
      expect(first.ok).toBe(true);

      const token = escapedToken;
      if (token === undefined) {
        throw new Error("the active transaction did not issue its token");
      }
      expect(yield* raised(validateWorkflowRunTransactionToken(database, token))).toBeInstanceOf(
        WorkflowTransactionError,
      );
      const workspace = escapedWorkspace;
      if (workspace === undefined) {
        throw new Error("the private Workspace handle did not escape for the refusal proof");
      }
      expect(yield* raised(workspace.currentRoot())).toBeInstanceOf(WorkflowTransactionError);

      const second = yield* database.transact(function* () {
        expect(yield* raised(validateWorkflowRunTransactionToken(database, token))).toBeInstanceOf(
          WorkflowTransactionError,
        );
      });
      expect(second.ok).toBe(true);

      const transaction = escapedTransaction;
      if (transaction === undefined) {
        throw new Error("the transaction handle did not escape for the refusal proof");
      }
      expect(yield* raised(workflowRunTransactionToken(database, transaction))).toBeInstanceOf(
        WorkflowTransactionError,
      );
    });
  });

  it("WTX8: foreign, fabricated, and cross-run identities are refused", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "first" });
      const firstAgain = yield* createRun({ runId: "first" });
      const second = yield* createRun({ runId: "second" });
      const result = yield* first.transact(function* (firstTransaction) {
        const firstToken = yield* workflowRunTransactionToken(first, firstTransaction);
        expect(
          yield* raised(validateWorkflowRunTransactionToken(firstAgain, firstToken)),
        ).toBeInstanceOf(WorkflowTransactionError);
        const nested = yield* second.transact(function* (secondTransaction) {
          expect(
            yield* raised(workflowRunTransactionToken(first, secondTransaction)),
          ).toBeInstanceOf(WorkflowTransactionError);
          expect(
            yield* raised(validateWorkflowRunTransactionToken(second, firstToken)),
          ).toBeInstanceOf(WorkflowTransactionError);
          const fabricatedTransaction: WorkflowRunTransaction = { journal: first.journal };
          expect(
            yield* raised(workflowRunTransactionToken(first, fabricatedTransaction)),
          ).toBeInstanceOf(WorkflowTransactionError);
          expect(
            yield* raised(
              validateWorkflowRunTransactionToken(first, new WorkflowRunTransactionToken()),
            ),
          ).toBeInstanceOf(WorkflowTransactionError);
        });
        if (!nested.ok) {
          throw nested.error;
        }
      });
      expect(result.ok).toBe(true);

      expect(
        yield* raised(setPrivateWorkspaceClock(fabricatedDatabase({}, first), () => 0)),
      ).toBeInstanceOf(WorkflowTransactionError);
    });
  });

  it("WTX9: leases and provider generations fence private authority", function* () {
    const root = yield* useStorageRoot();
    let closed: WorkflowRunDatabase | undefined;
    let priorToken: WorkflowRunTransactionToken | undefined;

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "generation" });
      closed = database;
      const result = yield* database.transact(function* (transaction) {
        priorToken = yield* workflowRunTransactionToken(database, transaction);
      });
      expect(result.ok).toBe(true);
      expect(Reflect.ownKeys(database).filter((key) => typeof key === "symbol")).toEqual([]);
    });

    const closedHandle = closed;
    if (closedHandle === undefined || priorToken === undefined) {
      throw new Error("the prior provider did not leave identity evidence");
    }
    const oldToken = priorToken;
    yield* withStorage(root, function* () {
      const found = yield* WorkflowRunStorage.operations.lookup("generation");
      if (!found.ok) {
        throw found.error;
      }
      const database = found.value;
      const result = yield* database.transact(function* () {
        expect(
          yield* raised(validateWorkflowRunTransactionToken(database, oldToken)),
        ).toBeInstanceOf(WorkflowTransactionError);
        expect(
          yield* raised(validateWorkflowRunTransactionToken(closedHandle, oldToken)),
        ).toBeInstanceOf(WorkflowTransactionError);
      });
      expect(result.ok).toBe(true);
      expect(yield* raised(setPrivateWorkspaceClock(closedHandle, () => 0))).toBeInstanceOf(
        WorkflowTransactionError,
      );
    });
  });
});
