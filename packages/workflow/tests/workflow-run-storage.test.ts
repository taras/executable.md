/**
 * Tier WS — retained workflow runs, through the production Deno adapter.
 *
 * Nothing here is a stand-in. Every test writes a real SQLite file into a real
 * directory and reads it back, because what is being checked is what survives a
 * process — and an in-memory provider cannot answer that question however
 * faithfully it implements the contract.
 *
 * Two shapes recur. A run is addressed by its public id and nothing else, so
 * the tests never name a path except to prove one was or was not created. And a
 * database that is not this run's is described and left alone, so the tests
 * that damage a file also check the file afterwards.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import { type Result, scoped } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { DatabaseSync } from "node:sqlite";
import {
  type CreateWorkflowRunRequest,
  type GitWorkflowDefinitionV1,
  WORKFLOW_RUN_STATUSES,
  WorkflowDatabaseClosedError,
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowDefinitionError,
  WorkflowRecordMalformedError,
  WorkflowRequestError,
  WorkflowRunConflictError,
  type WorkflowRunDatabase,
  WorkflowRunIdMismatchError,
  WorkflowRunNotFoundError,
  WorkflowRunStorage,
  type WorkflowRunStatus,
  WorkflowSchemaVersionError,
  type WorkflowStopReason,
} from "../mod.ts";
import type { JsonObject } from "../src/storage/members.ts";
import { APPLICATION_ID, hashRunId, useWorkflowRunStorage } from "../deno.ts";
import {
  createRun,
  definition,
  relaxRunConstraints,
  request,
  runPath,
  SHA1,
  tamper,
  useStorageRoot,
  withStorage,
} from "./support/storage.ts";

const { create, lookup } = WorkflowRunStorage.operations;

/** Every entry in the storage root, so a test can prove nothing else appeared. */
function entries(root: string): string[] {
  return readdirSync(root);
}

/**
 * A props value the interface forbids, for testing that storage checks anyway.
 *
 * The type says props are an object; nothing stops a host built without types,
 * or one that read them from a file, from handing over something else.
 */
function fabricated(value: Json): JsonObject {
  const container: { props: JsonObject } = { props: {} };
  Object.defineProperty(container, "props", { value, enumerable: true });
  return container.props;
}

/** The same trick for a whole request, and for a run id. */
function fabricatedRequest(value: unknown): CreateWorkflowRunRequest {
  const container: { request: CreateWorkflowRunRequest } = { request: request() };
  Object.defineProperty(container, "request", { value, enumerable: true });
  return container.request;
}

function fabricatedId(value: unknown): string {
  const container: { id: string } = { id: "" };
  Object.defineProperty(container, "id", { value, enumerable: true });
  return container.id;
}

describe("Tier WS — creating and finding a run", () => {
  it("WS1: a run is one file named for its id, and there is no registry", function* () {
    const root = yield* useStorageRoot();

    const record = yield* withStorage(root, function* () {
      const database = yield* createRun();
      return database.record;
    });

    expect(record.runId).toBe("release-1.4");
    expect(record.definition).toEqual(definition());
    expect(record.base).toBe("main");
    expect(record.props).toEqual({ channel: "stable" });
    expect(record.status).toBe("running");

    expect(entries(root)).toEqual([`${hashRunId("release-1.4")}.sqlite`]);
  });

  it("WS2: creating an id twice with the same request addresses one run", function* () {
    const root = yield* useStorageRoot();

    const [first, second] = yield* withStorage(root, function* () {
      const a = yield* createRun();
      const b = yield* createRun();
      return [a.record, b.record];
    });

    expect(second.runId).toBe(first.runId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(entries(root)).toHaveLength(1);
  });

  it("WS3: props are compared as values, not as the text they were written in", function* () {
    const root = yield* useStorageRoot();

    const record = yield* withStorage(root, function* () {
      yield* createRun({ props: { channel: "stable", tags: ["a", "b"] } });
      const again = yield* createRun({ props: { tags: ["a", "b"], channel: "stable" } });
      return again.record;
    });

    expect(record.props).toEqual({ channel: "stable", tags: ["a", "b"] });
  });

  it("WS4: every immutable field refuses a different value under the same id", function* () {
    const root = yield* useStorageRoot();

    const conflicts = yield* withStorage(root, function* () {
      yield* createRun();

      const attempts = [
        { field: "base", overrides: { base: "develop" } },
        { field: "props", overrides: { props: { channel: "beta" } } },
        {
          field: "definition",
          overrides: { definition: definition({ objectId: SHA1.replace("9", "a") }) },
        },
        {
          field: "definition",
          overrides: { definition: definition({ rootDocumentPath: "workflows/other.md" }) },
        },
      ];

      const errors: { field: string; result: Result<WorkflowRunDatabase> }[] = [];
      for (const attempt of attempts) {
        const result = yield* create(request(attempt.overrides));
        errors.push({ field: attempt.field, result });
      }
      return errors;
    });

    for (const { field, result } of conflicts) {
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error).toBeInstanceOf(WorkflowRunConflictError);
      expect(result.error.message).toContain(field);
    }
  });

  it("WS5: a conflict names the field and never the value behind it", function* () {
    const root = yield* useStorageRoot();
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

    const result = yield* withStorage(root, function* () {
      yield* createRun({ props: { token: secret } });
      return yield* create(request({ props: { token: `${secret}-other` } }));
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).not.toContain(secret);
  });

  it("WS6: looking up a run that is not stored creates no file", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      return yield* lookup("never-started");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRunNotFoundError);
    expect(entries(root)).toEqual([]);
    expect(yield* exists(runPath(root, "never-started"))).toBe(false);
  });

  it("WS7: a database holding another run is a collision, not this run's", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      yield* createRun({ runId: "release-1.4" });

      // The file is moved to where a different id would look for it, which is
      // what a hash collision or a tampered root would produce.
      const wrong = runPath(root, "release-9.9");
      writeFileSync(wrong, readFileSync(runPath(root, "release-1.4")));

      return yield* lookup("release-9.9");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRunIdMismatchError);
  });

  it("WS8: a request that describes no run is refused before anything is opened", function* () {
    const root = yield* useStorageRoot();

    // Each of these type-checks and still describes no run, which is why the
    // adapter parses a request rather than trusting the shape it arrived in.
    const unparsed: GitWorkflowDefinitionV1 = {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: "not-hexadecimal",
      rootDocumentPath: "workflows/release.md",
    };

    const results = yield* withStorage(root, function* () {
      return [
        yield* create(request({ runId: "" })),
        yield* create(request({ base: "" })),
        yield* create(request({ props: { retries: Number.POSITIVE_INFINITY } })),
        yield* create(request({ definition: unparsed })),
      ];
    });

    for (const result of results.slice(0, 3)) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
    }
    const descriptor = results[3];
    expect(descriptor.ok).toBe(false);
    expect(!descriptor.ok && descriptor.error).toBeInstanceOf(WorkflowDefinitionError);

    expect(entries(root)).toEqual([]);
  });

  it("WS8b: a request that is not even a request answers, rather than throwing", function* () {
    const root = yield* useStorageRoot();

    // The types say what a caller meant. What arrives is whatever the language
    // allows — a host built without types, or one that read a request out of a
    // file — and reading `.runId` off `null` fails as a TypeError rather than
    // as an answer about the request.
    const results = yield* withStorage(root, function* () {
      return [
        yield* create(fabricatedRequest(null)),
        yield* create(fabricatedRequest(undefined)),
        yield* create(fabricatedRequest("a string")),
        yield* create(fabricatedRequest({ ...request(), extra: "undeclared" })),
        yield* create(fabricatedRequest({ ...request(), runId: 17 })),
      ];
    });

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
    }
    expect(entries(root)).toEqual([]);
  });

  it("WS8c: a lookup id that is not a usable id answers the same way", function* () {
    const root = yield* useStorageRoot();

    const results = yield* withStorage(root, function* () {
      return [
        yield* lookup(fabricatedId(undefined)),
        yield* lookup(fabricatedId(null)),
        yield* lookup(fabricatedId(42)),
        yield* lookup(""),
        yield* lookup("has-a\u0000nul"),
      ];
    });

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
    }
    expect(entries(root)).toEqual([]);
  });

  it("WS9: a storage root that is not an absolute path is refused", function* () {
    // Where a run lives must not depend on the working directory a process
    // happened to start in, and `~` is a shell convenience rather than a path.
    for (const root of ["", ".xmd/runs", "~/.xmd/runs"]) {
      let raised: unknown;
      try {
        yield* scoped(function* () {
          yield* useWorkflowRunStorage({ root });
        });
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(WorkflowRequestError);
    }
  });
});

describe("Tier WS — what a run retains", () => {
  it("WS10: every one of the six statuses survives, with its stop reason", function* () {
    const root = yield* useStorageRoot();

    const stored = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const seen: { status: WorkflowRunStatus; reason: WorkflowStopReason | undefined }[] = [];

      for (const status of WORKFLOW_RUN_STATUSES) {
        const updated = yield* database.updateRunState({
          status,
          reason: { kind: "host", code: `stopped-${status}` },
        });
        if (!updated.ok) {
          throw updated.error;
        }
        seen.push({ status: updated.value.status, reason: updated.value.stopReason });
      }
      return seen;
    });

    expect(stored.map((entry) => entry.status)).toEqual([...WORKFLOW_RUN_STATUSES]);
    for (const entry of stored) {
      expect(entry.reason).toEqual({ kind: "host", code: `stopped-${entry.status}` });
    }
  });

  it("WS11: a stop reason may point at a filtered journal event instead", function* () {
    const root = yield* useStorageRoot();

    const record = yield* withStorage(root, function* () {
      const database = yield* createRun();

      // The event has to be there. A reason naming one that is not is a
      // reason referring to nothing, which is why the reference is enforced.
      yield* database.journal.append({
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "failing" },
        result: { status: "err", error: { message: "filtered" } },
      });
      const entries = yield* database.readJournalEntries();
      if (!entries.ok) {
        throw entries.error;
      }

      const updated = yield* database.updateRunState({
        status: "failed",
        reason: { kind: "journal", eventId: entries.value[0].eventId },
      });
      if (!updated.ok) {
        throw updated.error;
      }
      return { record: updated.value, eventId: entries.value[0].eventId };
    });

    expect(record.record.stopReason).toEqual({ kind: "journal", eventId: record.eventId });
  });

  it("WS11b: a stop reason naming an event this run does not hold is refused", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      const database = yield* createRun();
      return yield* database.updateRunState({
        status: "failed",
        reason: { kind: "journal", eventId: "an-event-that-was-never-appended" },
      });
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
  });

  it("WS12: a stop reason is parsed on the way in, not only type-checked", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      const database = yield* createRun();
      // Type-legal and empty: a code that names nothing is refused here rather
      // than becoming a row whose reason says nothing.
      return yield* database.updateRunState({
        status: "failed",
        reason: { kind: "host", code: "" },
      });
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
  });

  it("WS13: the initial start and every resume get a record of their own", function* () {
    const root = yield* useStorageRoot();

    const executions = yield* withStorage(root, function* () {
      const database = yield* createRun();

      const first = yield* database.beginDocumentExecution();
      if (!first.ok) {
        throw first.error;
      }
      const finished = yield* database.finishDocumentExecution({
        executionId: first.value.executionId,
        status: "interrupted",
        reason: { kind: "host", code: "executor-lost" },
      });
      if (!finished.ok) {
        throw finished.error;
      }

      const second = yield* database.beginDocumentExecution();
      if (!second.ok) {
        throw second.error;
      }

      const all = yield* database.readDocumentExecutions();
      if (!all.ok) {
        throw all.error;
      }
      return all.value;
    });

    expect(executions).toHaveLength(2);
    expect(executions[0].stopStatus).toBe("interrupted");
    expect(executions[0].stopReason).toEqual({ kind: "host", code: "executor-lost" });
    expect(executions[0].stoppedAt).toBeDefined();
    expect(executions[1].stoppedAt).toBeUndefined();
    expect(executions[1].executionId).not.toBe(executions[0].executionId);
  });

  it("WS14: an execution is finished once, by whoever began it", function* () {
    const root = yield* useStorageRoot();

    const results = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const started = yield* database.beginDocumentExecution();
      if (!started.ok) {
        throw started.error;
      }
      const completion = { executionId: started.value.executionId, status: "completed" } as const;

      return [
        yield* database.finishDocumentExecution(completion),
        yield* database.finishDocumentExecution(completion),
        yield* database.finishDocumentExecution({ executionId: "never-began", status: "failed" }),
      ];
    });

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(false);
  });

  it("WS15: retrieval metadata is replaceable and is not identity", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const database = yield* createRun();

      const first = yield* database.replaceRetrievalMetadata({
        checkout: "/tmp/a",
        remote: "https://example.invalid/a.git",
      });
      if (!first.ok) {
        throw first.error;
      }
      const afterFirst = database.retrieval;

      const second = yield* database.replaceRetrievalMetadata({ checkout: "/tmp/b" });
      if (!second.ok) {
        throw second.error;
      }
      const afterSecond = database.retrieval;

      // The same request still addresses the same run: retrieval took no part.
      const reused = yield* create(request());

      const cleared = yield* database.replaceRetrievalMetadata(undefined);
      if (!cleared.ok) {
        throw cleared.error;
      }

      return { afterFirst, afterSecond, reused, afterClear: database.retrieval };
    });

    expect(seen.afterFirst?.metadata).toEqual({
      checkout: "/tmp/a",
      remote: "https://example.invalid/a.git",
    });
    expect(seen.afterFirst?.revision).toBe(1);
    expect(seen.afterSecond?.metadata).toEqual({ checkout: "/tmp/b" });
    expect(seen.afterSecond?.revision).toBe(2);
    expect(seen.reused.ok).toBe(true);
    expect(seen.afterClear).toBeUndefined();
  });
});

describe("Tier WS — surviving the process", () => {
  it("WS15b: two handles replacing metadata do not lose each other's revision", function* () {
    const root = yield* useStorageRoot();

    // Both handles are opened before either replacement, so each one's own
    // snapshot says there is no metadata. A revision counted from the snapshot
    // rather than from the database would be written as one twice.
    const seen = yield* withStorage(root, function* () {
      const first = yield* createRun();
      const second = yield* createRun();

      const one = yield* first.replaceRetrievalMetadata({ checkout: "/tmp/a" });
      const two = yield* second.replaceRetrievalMetadata({ checkout: "/tmp/b" });
      if (!one.ok || !two.ok) {
        throw new Error("expected both replacements to be stored");
      }

      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      return found.value.retrieval;
    });

    expect(seen?.revision).toBe(2);
    expect(seen?.metadata).toEqual({ checkout: "/tmp/b" });
  });

  it("WS15c: clearing through one handle restarts a stale handle's next revision", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withStorage(root, function* () {
      const first = yield* createRun();
      const second = yield* createRun();

      yield* first.replaceRetrievalMetadata({ checkout: "/tmp/a" });
      yield* first.replaceRetrievalMetadata({ checkout: "/tmp/b" });
      yield* first.replaceRetrievalMetadata(undefined);

      // This handle still believes there is no metadata, and this time it is
      // right — but for a reason it did not observe.
      yield* second.replaceRetrievalMetadata({ checkout: "/tmp/c" });

      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      return found.value.retrieval;
    });

    expect(seen?.revision).toBe(1);
    expect(seen?.metadata).toEqual({ checkout: "/tmp/c" });
  });

  it("WS16: a second scope restores identity, state, retrieval and executions", function* () {
    const root = yield* useStorageRoot();

    const written = yield* withStorage(root, function* () {
      const database = yield* createRun({ props: { channel: "stable", tags: ["a"] } });
      yield* database.replaceRetrievalMetadata({ checkout: "/tmp/a" });

      const started = yield* database.beginDocumentExecution();
      if (!started.ok) {
        throw started.error;
      }
      yield* database.finishDocumentExecution({
        executionId: started.value.executionId,
        status: "suspended",
        reason: { kind: "host", code: "awaiting-input" },
      });
      yield* database.updateRunState({
        status: "suspended",
        reason: { kind: "host", code: "awaiting-input" },
      });

      return { record: database.record, executionId: started.value.executionId };
    });

    const restored = yield* withStorage(root, function* () {
      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      const executions = yield* found.value.readDocumentExecutions();
      if (!executions.ok) {
        throw executions.error;
      }
      return {
        record: found.value.record,
        retrieval: found.value.retrieval,
        executions: executions.value,
      };
    });

    expect(restored.record).toEqual(written.record);
    expect(restored.record.status).toBe("suspended");
    expect(restored.record.stopReason).toEqual({ kind: "host", code: "awaiting-input" });
    expect(restored.retrieval?.metadata).toEqual({ checkout: "/tmp/a" });
    expect(restored.executions).toHaveLength(1);
    expect(restored.executions[0].executionId).toBe(written.executionId);
  });

  it("WS17: an unfinished document execution is still unfinished afterwards", function* () {
    const root = yield* useStorageRoot();

    const executionId = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const started = yield* database.beginDocumentExecution();
      if (!started.ok) {
        throw started.error;
      }
      return started.value.executionId;
    });

    const restored = yield* withStorage(root, function* () {
      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      const executions = yield* found.value.readDocumentExecutions();
      if (!executions.ok) {
        throw executions.error;
      }
      return executions.value;
    });

    expect(restored).toHaveLength(1);
    expect(restored[0].executionId).toBe(executionId);
    expect(restored[0].stoppedAt).toBeUndefined();
    expect(restored[0].stopStatus).toBeUndefined();
  });

  it("WS18: a handle whose scope has closed answers, and reopens nothing", function* () {
    const root = yield* useStorageRoot();

    const escaped: WorkflowRunDatabase[] = [];
    yield* withStorage(root, function* () {
      escaped.push(yield* createRun());
    });

    const result = yield* escaped[0].updateRunState({ status: "completed" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseClosedError);
  });
});

describe("Tier WS — refusing what is not this run's database", () => {
  it("WS19: a file belonging to another program is described, not adopted", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const result = yield* withStorage(root, function* () {
      yield* createRun();
      tamper(path, (database) => {
        database.exec("PRAGMA application_id = 12345");
      });
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseFormatError);
    // Still there, still theirs.
    tamper(path, (database) => {
      const row = database.prepare("PRAGMA application_id").get();
      expect(row?.["application_id"]).toBe(12345);
    });
  });

  it("WS20: bytes that are not SQLite at all are a format failure", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const result = yield* withStorage(root, function* () {
      yield* createRun();
      writeFileSync(path, "this file is not a database, and padding to be sure of it");
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseFormatError);
  });

  it("WS21: neither an older nor a newer schema version is read or migrated", function* () {
    const root = yield* useStorageRoot();

    for (const version of [0, 2]) {
      const path = runPath(root, `run-${version}`);

      const result = yield* withStorage(root, function* () {
        yield* createRun({ runId: `run-${version}` });
        tamper(path, (database) => {
          database.exec(`PRAGMA user_version = ${version}`);
        });
        return yield* lookup(`run-${version}`);
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowSchemaVersionError);

      tamper(path, (database) => {
        expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(version);
        expect(database.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(
          APPLICATION_ID,
        );
      });
    }
  });

  it("WS21b: a file that only looks empty is not initialized into", function* () {
    const root = yield* useStorageRoot();

    // Pristine means all three: no application id, no schema version, and not
    // one object anybody created. Each of these fails one of them, and none of
    // them is a file this build has any business writing a run into.
    const occupied: [string, (database: DatabaseSync) => void][] = [
      ["versioned", (database) => database.exec("PRAGMA user_version = 7")],
      ["furnished", (database) => database.exec("CREATE TABLE theirs (a TEXT)")],
      [
        "labelled",
        (database) => {
          database.exec("PRAGMA application_id = 12345");
          database.exec("CREATE TABLE theirs (a TEXT)");
        },
      ],
    ];

    for (const [runId, occupy] of occupied) {
      const path = runPath(root, runId);
      tamper(path, occupy);
      const before = readFileSync(path);

      const result = yield* withStorage(root, function* () {
        return yield* create(request({ runId }));
      });

      expect(result.ok).toBe(false);
      expect(readFileSync(path)).toEqual(before);
    }
  });

  it("WS22: a recognized database that is not shaped like version 1 is damage", function* () {
    const root = yield* useStorageRoot();

    // The header already says this is a version-1 workflow run. Anything
    // missing or differently shaped is the file disagreeing with itself, not a
    // version this build has not learned or a file belonging to someone else.
    const damaged: [string, (database: DatabaseSync) => void][] = [
      ["no-table", (database) => database.exec("DROP TABLE definition_retrieval")],
      ["no-row", (database) => database.exec("DELETE FROM workflow_run")],
      ["relaxed", relaxRunConstraints],
      ["extra-table", (database) => database.exec("CREATE TABLE souvenirs (a TEXT)")],
      [
        "extra-view",
        (database) => database.exec("CREATE VIEW shortcut AS SELECT run_id FROM workflow_run"),
      ],
    ];

    const results = yield* withStorage(root, function* () {
      const seen: { runId: string; result: Result<WorkflowRunDatabase> }[] = [];
      for (const [runId, damage] of damaged) {
        yield* createRun({ runId });
        tamper(runPath(root, runId), damage);
        seen.push({ runId, result: yield* lookup(runId) });
      }
      return seen;
    });

    for (const { runId, result } of results) {
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect([runId, result.error.constructor.name]).toEqual([
        runId,
        WorkflowDatabaseCorruptError.name,
      ]);
    }
  });

  it("WS22b: the intermediate metadata-only version 1 is refused byte-for-byte", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    tamper(path, (database) => {
      database.exec(`
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
        CREATE TABLE journal_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          record TEXT NOT NULL CHECK (json_valid(record))
        ) STRICT;
        CREATE TABLE workflow_run (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE definition_retrieval (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE document_executions (sequence INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
      `);
    });
    const before = readFileSync(path);

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
    expect(!result.ok && result.error.message).toContain("Delete and recreate");
    expect(readFileSync(path)).toEqual(before);
  });

  it("WS23: a stored descriptor that describes no definition is refused", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const result = yield* withStorage(root, function* () {
      yield* createRun();
      // Valid JSON, and not a definition — which is why the column is parsed
      // rather than believed for having survived `json_valid`.
      tamper(path, (database) => {
        database.prepare(`UPDATE workflow_run SET definition = '{"kind":"git"}'`).run();
      });
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRecordMalformedError);
    expect(!result.ok && result.error.message).toContain("workflow_run.definition");
  });

  it("WS24: a value the schema admits and the record cannot use is refused", function* () {
    const root = yield* useStorageRoot();

    // These pass every constraint the table declares — `NOT NULL` text is text
    // whatever it says — so the parser is the only thing between them and a
    // record claiming to know when a run started or what it is called.
    const cases = [
      { runId: "empty-id", set: `run_id = ''`, column: "workflow_run.run_id" },
      { runId: "empty-base", set: `base = ''`, column: "workflow_run.base" },
      { runId: "vague-time", set: `created_at = 'a while ago'`, column: "workflow_run.created_at" },
      { runId: "loose-time", set: `updated_at = '2026-08-07'`, column: "workflow_run.updated_at" },
      {
        // The 31st of February: correctly shaped, and a day that never
        // happened. `Date` answers with the 3rd of March rather than refusing,
        // so only a round trip catches it.
        runId: "impossible-time",
        set: `created_at = '2026-02-31T00:00:00.000Z'`,
        column: "workflow_run.created_at",
      },
    ];

    for (const one of cases) {
      const result = yield* withStorage(root, function* () {
        yield* createRun({ runId: one.runId });
        tamper(runPath(root, one.runId), (database) => {
          database.prepare(`UPDATE workflow_run SET ${one.set}`).run();
        });
        return yield* lookup(one.runId);
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRecordMalformedError);
      expect(!result.ok && result.error.message).toContain(one.column);
    }
  });

  it("WS24b: a stored stop time and an oversized revision are refused too", function* () {
    const root = yield* useStorageRoot();

    const stopped = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "bad-stop-time" });
      const started = yield* database.beginDocumentExecution();
      if (!started.ok) {
        throw started.error;
      }
      yield* database.finishDocumentExecution({
        executionId: started.value.executionId,
        status: "completed",
      });

      tamper(runPath(root, "bad-stop-time"), (raw) => {
        raw.prepare("UPDATE document_executions SET stopped_at = 'whenever'").run();
      });

      const found = yield* lookup("bad-stop-time");
      if (!found.ok) {
        throw found.error;
      }
      return yield* found.value.readDocumentExecutions();
    });

    expect(stopped.ok).toBe(false);
    expect(!stopped.ok && stopped.error).toBeInstanceOf(WorkflowRecordMalformedError);
    expect(!stopped.ok && stopped.error.message).toContain("document_executions.stopped_at");

    // A revision SQLite can hold and JavaScript cannot. Version 1 bounds the
    // column, so storing one means removing the bound — and that is caught as
    // damage, before the number is read at all.
    const oversized = yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "huge-revision" });
      yield* database.replaceRetrievalMetadata({ checkout: "/tmp/a" });

      tamper(runPath(root, "huge-revision"), (raw) => {
        raw.exec(`
          DROP TABLE definition_retrieval;
          CREATE TABLE definition_retrieval (
            id INTEGER PRIMARY KEY, metadata TEXT, revision INTEGER, updated_at TEXT
          );
          INSERT INTO definition_retrieval
            VALUES (1, '{"checkout":"/tmp/a"}', 9223372036854775807, '2026-08-07T00:00:00.000Z');
        `);
      });

      return yield* lookup("huge-revision");
    });

    expect(oversized.ok).toBe(false);
    expect(!oversized.ok && oversized.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
    expect(!oversized.ok && oversized.error.message).not.toContain("9223372036854775807");
  });

  it("WS24d: a 64-bit stored number never escapes as a RangeError quoting it", function* () {
    const root = yield* useStorageRoot();

    // Not every integer column is bounded — a physical sequence is SQLite's
    // own. Read plainly, `node:sqlite` throws a RangeError that quotes the
    // number; every statement therefore reads integers as bigint, so the value
    // reaches a parser rather than an error message.
    const executions = yield* withStorage(root, function* () {
      const database = yield* createRun();
      const started = yield* database.beginDocumentExecution();
      if (!started.ok) {
        throw started.error;
      }

      tamper(runPath(root, "release-1.4"), (raw) => {
        raw.prepare("UPDATE document_executions SET sequence = 9223372036854775807").run();
      });

      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      return yield* found.value.readDocumentExecutions();
    });

    expect(executions.ok).toBe(true);
    expect(executions.ok && executions.value).toHaveLength(1);
  });

  it("WS24c: a journal event with no identity is refused", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* database.journal.append({
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "done" },
      });

      tamper(runPath(root, "release-1.4"), (raw) => {
        raw.prepare("UPDATE journal_events SET event_id = ''").run();
      });

      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      return yield* found.value.readJournalEntries();
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRecordMalformedError);
    expect(!result.ok && result.error.message).toContain("journal_events.event_id");
  });

  it("WS25: props that are not an object are refused by the schema and the parser", function* () {
    const root = yield* useStorageRoot();

    // A document declares named props, so a run receives a mapping. The
    // request is refused at the boundary, and the column would refuse it too.
    const results = yield* withStorage(root, function* () {
      return [
        yield* create(request({ props: fabricated("a bare string") })),
        yield* create(request({ props: fabricated(["an", "array"]) })),
        yield* create(request({ props: fabricated(null) })),
      ];
    });

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
    }
    expect(entries(root)).toEqual([]);
  });

  it("WS26: a malformed row is described without quoting what it held", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

    const result = yield* withStorage(root, function* () {
      yield* createRun();
      tamper(path, (database) => {
        database.prepare("UPDATE workflow_run SET created_at = ?").run(`not a time ${secret}`);
      });
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).not.toContain(secret);
  });

  it("WS27: a damaged image is reported as damage, and left where it is", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    const result = yield* withStorage(root, function* () {
      yield* createRun();
      tamper(path, (database) => {
        for (let index = 0; index < 400; index++) {
          database
            .prepare(
              `INSERT INTO journal_events (event_id, record, workspace_root_id)
               SELECT ?, ?, current_root_id FROM workspace_state WHERE singleton_id = 1`,
            )
            .run(`e${index}`, JSON.stringify({ padding: "x".repeat(200), index }));
        }
      });

      // Every page but the first is scribbled over, which is damage rather
      // than a file that was never a database.
      const bytes = readFileSync(path);
      bytes.fill(0x5a, 4096, bytes.length);
      writeFileSync(path, bytes);

      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
    expect(readFileSync(path).length).toBeGreaterThan(4096);
  });
});
