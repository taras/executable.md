/**
 * Tier WJ — the retained journal, and the transaction a caller can hold.
 *
 * Two boundaries are under test and they are easy to confuse. The journal
 * boundary is ordering and identity: events go in filtered, come back in the
 * order they were appended, and keep an opaque id that outlives the process.
 * The transaction boundary is enlistment: a caller's transaction publishes its
 * journal events with the rest of its work, and nothing that did not ask to be
 * part of it is committed or rolled back with it.
 *
 * The filtering order is asserted from outside rather than assumed. The adapter
 * performs no filtering of its own — a second policy in a second place is a
 * second thing to keep in agreement with the first — so what these tests check
 * is that a rejected or cancelled gate leaves no row at all.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createApi } from "@effectionx/context-api";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec } from "@executablemd/runtime";
import {
  type Close,
  type DurableEvent,
  guardDurableStream,
  serializeDurableEvent,
  type Yield,
} from "@executablemd/durable-streams";
import { createSecretScanner, SecretDetectedError } from "@executablemd/core";
import { all, ensure, type Operation, race, sleep, spawn, suspend, withResolvers } from "effection";
import {
  WorkflowRecordMalformedError,
  WorkflowRequestError,
  type WorkflowRunDatabase,
  WorkflowRunConflictError,
  WorkflowRunStorage,
  type WorkflowRunTransaction,
  WorkflowTransactionError,
} from "../mod.ts";
import { WorkflowRunTransactionToken } from "../src/deno/connections.ts";
import { withEnlistedJournalRoute } from "../src/deno/journal-route.ts";
import { NoOpenTransactionError, savepoint } from "../src/deno/transaction.ts";
import { EMPTY_WORKSPACE_ROOT_ID } from "../src/deno/workspace/manifest.ts";
import { workflowRunTransactionToken } from "../src/deno/workspace/private.ts";
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

const { create } = WorkflowRunStorage.operations;

interface CollidingJournalDestinationApi {
  append(database: WorkflowRunDatabase, event: DurableEvent): Operation<boolean>;
}

const CollidingJournalDestination = createApi<CollidingJournalDestinationApi>(
  "executablemd.workflow.deno.journal.destination",
  {
    // deno-lint-ignore require-yield
    *append(_database: WorkflowRunDatabase, _event: DurableEvent): Operation<boolean> {
      return false;
    },
  },
);

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const CHILD = fileURLToPath(new URL("./support/restart-child.ts", import.meta.url));

/** A synthetic credential, shaped so the shipped preset recognizes it. */
const CANARY = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`;

function yielded(name: string, value: string): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "call", name },
    result: { status: "ok", value },
  };
}

function closed(value: string): Close {
  return { type: "close", coroutineId: "root", result: { status: "ok", value } };
}

/** The names of the yields a journal holds, in the order it holds them. */
function names(events: DurableEvent[]): string[] {
  return events.flatMap((event) => (event.type === "yield" ? [event.description.name] : []));
}

/**
 * Run `body` under a deadline, so a deadlock fails rather than hanging.
 *
 * A test that waits forever is reported as a timeout by the runner long after
 * the fact, if at all. Racing it against a short sleep turns "no answer" into
 * an assertion that says so.
 */
function* guarded<T>(body: () => Operation<T>): Operation<T> {
  const outcome = yield* race([
    (function* (): Operation<{ answered: true; value: T }> {
      return { answered: true, value: yield* body() };
    })(),
    (function* (): Operation<{ answered: false }> {
      yield* sleep(2_000);
      return { answered: false };
    })(),
  ]);

  if (!outcome.answered) {
    throw new Error("timed out: the operation is waiting on a lock nobody will release");
  }
  return outcome.value;
}

/** What an operation raised, rather than what it returned. */
function* attempt(body: () => Operation<unknown>): Operation<unknown> {
  try {
    yield* body();
  } catch (error) {
    return error;
  }
  return undefined;
}

function tokenValue(
  value: unknown,
  seed: WorkflowRunTransactionToken,
): WorkflowRunTransactionToken {
  const container = { token: seed };
  Object.defineProperty(container, "token", { value, enumerable: true });
  return container.token;
}

/** One whole run in a process of its own, through the production adapter. */
function* runChild(
  root: string,
  runId: string,
  marker: string,
  base = "main",
): Operation<{ code: number; out: string }> {
  const result = yield* exec({
    command: [process.execPath, "run", "--allow-all", "--frozen", CHILD, root, runId, marker, base],
    cwd: REPOSITORY,
  });
  return { code: result.exitCode, out: result.stdout };
}

describe("Tier WJ — appending and replaying the journal", () => {
  it("WJ1: events come back in the order they went in", function* () {
    const root = yield* useStorageRoot();

    const replayed = yield* withStorage(root, function* () {
      const database = yield* createRun();
      for (const name of ["first", "second", "third"]) {
        yield* database.journal.append(yielded(name, name));
      }
      yield* database.journal.append(closed("done"));
      return yield* database.journal.readAll();
    });

    expect(names(replayed)).toEqual(["first", "second", "third"]);
    expect(replayed).toHaveLength(4);
    expect(replayed[3].type).toBe("close");
  });

  it("WJ2: a record is stored as the protocol wrote it, not as a re-encoding", function* () {
    const root = yield* useStorageRoot();
    const event = yielded("only", "value");

    const stored = yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* database.journal.append(event);
      return yield* database.journal.readAll();
    });

    expect(stored).toEqual([event]);
    expect(serializeDurableEvent(stored[0])).toBe(serializeDurableEvent(event));
  });

  it("WJ2b: every ordinary journal append records the current retained root", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* database.journal.append(yielded("first", "one"));
      yield* database.transact(function* (transaction) {
        yield* transaction.journal.append(yielded("second", "two"));
      });
    });

    tamper(path, (database) => {
      expect(
        database.prepare("SELECT DISTINCT workspace_root_id FROM journal_events").all(),
      ).toEqual([{ workspace_root_id: EMPTY_WORKSPACE_ROOT_ID }]);
    });
  });

  it("WJ3: an event keeps its opaque id, across reads and across processes", function* () {
    const root = yield* useStorageRoot();

    const first = yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* database.journal.append(yielded("a", "a"));
      yield* database.journal.append(yielded("b", "b"));

      const once = yield* database.readJournalEntries();
      const twice = yield* database.readJournalEntries();
      if (!once.ok || !twice.ok) {
        throw new Error("expected the journal to be readable");
      }
      expect(once.value.map((entry) => entry.eventId)).toEqual(
        twice.value.map((entry) => entry.eventId),
      );
      return once.value.map((entry) => entry.eventId);
    });

    const afterReopen = yield* withStorage(root, function* () {
      const found = yield* WorkflowRunStorage.operations.lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      const entries = yield* found.value.readJournalEntries();
      if (!entries.ok) {
        throw entries.error;
      }
      return entries.value.map((entry) => entry.eventId);
    });

    expect(afterReopen).toEqual(first);
    expect(new Set(first).size).toBe(2);
  });

  it("WJ4: a journal row that is not an event is refused rather than replayed", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const result = yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* database.journal.append(yielded("a", "a"));

      // Valid JSON, and not an event: surviving `json_valid` is not the same
      // as describing a durable event, which is why the row is parsed.
      tamper(path, (raw) => {
        raw.prepare(`UPDATE journal_events SET record = '{"type":"whatever"}'`).run();
      });

      const found = yield* WorkflowRunStorage.operations.lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      return yield* found.value.readJournalEntries();
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRecordMalformedError);
    expect(!result.ok && result.error.message).toContain("journal_events.record");
  });
});

describe("Tier WJ — what reaches SQLite", () => {
  it("WJ5: a gate that rejects an event leaves no row behind", function* () {
    const root = yield* useStorageRoot();
    const scanner = createSecretScanner();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();

      // The boundary under test: DurableEvent → secret guard → SQLite append.
      // The adapter filters nothing itself, so the only thing keeping this row
      // out is that the gate ran first.
      const guarded = guardDurableStream(database.journal, function* (event) {
        const findings = yield* scanner.scan(serializeDurableEvent(event));
        if (findings.length > 0) {
          throw new SecretDetectedError(findings);
        }
      });

      yield* guarded.append(yielded("before", "harmless"));

      let raised: unknown;
      try {
        yield* guarded.append(yielded("leak", CANARY));
      } catch (error) {
        raised = error;
      }

      return { raised, events: yield* database.journal.readAll() };
    });

    expect(seen.raised).toBeInstanceOf(SecretDetectedError);
    expect(names(seen.events)).toEqual(["before"]);
  });

  it("WJ5b: the same gate on a transaction's journal keeps the row out too", function* () {
    const root = yield* useStorageRoot();
    const scanner = createSecretScanner();

    // The transaction's journal is a second way into the same table, so the
    // filtering boundary has to hold there as well.
    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();

      const result = yield* database.transact(function* (transaction) {
        const guarded = guardDurableStream(transaction.journal, function* (event) {
          const findings = yield* scanner.scan(serializeDurableEvent(event));
          if (findings.length > 0) {
            throw new SecretDetectedError(findings);
          }
        });

        yield* guarded.append(yielded("before", "harmless"));
        yield* guarded.append(yielded("leak", CANARY));
        return "never reached";
      });

      return { result, events: yield* database.journal.readAll() };
    });

    expect(seen.result.ok).toBe(false);
    expect(!seen.result.ok && seen.result.error).toBeInstanceOf(SecretDetectedError);
    // The rejected event never reached SQLite, and the transaction it happened
    // inside published nothing either.
    expect(seen.events).toEqual([]);
  });

  it("WJ5c: a real SQLite insertion failure leaves no partial event", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      // The database refuses exactly one event, so the appends around it are
      // ordinary successful ones rather than casualties of the fixture.
      refuseJournalInsertNamed(path, "refused");

      yield* database.journal.append(yielded("before", "before"));

      let raised: unknown;
      try {
        yield* database.journal.append(yielded("refused", "refused"));
      } catch (error) {
        raised = error;
      }

      // The transaction the failed append opened for itself rolled back, and
      // the handle is still usable.
      yield* database.journal.append(yielded("after", "after"));

      return { raised, events: yield* database.journal.readAll() };
    });

    expect(seen.raised).toBeInstanceOf(Error);
    expect(names(seen.events)).toEqual(["before", "after"]);
  });

  it("WJ5d: an insertion failure rolls back the rest of the caller's transaction", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      refuseJournalInsertNamed(path, "doomed");

      let companionInserted = false;

      const result = yield* database.transact(function* (transaction) {
        // This one is accepted by SQLite. The point of the test is what
        // happens to it when a later append in the same transaction is not.
        yield* transaction.journal.append(yielded("companion", "companion"));
        companionInserted = true;
        yield* transaction.journal.append(yielded("doomed", "doomed"));
        return "never reached";
      });

      allowJournalInserts(path);
      return { result, companionInserted, events: yield* database.journal.readAll() };
    });

    expect(seen.companionInserted).toBe(true);
    expect(seen.result.ok).toBe(false);
    // The accepted append went away with the refused one.
    expect(seen.events).toEqual([]);
  });

  it("WJ5e: a retained-manifest FK failure stays a storage failure", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      tamper(path, (raw) => {
        raw.exec(`
          CREATE TRIGGER fail_second_journal_insert
          BEFORE INSERT ON journal_events
          WHEN (SELECT COUNT(*) FROM journal_events) = 1
          BEGIN
            INSERT INTO workspace_root_manifest_refs (root_id, manifest_hash)
            VALUES ('${EMPTY_WORKSPACE_ROOT_ID}', X'00');
          END;
        `);
      });

      const result = yield* database.transact(function* (transaction) {
        yield* transaction.journal.append(yielded("companion", "companion"));
        yield* transaction.journal.append(yielded("fails-on-manifest-fk", "doomed"));
      });

      return { result, events: yield* database.journal.readAll() };
    });

    expect(seen.result.ok).toBe(false);
    expect(!seen.result.ok && seen.result.error).toBeInstanceOf(Error);
    expect(!seen.result.ok && seen.result.error).not.toBeInstanceOf(WorkflowRequestError);
    expect(seen.events).toEqual([]);
    tamper(path, (database) => {
      expect(database.prepare("SELECT * FROM workspace_root_manifest_refs").all()).toEqual([]);
    });
  });

  it("WJ6: a gate cancelled mid-scan produces no row either", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const reached = withResolvers<void>();

      const guarded = guardDurableStream(database.journal, function* () {
        reached.resolve();
        yield* suspend();
      });

      const appending = yield* spawn(function* () {
        yield* guarded.append(yielded("never", "never"));
      });

      yield* reached.operation;
      yield* appending.halt();

      return yield* database.journal.readAll();
    });

    expect(events).toEqual([]);
  });
});

describe("Tier WJ — a transaction a caller holds", () => {
  it("WJ6b: filtering cancelled inside a transaction leaves no row either", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const reached = withResolvers<void>();

      const transacting = yield* spawn(function* () {
        yield* database.transact(function* (transaction) {
          const guarded = guardDurableStream(transaction.journal, function* () {
            reached.resolve();
            yield* suspend();
          });
          yield* guarded.append(yielded("never", "never"));
          return "never reached";
        });
      });

      yield* reached.operation;
      yield* transacting.halt();

      return yield* database.journal.readAll();
    });

    expect(events).toEqual([]);
  });

  it("WJ7: a body that completes publishes its events with the rest of its work", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();

      const result = yield* database.transact(function* (transaction) {
        yield* transaction.journal.append(yielded("inside", "inside"));
        yield* transaction.journal.append(closed("inside"));
        return "committed";
      });

      return { result, events: yield* database.journal.readAll() };
    });

    expect(seen.result.ok).toBe(true);
    expect(seen.result.ok && seen.result.value).toBe("committed");
    expect(names(seen.events)).toEqual(["inside"]);
    expect(seen.events).toHaveLength(2);
  });

  it("WJ8: a body that fails after inserting leaves nothing behind", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* database.journal.append(yielded("before", "before"));

      const result = yield* database.transact(function* (transaction) {
        yield* transaction.journal.append(yielded("rolled-back", "rolled-back"));
        throw new Error("the effect this transaction was publishing failed");
      });

      return { result, events: yield* database.journal.readAll() };
    });

    expect(seen.result.ok).toBe(false);
    expect(names(seen.events)).toEqual(["before"]);
  });

  it("WJ9: a body cancelled after BEGIN rolls back, and the handle still works", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inside = withResolvers<void>();

      const transacting = yield* spawn(function* () {
        yield* database.transact(function* (transaction) {
          yield* transaction.journal.append(yielded("cancelled", "cancelled"));
          inside.resolve();
          yield* suspend();
        });
      });

      yield* inside.operation;
      yield* transacting.halt();

      // The same handle, immediately afterwards: a rollback that left the
      // connection mid-transaction would fail here rather than append.
      yield* database.journal.append(yielded("after", "after"));

      return yield* database.journal.readAll();
    });

    expect(names(seen)).toEqual(["after"]);
  });

  it("WJ10: a transaction inside a transaction is refused, not nested", function* () {
    const root = yield* useStorageRoot();

    const inner = yield* withStorage(root, function* () {
      const database = yield* createRun();

      const outer = yield* database.transact(function* () {
        return yield* database.transact(function* () {
          return "should never run";
        });
      });

      if (!outer.ok) {
        throw outer.error;
      }
      return outer.value;
    });

    expect(inner.ok).toBe(false);
    expect(!inner.ok && inner.error).toBeInstanceOf(WorkflowTransactionError);
  });

  it("WJ11: an ordinary operation called from inside a body is refused, not deadlocked", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();

      const result = yield* database.transact(function* () {
        // Taking the connection again from inside the body would wait for a
        // transaction this very scope is holding open. Any operation that takes
        // its own turn shows it; this one reads.
        return yield* database.readDocumentExecutions();
      });

      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });

    expect(seen.ok).toBe(false);
    expect(!seen.ok && seen.error).toBeInstanceOf(WorkflowTransactionError);
  });

  it("WJ12: a transaction handle kept past its body appends nothing", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const escaped: WorkflowRunTransaction[] = [];

      yield* database.transact(function* (transaction) {
        escaped.push(transaction);
        return "done";
      });

      let raised: unknown;
      try {
        yield* escaped[0].journal.append(yielded("too-late", "too-late"));
      } catch (error) {
        raised = error;
      }

      return { raised, events: yield* database.journal.readAll() };
    });

    expect(seen.raised).toBeInstanceOf(WorkflowTransactionError);
    expect(seen.events).toEqual([]);
  });

  it("WJ13: a child's cleanup is inside the transaction, not after it", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    // The body returns while a child it spawned is still alive, so the child's
    // cleanup appends during teardown. Presence in the journal afterwards
    // cannot tell whether that append was part of the transaction or
    // autocommitted on its own once it had already been committed — so the
    // cleanup asks a second connection what has been committed *so far*.
    // Nothing has, if the transaction is still open.
    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const started = withResolvers<void>();
      let committedDuringCleanup = -1;

      const result = yield* database.transact(function* (transaction) {
        yield* spawn(function* () {
          yield* ensure(function* () {
            committedDuringCleanup = committedEventCount(path);
            yield* transaction.journal.append(yielded("cleanup", "cleanup"));
          });
          started.resolve();
          yield* suspend();
        });

        // Without this the child has not run far enough to register its
        // cleanup, and the test would prove nothing.
        yield* started.operation;
        yield* transaction.journal.append(yielded("body", "body"));
        return "committed";
      });

      if (!result.ok) {
        throw result.error;
      }
      return { committedDuringCleanup, events: yield* database.journal.readAll() };
    });

    expect(seen.committedDuringCleanup).toBe(0);
    expect(names(seen.events)).toEqual(["body", "cleanup"]);
    expect(committedEventCount(path)).toBe(2);
  });

  it("WJ14: a child's cleanup rolls back with the transaction it belongs to", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const started = withResolvers<void>();
      let appended = false;

      const result = yield* database.transact(function* (transaction) {
        yield* spawn(function* () {
          yield* ensure(function* () {
            yield* transaction.journal.append(yielded("cleanup", "cleanup"));
            appended = true;
          });
          started.resolve();
          yield* suspend();
        });

        yield* started.operation;
        yield* transaction.journal.append(yielded("body", "body"));
        throw new Error("the effect this transaction was publishing failed");
      });

      expect(result.ok).toBe(false);
      // The cleanup did append — and went away with everything else.
      expect(appended).toBe(true);
      return yield* database.journal.readAll();
    });

    expect(events).toEqual([]);
  });

  it("WJ15: nested work rolls back to a savepoint inside a committing transaction", function* () {
    const root = yield* useStorageRoot();

    // The seam a Workspace filesystem uses: its own nested transactions become
    // savepoints inside the one transaction that publishes the effect and its
    // journal result together.
    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();

      const result = yield* database.transact(function* (transaction) {
        yield* transaction.journal.append(yielded("kept", "kept"));

        try {
          yield* savepoint(
            (function* () {
              throw new Error("the nested mutation failed");
            })(),
          );
        } catch {
          // The savepoint rolled back; the transaction around it continues.
        }

        yield* transaction.journal.append(yielded("also-kept", "also-kept"));
        return "committed";
      });

      if (!result.ok) {
        throw result.error;
      }
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["kept", "also-kept"]);
  });
});

describe("Tier WJ — one connection, one operation at a time", () => {
  it("WJ15c: a transaction on another run does not hide the one already held", function* () {
    const root = yield* useStorageRoot();

    // Every assertion here is guarded by a deadline, because the failure this
    // covers is not a wrong answer — it is no answer at all. An operation that
    // does not recognize an ancestor transaction waits on a lock its own
    // caller is holding, forever.
    const seen = yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "run-a" });
      const second = yield* createRun({ runId: "run-b" });

      return yield* guarded(function* () {
        const outcome = yield* first.transact(function* (outer) {
          yield* outer.journal.append(yielded("outer", "outer"));

          const inner = yield* second.transact(function* (nested) {
            yield* nested.journal.append(yielded("inner", "inner"));

            // Both of these reach run A, which this scope's ancestor holds.
            const read = yield* attempt(() => first.journal.readAll());
            const nestedTransact = yield* first.transact(function* () {
              return "should never run";
            });

            return { read, nestedTransact };
          });
          if (!inner.ok) {
            throw inner.error;
          }

          // The transaction on A is still usable once B has finished with it.
          yield* outer.journal.append(yielded("after-inner", "after-inner"));
          return inner.value;
        });

        if (!outcome.ok) {
          throw outcome.error;
        }
        return { ...outcome.value, events: yield* first.journal.readAll() };
      });
    });

    expect(seen.read).toBeInstanceOf(WorkflowTransactionError);
    expect(seen.nestedTransact.ok).toBe(false);
    expect(!seen.nestedTransact.ok && seen.nestedTransact.error).toBeInstanceOf(
      WorkflowTransactionError,
    );
    // The outer transaction committed both of its own appends.
    expect(names(seen.events)).toEqual(["outer", "after-inner"]);
  });

  it("WJ15b: a savepoint outside any transaction is refused, not improvised", function* () {
    let raised: unknown;
    try {
      yield* savepoint(
        (function* () {
          return "nothing to be inside";
        })(),
      );
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(NoOpenTransactionError);
  });

  it("WJ16: an unrelated append waits for a transaction, and is not part of it", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inside = withResolvers<void>();
      const release = withResolvers<void>();
      const order: string[] = [];

      const transacting = yield* spawn(function* () {
        yield* database.transact(function* (transaction) {
          yield* transaction.journal.append(yielded("in-transaction", "in-transaction"));
          order.push("transaction appended");
          inside.resolve();
          yield* release.operation;
          order.push("transaction committing");
          return "done";
        });
      });

      yield* inside.operation;

      const appending = yield* spawn(function* () {
        yield* database.journal.append(yielded("unrelated", "unrelated"));
        order.push("unrelated appended");
      });

      // Long enough for an append that did not have to wait to have finished.
      yield* sleep(50);
      const beforeCommit = [...order];

      release.resolve();
      yield* transacting;
      yield* appending;

      return { beforeCommit, order, events: yield* database.journal.readAll() };
    });

    // It waited: the unrelated append had not run while the transaction held
    // the connection.
    expect(seen.beforeCommit).toEqual(["transaction appended"]);
    expect(seen.order).toEqual([
      "transaction appended",
      "transaction committing",
      "unrelated appended",
    ]);
    // And it did not enlist: both events are present, in that order.
    expect(names(seen.events)).toEqual(["in-transaction", "unrelated"]);
  });

  it("WJ17: an unrelated append survives the rollback of a transaction it waited for", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inside = withResolvers<void>();
      const release = withResolvers<void>();

      const transacting = yield* spawn(function* () {
        yield* database.transact(function* (transaction) {
          yield* transaction.journal.append(yielded("doomed", "doomed"));
          inside.resolve();
          yield* release.operation;
          throw new Error("this transaction publishes nothing");
        });
      });

      yield* inside.operation;
      const appending = yield* spawn(function* () {
        yield* database.journal.append(yielded("survivor", "survivor"));
      });

      yield* sleep(20);
      release.resolve();
      yield* transacting;
      yield* appending;

      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["survivor"]);
  });

  it("WJ18: operations on one handle run one at a time", function* () {
    const root = yield* useStorageRoot();

    const log = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const order: string[] = [];

      yield* all(
        Array.from({ length: 4 }, (_unused, index) =>
          (function* () {
            const result = yield* database.transact(function* () {
              order.push(`enter ${index}`);
              // A suspension point inside the body: if two transactions could
              // hold the connection at once, this is where they would overlap.
              yield* sleep(5);
              order.push(`leave ${index}`);
              return index;
            });
            if (!result.ok) {
              throw result.error;
            }
          })(),
        ),
      );

      return order;
    });

    expect(log).toHaveLength(8);
    for (let position = 0; position < log.length; position += 2) {
      const entered = log[position];
      expect(entered.startsWith("enter ")).toBe(true);
      expect(log[position + 1]).toBe(`leave ${entered.slice("enter ".length)}`);
    }
  });

  it("WJ19: a caller cancelled while queued never reaches the connection", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inside = withResolvers<void>();
      const release = withResolvers<void>();

      const holding = yield* spawn(function* () {
        yield* database.transact(function* () {
          inside.resolve();
          yield* release.operation;
          return "done";
        });
      });

      yield* inside.operation;

      const queued = yield* spawn(function* () {
        yield* database.journal.append(yielded("queued", "queued"));
      });

      yield* sleep(20);
      yield* queued.halt();

      release.resolve();
      yield* holding;

      return yield* database.journal.readAll();
    });

    expect(events).toEqual([]);
  });
});

describe("Tier WJ — two handles on one run", () => {
  it("WJ20: a second handle waits for the first, and the host keeps running", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const first = yield* createRun();
      const second = yield* createRun();
      expect(second).not.toBe(first);

      const holding = withResolvers<void>();
      const release = withResolvers<void>();
      const order: string[] = [];
      let ticks = 0;

      // SQLite is reached synchronously. A second handle that entered SQLite
      // rather than waiting would stop this timer — and stop the first
      // transaction from ever resuming to commit.
      const ticking = yield* spawn(function* () {
        while (true) {
          yield* sleep(5);
          ticks += 1;
        }
      });

      const transacting = yield* spawn(function* () {
        const result = yield* first.transact(function* () {
          order.push("first holds");
          holding.resolve();
          yield* release.operation;
          order.push("first commits");
          return "done";
        });
        if (!result.ok) {
          throw result.error;
        }
      });

      yield* holding.operation;
      const before = ticks;

      const waiting = yield* spawn(function* () {
        const result = yield* second.readDocumentExecutions();
        order.push(result.ok ? "second ran" : "second failed");
      });

      yield* sleep(60);
      const during = ticks;
      order.push("second still waiting");

      release.resolve();
      yield* transacting;
      yield* waiting;
      yield* ticking.halt();

      return { order, before, during };
    });

    expect(seen.during).toBeGreaterThan(seen.before + 3);
    expect(seen.order).toEqual([
      "first holds",
      "second still waiting",
      "first commits",
      "second ran",
    ]);
  });

  it("WJ21: a second handle's work is not enlisted in the first's transaction", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const first = yield* createRun();
      const second = yield* createRun();

      const holding = withResolvers<void>();
      const release = withResolvers<void>();

      const transacting = yield* spawn(function* () {
        yield* first.transact(function* (transaction) {
          yield* transaction.journal.append(yielded("doomed", "doomed"));
          holding.resolve();
          yield* release.operation;
          throw new Error("this transaction publishes nothing");
        });
      });

      yield* holding.operation;
      const appending = yield* spawn(function* () {
        yield* second.journal.append(yielded("survivor", "survivor"));
      });

      yield* sleep(20);
      release.resolve();
      yield* transacting;
      yield* appending;

      return yield* first.journal.readAll();
    });

    expect(names(events)).toEqual(["survivor"]);
  });
});

describe("Tier WJ — two callers creating at once", () => {
  it("WJ22: compatible concurrent creation converges on one run", function* () {
    const root = yield* useStorageRoot();

    const opened = yield* withStorage(root, function* () {
      return yield* all(
        Array.from({ length: 4 }, () =>
          (function* () {
            const result = yield* create(request());
            if (!result.ok) {
              throw result.error;
            }
            return result.value.record;
          })(),
        ),
      );
    });

    const created = new Set(opened.map((record) => record.createdAt));
    expect(created.size).toBe(1);
    for (const record of opened) {
      expect(record.runId).toBe("release-1.4");
    }
  });

  it("WJ23: conflicting concurrent creation produces one winner and one conflict", function* () {
    const root = yield* useStorageRoot();

    const results = yield* withStorage(root, function* () {
      return yield* all([create(request({ base: "main" })), create(request({ base: "develop" }))]);
    });

    const succeeded = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);

    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].ok === false && refused[0].error).toBeInstanceOf(WorkflowRunConflictError);
  });
});

describe("Tier WJ — explicit transaction journal routing", () => {
  it("WJ26: an exact active token routes an already-filtered event after the gate", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "routed" });
      const result = yield* database.transact(function* (transaction) {
        const token = yield* workflowRunTransactionToken(database, transaction);
        const guarded = guardDurableStream(database.journal, function* () {
          expect(names(yield* transaction.journal.readAll())).toEqual([]);
        });
        yield* withEnlistedJournalRoute(
          database,
          transaction,
          token,
          guarded.append(yielded("routed", "filtered")),
        );
        expect(names(yield* transaction.journal.readAll())).toEqual(["routed"]);
      });
      if (!result.ok) {
        throw result.error;
      }
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["routed"]);
  });

  it("WJ27: rejected and cancelled gates reach no routed insertion", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "route-gates" });
      const result = yield* database.transact(function* (transaction) {
        const token = yield* workflowRunTransactionToken(database, transaction);
        const rejected = guardDurableStream(database.journal, function* () {
          throw new Error("secret gate refused the event");
        });
        expect(
          yield* attempt(() =>
            withEnlistedJournalRoute(
              database,
              transaction,
              token,
              rejected.append(yielded("rejected", "rejected")),
            ),
          ),
        ).toBeInstanceOf(Error);

        const gateStarted = withResolvers<void>();
        const cancelled = guardDurableStream(database.journal, function* () {
          gateStarted.resolve();
          yield* suspend();
        });
        const task = yield* spawn(() =>
          withEnlistedJournalRoute(
            database,
            transaction,
            token,
            cancelled.append(yielded("cancelled", "cancelled")),
          ),
        );
        yield* gateStarted.operation;
        yield* task.halt();
        expect(names(yield* transaction.journal.readAll())).toEqual([]);
        yield* transaction.journal.append(yielded("companion", "companion"));
      });
      if (!result.ok) {
        throw result.error;
      }
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["companion"]);
  });

  it("WJ28: missing, fabricated, foreign and cross-run routes fail before insertion", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "route-first" });
      const second = yield* createRun({ runId: "route-second" });
      const transacted = yield* first.transact(function* (firstTransaction) {
        const valid = yield* workflowRunTransactionToken(first, firstTransaction);
        const missing = tokenValue(undefined, valid);
        const fabricated = new WorkflowRunTransactionToken();
        const candidates = [missing, fabricated];
        for (const token of candidates) {
          expect(
            yield* attempt(() =>
              withEnlistedJournalRoute(
                first,
                firstTransaction,
                token,
                first.journal.append(yielded("unauthorized", "unauthorized")),
              ),
            ),
          ).toBeInstanceOf(WorkflowTransactionError);
        }

        const nested = yield* second.transact(function* (secondTransaction) {
          expect(
            yield* attempt(() =>
              withEnlistedJournalRoute(
                second,
                secondTransaction,
                valid,
                second.journal.append(yielded("cross-run", "cross-run")),
              ),
            ),
          ).toBeInstanceOf(WorkflowTransactionError);
        });
        if (!nested.ok) {
          throw nested.error;
        }
      });
      if (!transacted.ok) {
        throw transacted.error;
      }
      return {
        first: yield* first.journal.readAll(),
        second: yield* second.journal.readAll(),
      };
    });

    expect(result).toEqual({ first: [], second: [] });
  });

  it("WJ29: completed, closed and stale-generation authority cannot bind", function* () {
    const root = yield* useStorageRoot();
    let closedDatabase: WorkflowRunDatabase | undefined;
    let completedTransaction: WorkflowRunTransaction | undefined;
    let staleToken: WorkflowRunTransactionToken | undefined;

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "route-stale" });
      closedDatabase = database;
      const result = yield* database.transact(function* (transaction) {
        completedTransaction = transaction;
        staleToken = yield* workflowRunTransactionToken(database, transaction);
      });
      if (!result.ok) {
        throw result.error;
      }
      const transaction = completedTransaction;
      const token = staleToken;
      if (transaction === undefined || token === undefined) {
        throw new Error("the transaction did not leave route authority for the refusal proof");
      }
      expect(
        yield* attempt(() =>
          withEnlistedJournalRoute(
            database,
            transaction,
            token,
            database.journal.append(yielded("completed", "completed")),
          ),
        ),
      ).toBeInstanceOf(WorkflowTransactionError);
    });

    const closed = closedDatabase;
    const transaction = completedTransaction;
    const token = staleToken;
    if (closed === undefined || transaction === undefined || token === undefined) {
      throw new Error("the prior provider did not leave route authority");
    }
    const events = yield* withStorage(root, function* () {
      const found = yield* WorkflowRunStorage.operations.lookup("route-stale");
      if (!found.ok) {
        throw found.error;
      }
      const database = found.value;
      expect(
        yield* attempt(() =>
          withEnlistedJournalRoute(
            closed,
            transaction,
            token,
            closed.journal.append(yielded("closed", "closed")),
          ),
        ),
      ).toBeInstanceOf(WorkflowTransactionError);

      const current = yield* database.transact(function* (currentTransaction) {
        expect(
          yield* attempt(() =>
            withEnlistedJournalRoute(
              database,
              currentTransaction,
              token,
              database.journal.append(yielded("stale", "stale")),
            ),
          ),
        ).toBeInstanceOf(WorkflowTransactionError);
      });
      if (!current.ok) {
        throw current.error;
      }
      return yield* database.journal.readAll();
    });
    expect(events).toEqual([]);
  });

  it("WJ30: escaped route authority appends nothing after transaction completion", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "route-escaped" });
      let escapedTransaction: WorkflowRunTransaction | undefined;
      let escapedToken: WorkflowRunTransactionToken | undefined;
      const result = yield* database.transact(function* (transaction) {
        escapedTransaction = transaction;
        escapedToken = yield* workflowRunTransactionToken(database, transaction);
      });
      if (!result.ok) {
        throw result.error;
      }
      const transaction = escapedTransaction;
      const token = escapedToken;
      if (transaction === undefined || token === undefined) {
        throw new Error("route authority did not escape for the refusal proof");
      }
      expect(
        yield* attempt(() =>
          withEnlistedJournalRoute(
            database,
            transaction,
            token,
            database.journal.append(yielded("late", "late")),
          ),
        ),
      ).toBeInstanceOf(WorkflowTransactionError);
      return yield* database.journal.readAll();
    });

    expect(events).toEqual([]);
  });

  it("WJ31: an unrelated concurrent append never inherits an enlisted route", function* () {
    const root = yield* useStorageRoot();

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "route-unrelated" });
      const beginUnrelated = withResolvers<void>();
      const unrelated = yield* spawn(function* () {
        yield* beginUnrelated.operation;
        yield* database.journal.append(yielded("unrelated", "unrelated"));
      });

      const result = yield* database.transact(function* (transaction) {
        const token = yield* workflowRunTransactionToken(database, transaction);
        yield* withEnlistedJournalRoute(
          database,
          transaction,
          token,
          database.journal.append(yielded("rolled-back", "rolled-back")),
        );
        beginUnrelated.resolve();
        throw new Error("roll back the routed transaction");
      });
      expect(result.ok).toBe(false);
      yield* unrelated;
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["unrelated"]);
  });

  it("WJ32: a nested route for another run delegates to the enclosing destination", function* () {
    const root = yield* useStorageRoot();
    let collisions = 0;
    yield* CollidingJournalDestination.around(
      {
        // deno-lint-ignore require-yield
        *append(): Operation<boolean> {
          collisions += 1;
          return true;
        },
      },
      { at: "min" },
    );

    const events = yield* withStorage(root, function* () {
      const first = yield* createRun({ runId: "route-outer" });
      const second = yield* createRun({ runId: "route-inner" });
      const outer = yield* first.transact(function* (firstTransaction) {
        const firstToken = yield* workflowRunTransactionToken(first, firstTransaction);
        const nested = yield* withEnlistedJournalRoute(
          first,
          firstTransaction,
          firstToken,
          (function* () {
            return yield* second.transact(function* (secondTransaction) {
              const secondToken = yield* workflowRunTransactionToken(second, secondTransaction);
              yield* withEnlistedJournalRoute(
                second,
                secondTransaction,
                secondToken,
                (function* () {
                  yield* first.journal.append(yielded("outer", "outer"));
                  yield* second.journal.append(yielded("inner", "inner"));
                })(),
              );
            });
          })(),
        );
        if (!nested.ok) {
          throw nested.error;
        }
      });
      if (!outer.ok) {
        throw outer.error;
      }
      return {
        first: yield* first.journal.readAll(),
        second: yield* second.journal.readAll(),
      };
    });

    expect(names(events.first)).toEqual(["outer"]);
    expect(names(events.second)).toEqual(["inner"]);
    expect(collisions).toBe(0);
  });

  it("WJ33: readAll remains ordinary replay and never invokes a gate or route", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "route-read" });
      yield* database.journal.append(yielded("existing", "existing"));
      let gates = 0;
      const guarded = guardDurableStream(database.journal, function* () {
        gates += 1;
      });
      expect(names(yield* guarded.readAll())).toEqual(["existing"]);

      const transacted = yield* database.transact(function* (transaction) {
        const token = yield* workflowRunTransactionToken(database, transaction);
        yield* withEnlistedJournalRoute(
          database,
          transaction,
          token,
          (function* () {
            expect(yield* attempt(() => guarded.readAll())).toBeInstanceOf(
              WorkflowTransactionError,
            );
            expect(names(yield* transaction.journal.readAll())).toEqual(["existing"]);
          })(),
        );
      });
      if (!transacted.ok) {
        throw transacted.error;
      }
      return { gates, events: yield* guarded.readAll() };
    });

    expect(result.gates).toBe(0);
    expect(names(result.events)).toEqual(["existing"]);
  });

  it("WJ34: a colliding destination cannot suppress an ordinary append", function* () {
    const root = yield* useStorageRoot();
    let collisions = 0;
    yield* CollidingJournalDestination.around(
      {
        // deno-lint-ignore require-yield
        *append(): Operation<boolean> {
          collisions += 1;
          return true;
        },
      },
      { at: "min" },
    );

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "route-collision-ordinary" });
      yield* database.journal.append(yielded("ordinary", "ordinary"));
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["ordinary"]);
    expect(collisions).toBe(0);
  });

  it("WJ35: a colliding destination cannot suppress or authorize a routed append", function* () {
    const root = yield* useStorageRoot();
    let collisions = 0;
    yield* CollidingJournalDestination.around(
      {
        // deno-lint-ignore require-yield
        *append(): Operation<boolean> {
          collisions += 1;
          return true;
        },
      },
      { at: "min" },
    );

    const events = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "route-collision-routed" });
      const result = yield* database.transact(function* (transaction) {
        const token = yield* workflowRunTransactionToken(database, transaction);
        yield* withEnlistedJournalRoute(
          database,
          transaction,
          token,
          database.journal.append(yielded("routed", "routed")),
        );
        expect(
          yield* attempt(() =>
            withEnlistedJournalRoute(
              database,
              transaction,
              tokenValue({}, token),
              database.journal.append(yielded("fabricated", "fabricated")),
            ),
          ),
        ).toBeInstanceOf(WorkflowTransactionError);
      });
      if (!result.ok) {
        throw result.error;
      }
      return yield* database.journal.readAll();
    });

    expect(names(events)).toEqual(["routed"]);
    expect(collisions).toBe(0);
  });
});

describe("Tier WJ — surviving a process", () => {
  it("WJ24: two processes racing to create one run leave one winner", function* () {
    const root = yield* useStorageRoot();
    const marker = join(root, "marker.txt");
    writeFileSync(marker, "");

    // Genuinely separate processes with genuinely separate connections, so the
    // convergence is SQLite's write lock rather than one thread's turn-taking.
    const [first, second] = yield* all([
      runChild(root, "raced", marker, "main"),
      runChild(root, "raced", marker, "develop"),
    ]);

    const outcomes = [JSON.parse(first.out), JSON.parse(second.out)];
    const created = outcomes.filter((one) => one.refused === undefined);
    const refused = outcomes.filter((one) => one.refused !== undefined);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);

    // Two mechanisms refuse a second creator, and which one speaks depends on
    // how far the winner has got — not on anything either process decides.
    // Reaching the run while the winner still holds it is refused by the lock,
    // before any storage is opened; reaching it after the winner has released
    // is refused by the run that is now there. Both are one winner, so the test
    // names both rather than pinning the timing that chooses between them.
    expect(["already-running", "WorkflowRunConflictError"]).toContain(refused[0].refused);

    // The winner's base is whichever one got there first, and it is the only
    // base the run has.
    expect(["main", "develop"]).toContain(created[0].base);
  });

  it("WJ25: a second process restores the run and re-executes nothing", function* () {
    const root = yield* useStorageRoot();
    const marker = join(root, "marker.txt");
    writeFileSync(marker, "");

    const first = yield* runChild(root, "restart", marker);
    expect(first.code).toBe(0);

    const second = yield* runChild(root, "restart", marker);
    expect(second.code).toBe(0);

    // Every durable operation ran once. The second process restored their
    // results from the retained journal instead of performing them again.
    expect(readFileSync(marker, "utf8")).toBe("first\nsecond\nthird\n");

    const before = JSON.parse(first.out);
    const after = JSON.parse(second.out);

    expect(after.value).toBe(before.value);
    expect(after.status).toBe("completed");
    // Order and identity both survive: the same events, the same ids, in the
    // same sequence, read by a process that never saw them written.
    expect(after.events).toEqual(before.events);
    expect(after.events.map((event: { name?: string }) => event.name)).toEqual([
      "first",
      "second",
      "third",
      undefined,
    ]);
  });
});
