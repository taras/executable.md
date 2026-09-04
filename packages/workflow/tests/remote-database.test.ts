/**
 * Tier WRH — one run's storage, owned somewhere else.
 *
 * The interface is the same one the local host answers, so what is under test
 * is conformance rather than mechanism: a snapshot stays a snapshot, a nested
 * transaction refuses while unrelated work waits its turn, a closed handle is
 * closed, and every read is a fresh anchored one rather than a cache.
 *
 * The owner is a deterministic fake. What it is standing in for — atomic
 * application, authoritative revisions, anchored SQLite ordering — is proved on
 * real workerd; what is proved here is the handle's own behaviour, which is
 * arithmetic over what the owner said.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { Err, Ok, type Operation, type Result, scoped, sleep, spawn } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../src/storage/api.ts";
import { WorkflowDatabaseClosedError, WorkflowTransactionError } from "../src/storage/errors.ts";
import type { DefinitionRetrieval, DocumentExecutionRecord } from "../src/storage/record.ts";
import type { CommitIntent, StartingFrontier } from "../src/remote/collector.ts";
import type { CommitDecision } from "../src/remote/publication.ts";
import {
  activeWorkspaceRoute,
  type RemoteRunLink,
  useRemoteRunDatabase,
} from "../src/remote/database.ts";
import type { RemoteFrontierSnapshot } from "../src/remote/read.ts";

const ROOT = "a".repeat(64);
const RUN_ID = "remote-run";

function event(name: string): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  };
}

function frontierOf(entries: { eventId: string; event: DurableEvent }[]): RemoteFrontierSnapshot {
  return {
    record: {
      runId: RUN_ID,
      definition: {
        version: 1,
        kind: "git",
        objectFormat: "sha1",
        objectId: "0".repeat(40),
        rootDocumentPath: "README.md",
      },
      base: "main",
      props: {},
      status: "running",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
    retrieval: undefined,
    workspaceRootId: ROOT,
    journalEventId: entries.at(-1)?.eventId ?? null,
    entries: entries.map((entry) => ({ ...entry, workspaceRootId: ROOT })),
  };
}

/** An owner that answers from what it has been told, and records what it was asked. */
function owner(
  options: {
    retrieval?: (metadata: string | null) => Result<DefinitionRetrieval | undefined>;
    executions?: () => Result<DocumentExecutionRecord[]>;
    commit?: (intent: CommitIntent) => Result<CommitDecision>;
  } = {},
) {
  const retained: { eventId: string; event: DurableEvent }[] = [];
  const commits: CommitIntent[] = [];
  const retrievals: (string | null)[] = [];
  let frontierReads = 0;

  const link: RemoteRunLink = {
    *frontier(): Operation<StartingFrontier> {
      const snapshot = frontierOf(retained);
      return {
        workspaceRootId: snapshot.workspaceRootId,
        journalEventId: snapshot.journalEventId,
        events: snapshot.entries.map((entry) => entry.event),
      };
    },
    // deno-lint-ignore require-yield
    *frontierSnapshot(): Operation<RemoteFrontierSnapshot> {
      frontierReads += 1;
      return frontierOf(retained);
    },
    // deno-lint-ignore require-yield
    *commit(intent: CommitIntent): Operation<Result<CommitDecision>> {
      commits.push(intent);
      if (options.commit !== undefined) {
        return options.commit(intent);
      }
      const ids = intent.events.map((_entry, index) => `event-${retained.length + index}`);
      for (const [index, offered] of intent.events.entries()) {
        retained.push({ eventId: ids[index] ?? "", event: offered });
      }
      return Ok({ workspaceRootId: intent.expectedWorkspaceRootId, journalEventIds: ids });
    },
    // deno-lint-ignore require-yield
    *replaceRetrieval(
      _expected: string,
      metadata: string | null,
    ): Operation<Result<DefinitionRetrieval | undefined>> {
      retrievals.push(metadata);
      return options.retrieval === undefined
        ? Ok(
            metadata === null
              ? undefined
              : {
                  metadata: JSON.parse(metadata) as Json,
                  revision: retrievals.filter((entry) => entry !== null).length,
                  updatedAt: "2026-09-04T00:00:01.000Z",
                },
          )
        : options.retrieval(metadata);
    },
    // deno-lint-ignore require-yield
    *readExecutions(): Operation<Result<DocumentExecutionRecord[]>> {
      return options.executions === undefined ? Ok([]) : options.executions();
    },
  };

  return {
    link,
    commits,
    retrievals,
    retained,
    get frontierReads(): number {
      return frontierReads;
    },
    /** An event the owner retained without this handle asking. */
    appendElsewhere(name: string): void {
      retained.push({ eventId: `outside-${retained.length}`, event: event(name) });
    },
  };
}

function useDatabase(link: RemoteRunLink): Operation<WorkflowRunDatabase> {
  return useRemoteRunDatabase(link, frontierOf([]));
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

describe("a run whose storage is somewhere else", () => {
  it("initializes its snapshots from one frontier and does not refresh them", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      expect(database.record.runId).toBe(RUN_ID);
      expect(database.retrieval).toBe(undefined);

      remote.appendElsewhere("written by somebody else");
      // A read consults the owner; the handle's own snapshots do not move.
      expect(yield* database.journal.readAll()).toHaveLength(1);
      expect(database.record.runId).toBe(RUN_ID);
      expect(database.retrieval).toBe(undefined);
    });
  });

  it("reads a fresh journal every time and never serves a cache", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      expect(yield* database.journal.readAll()).toEqual([]);
      remote.appendElsewhere("later");
      expect(yield* database.journal.readAll()).toHaveLength(1);
      const entries = ok(yield* database.readJournalEntries());
      // The entry snapshot carries what the journal alone cannot: the owner's
      // identity for the row and the root it was written against.
      expect(entries[0]?.eventId).toBe("outside-0");
      expect(entries[0]?.workspaceRootId).toBe(ROOT);
      expect(remote.frontierReads).toBe(3);
    });
  });

  it("appends through the one commit path, as a journal-only transaction", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      yield* database.journal.append(event("appended"));
      expect(remote.commits).toHaveLength(1);
      expect(remote.commits[0]?.publication).toBe(null);
      expect(remote.commits[0]?.events).toHaveLength(1);
      expect(yield* database.journal.readAll()).toHaveLength(1);
    });
  });

  it("shows a transaction its own writes, and commits them once", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      remote.appendElsewhere("already there");
      const outcome = ok(
        yield* database.transact(function* (transaction) {
          yield* transaction.journal.append(event("mine"));
          // Read-your-writes: the admitted prefix, then this transaction's own.
          const seen = yield* transaction.journal.readAll();
          expect(seen).toHaveLength(2);
          return "body value";
        }),
      );
      expect(outcome).toBe("body value");
      expect(remote.commits).toHaveLength(1);
    });
  });

  it("refuses a nested transaction and any same-handle operation inside a body", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      const refusals: unknown[] = [];
      ok(
        yield* database.transact(function* () {
          const nested = yield* database.transact(function* () {
            return "never";
          });
          refusals.push(nested.ok ? undefined : nested.error);
          const read = yield* database.readJournalEntries();
          refusals.push(read.ok ? undefined : read.error);
          try {
            yield* database.journal.append(event("from inside"));
          } catch (error) {
            refusals.push(error);
          }
          return "done";
        }),
      );
      expect(refusals).toHaveLength(3);
      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(WorkflowTransactionError);
      }
      // None of them reached the owner.
      expect(remote.commits).toHaveLength(1);
    });
  });

  it("lets unrelated work wait its turn rather than refusing it", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      const order: string[] = [];
      const holding = yield* spawn(() =>
        database.transact(function* () {
          order.push("transaction started");
          yield* sleep(5);
          order.push("transaction finishing");
          return "held";
        }),
      );
      yield* sleep(0);
      // A different scope, not a descendant of the body.
      const waiting = yield* spawn(function* () {
        const entries = yield* database.readJournalEntries();
        order.push(entries.ok ? "read succeeded" : "read refused");
      });
      yield* holding;
      yield* waiting;
      expect(order).toEqual(["transaction started", "transaction finishing", "read succeeded"]);
    });
  });

  it("does not let another handle inherit this one's open transaction", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const first = yield* useDatabase(remote.link);
      const second = yield* useDatabase(remote.link);
      const outcome = ok(
        yield* first.transact(function* () {
          // A transaction on one handle says nothing about another.
          const other = yield* second.readJournalEntries();
          return other.ok ? "second read" : "second refused";
        }),
      );
      expect(outcome).toBe("second read");
    });
  });

  it("refuses every member once its scope has ended", function* () {
    const remote = owner();
    let database: WorkflowRunDatabase | undefined;
    yield* scoped(function* () {
      database = yield* useDatabase(remote.link);
    });
    if (database === undefined) {
      throw new Error("expected a handle");
    }
    const closed = database;
    const results = [
      yield* closed.readJournalEntries(),
      yield* closed.replaceRetrievalMetadata({ where: "later" }),
      yield* closed.readDocumentExecutions(),
      yield* closed.transact(function* () {
        return "never";
      }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(WorkflowDatabaseClosedError);
      }
    }
    let raised: unknown;
    try {
      yield* closed.journal.append(event("after close"));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(WorkflowDatabaseClosedError);
    // Nothing reached the owner after the handle closed.
    expect(remote.commits).toHaveLength(0);
    expect(remote.retrievals).toHaveLength(0);
  });

  it("updates only the handle whose replacement succeeded", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const first = yield* useDatabase(remote.link);
      const second = yield* useDatabase(remote.link);
      ok(yield* first.replaceRetrievalMetadata({ locator: "https://example.invalid/x.git" }));
      expect(first.retrieval?.revision).toBe(1);
      // Another handle's replacement is not this handle's snapshot.
      expect(second.retrieval).toBe(undefined);

      // Two calls carrying identical metadata are two replacements.
      ok(yield* first.replaceRetrievalMetadata({ locator: "https://example.invalid/x.git" }));
      expect(first.retrieval?.revision).toBe(2);

      ok(yield* first.replaceRetrievalMetadata(undefined));
      expect(first.retrieval).toBe(undefined);
      expect(remote.retrievals).toEqual([
        '{"locator":"https://example.invalid/x.git"}',
        '{"locator":"https://example.invalid/x.git"}',
        null,
      ]);
    });
  });

  it("canonicalizes metadata before it is sent", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      ok(yield* database.replaceRetrievalMetadata({ b: 1, a: { d: 2, c: 3 } }));
      // Sorted keys and no incidental whitespace, so two callers writing the
      // same metadata write the same bytes.
      expect(remote.retrievals[0]).toBe('{"a":{"c":3,"d":2},"b":1}');
    });
  });

  it("leaves its snapshot alone when a replacement is refused", function* () {
    const remote = owner({
      retrieval: () => Err(new WorkflowTransactionError("this run has moved")),
    });
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      const refused = yield* database.replaceRetrievalMetadata({ locator: "x" });
      expect(refused.ok).toBe(false);
      expect(database.retrieval).toBe(undefined);
    });
  });

  it("hands a Workspace route only to the exact database and transaction", function* () {
    const remote = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      const other = yield* useDatabase(remote.link);
      let held: WorkflowRunTransaction | undefined;
      ok(
        yield* database.transact(function* (transaction) {
          held = transaction;
          expect(yield* activeWorkspaceRoute(database, transaction)).not.toBe(undefined);
          // A foreign database, or a transaction object that is not this one.
          expect(yield* activeWorkspaceRoute(other, transaction)).toBe(undefined);
          expect(yield* activeWorkspaceRoute(database, { journal: transaction.journal })).toBe(
            undefined,
          );
          return "done";
        }),
      );
      if (held === undefined) {
        throw new Error("expected a transaction");
      }
      // Outside the body the route is gone, so a retained object reaches nothing.
      expect(yield* activeWorkspaceRoute(database, held)).toBe(undefined);
    });
  });

  it("sends no commit when the body fails, and answers with the refusal when the owner does", function* () {
    const failing = owner({ commit: () => Err(new WorkflowTransactionError("owner refused")) });
    yield* scoped(function* () {
      const database = yield* useDatabase(failing.link);
      const refused = yield* database.transact(function* (transaction) {
        yield* transaction.journal.append(event("attempted"));
        return "never returned";
      });
      expect(refused.ok).toBe(false);
    });

    const raising = owner();
    yield* scoped(function* () {
      const database = yield* useDatabase(raising.link);
      let caught: unknown;
      try {
        yield* database.transact(function* () {
          throw new Error("the body failed");
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(raising.commits).toHaveLength(0);
    });
  });

  it("returns the executions the owner assembled, in order", function* () {
    const executions: DocumentExecutionRecord[] = [
      { executionId: "one", startedAt: "2026-09-04T00:00:00.000Z" },
      {
        executionId: "two",
        startedAt: "2026-09-04T00:00:01.000Z",
        stoppedAt: "2026-09-04T00:00:02.000Z",
        stopStatus: "completed",
      },
    ];
    const remote = owner({ executions: () => Ok(executions) });
    yield* scoped(function* () {
      const database = yield* useDatabase(remote.link);
      expect(ok(yield* database.readDocumentExecutions())).toEqual(executions);
    });
  });
});
