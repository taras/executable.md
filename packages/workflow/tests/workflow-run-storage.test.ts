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

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists, readdir } from "@effectionx/fs";
import { type Operation, race, type Result, scoped, sleep, until } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { DatabaseSync } from "node:sqlite";
import {
  type CreateWorkflowRunRequest,
  type GitWorkflowDefinitionV1,
  WORKFLOW_RUN_STATUSES,
  WorkflowDatabaseClosedError,
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowDefinitionError,
  WorkflowIncompleteVersionOneError,
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
import { createWorkflowRunConnections } from "../src/deno/connections.ts";
import { WorkflowRunRecognition } from "../src/deno/provider.ts";
import { holdRecoveryCoordination } from "../src/deno/recovery-coordination.ts";
import { EXPECTED_SCHEMA, initializeSchema } from "../src/deno/schema.ts";
import { readRepositories } from "../src/deno/workspace/repositories.ts";
import {
  EMPTY_WORKSPACE_MANIFEST,
  EMPTY_WORKSPACE_ROOT_ID,
  WORKSPACE_ROOT_FORMAT,
} from "../src/deno/workspace/manifest.ts";
import {
  createRun,
  definition,
  relaxRunConstraints,
  request,
  runPath,
  SHA1,
  tamper,
  useStorageRoot,
  withBegunRun,
  withStorage,
} from "./support/storage.ts";

const { create, lookup } = WorkflowRunStorage.operations;

/** Every entry in the storage root, so a test can prove nothing else appeared. */
function entries(root: string): Operation<string[]> {
  return readdir(root);
}

function normalizedSchema(database: DatabaseSync): Array<{
  name: string;
  type: string;
  sql: string;
}> {
  return database
    .prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => ({
      name: String(row["name"]),
      type: String(row["type"]),
      sql: String(row["sql"]).replace(/\s+/g, " ").trim(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function initializeIntermediateVersionOne(database: DatabaseSync): void {
  const statuses = "'running', 'suspended', 'interrupted', 'completed', 'failed', 'cancelled'";
  const reason = `CHECK (
    (stop_reason_kind IS NULL AND stop_reason_code IS NULL AND stop_reason_event_id IS NULL)
    OR (stop_reason_kind = 'host' AND stop_reason_code IS NOT NULL AND stop_reason_event_id IS NULL)
    OR (stop_reason_kind = 'journal' AND stop_reason_code IS NULL AND stop_reason_event_id IS NOT NULL)
  )`;
  database.exec(`
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = 1;
    CREATE TABLE journal_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      record TEXT NOT NULL CHECK (json_valid(record))
    ) STRICT;
    CREATE TABLE workflow_run (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      run_id TEXT NOT NULL,
      definition TEXT NOT NULL CHECK (json_valid(definition)),
      base TEXT NOT NULL,
      props TEXT NOT NULL CHECK (json_valid(props) AND json_type(props) = 'object'),
      status TEXT NOT NULL CHECK (status IN (${statuses})),
      stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
      stop_reason_code TEXT,
      stop_reason_event_id TEXT REFERENCES journal_events (event_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ${reason}
    ) STRICT;
    CREATE TABLE definition_retrieval (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      metadata TEXT NOT NULL CHECK (json_valid(metadata)),
      revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE document_executions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      stop_status TEXT CHECK (stop_status IS NULL OR stop_status IN (${statuses})),
      stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
      stop_reason_code TEXT,
      stop_reason_event_id TEXT REFERENCES journal_events (event_id),
      CHECK ((stopped_at IS NULL) = (stop_status IS NULL)),
      CHECK (stop_status IS NOT NULL OR stop_reason_kind IS NULL),
      ${reason}
    ) STRICT;
  `);
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

/**
 * The operation's answer, or `undefined` when it was still waiting.
 *
 * Waiting is the whole observation here: a call that has to take coordination
 * blocks behind whoever holds it, and a call that does not answers at once.
 */
function promptly<T>(body: () => Operation<T>): Operation<T | undefined> {
  return race([body(), stillWaiting()]);
}

function* stillWaiting(): Operation<undefined> {
  yield* sleep(500);
  return undefined;
}

function fabricatedId(value: unknown): string {
  const container: { id: string } = { id: "" };
  Object.defineProperty(container, "id", { value, enumerable: true });
  return container.id;
}

describe("Tier WS — authoritative connection and complete schema", () => {
  it("WS0: one provider entry owns each run connection and its DOFS wrappers", function* () {
    const root = yield* useStorageRoot();
    const connections = createWorkflowRunConnections();
    const first = yield* connections.at(join(root, "first.sqlite"));
    const again = yield* connections.at(join(root, ".", "first.sqlite"));
    const other = yield* connections.at(join(root, "other.sqlite"));

    expect(again).toBe(first);
    expect(again.database).toBe(first.database);
    expect(again.dofs).toBe(first.dofs);
    expect(again.filesystem).toBe(first.filesystem);
    expect(other).not.toBe(first);

    connections.close();
    expect(() => first.database.prepare("SELECT 1")).toThrow();
    let refused: unknown;
    try {
      yield* connections.at(join(root, "later.sqlite"));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
  });

  it("WS0a: one physical opening takes recovery coordination once", function* () {
    const root = yield* useStorageRoot();
    const connections = createWorkflowRunConnections();
    const path = join(root, "coordinated.sqlite");

    const first = yield* connections.at(path);

    // Cached lookups pay nothing for coordination: they answer with the same
    // connection while another owner is holding the sidecar, because the
    // opening that had to prove recovery already happened.
    yield* scoped(function* () {
      yield* holdRecoveryCoordination(path);
      expect(yield* promptly(() => connections.at(path))).toBe(first);
      expect(yield* promptly(() => connections.at(join(root, ".", "coordinated.sqlite")))).toBe(
        first,
      );
    });

    // Closing it makes the next call a new physical opening, which waits for
    // the same sidecar all over again.
    connections.close(path);
    yield* scoped(function* () {
      yield* holdRecoveryCoordination(path);
      expect(yield* promptly(() => connections.at(path))).toBeUndefined();
    });

    const reopened = yield* connections.at(path);
    expect(reopened).not.toBe(first);
    connections.close();
  });

  it("WS0b: DOFS transactionSync uses a savepoint in the caller-owned transaction", function* () {
    const root = yield* useStorageRoot();
    const connections = createWorkflowRunConnections();
    const connection = yield* connections.at(join(root, "savepoint.sqlite"));

    connection.database.exec("BEGIN IMMEDIATE");
    const transaction = connection.beginTransaction();
    expect(() =>
      connection.dofs.transactionSync(() => {
        connection.dofs.run("CREATE TABLE rolled_back (value TEXT)");
        throw new Error("roll back the nested work");
      }),
    ).toThrow(Error);
    connection.database.exec("CREATE TABLE outer_survives (value TEXT)");
    connection.finishTransaction(transaction);
    connection.database.exec("COMMIT");

    const names = connection.database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row["name"]);
    expect(names).toContain("outer_survives");
    expect(names).not.toContain("rolled_back");
    connections.close();
  });

  it("WS0c: rolling back fresh initialization leaves no partial schema", function* () {
    const root = yield* useStorageRoot();
    const connections = createWorkflowRunConnections();
    const connection = yield* connections.at(join(root, "atomic.sqlite"));

    connection.database.exec("BEGIN IMMEDIATE");
    const transaction = connection.beginTransaction();
    expect(() =>
      initializeSchema(connection.database, connection.dofs, () => {
        throw new Error("fail after the filesystem and root are initialized");
      }),
    ).toThrow(Error);
    connection.finishTransaction(transaction);
    connection.database.exec("ROLLBACK");

    expect(normalizedSchema(connection.database)).toEqual([]);
    expect(connection.database.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(0);
    expect(connection.database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(0);
    connections.close();
  });

  it("WS0d: a fresh run has the frozen complete-v1 schema and canonical empty root", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const database = new DatabaseSync(runPath(root, "release-1.4"));
    try {
      const expected = [...EXPECTED_SCHEMA].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      expect(normalizedSchema(database)).toEqual(expected);
      expect(database.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(
        APPLICATION_ID,
      );
      expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(1);
      expect(
        database.prepare("SELECT v FROM vfs_meta WHERE k = 'schema_version'").get()?.["v"],
      ).toBe(5);
      expect(database.prepare("SELECT * FROM workspace_roots").all()).toEqual([
        {
          root_id: EMPTY_WORKSPACE_ROOT_ID,
          format_version: WORKSPACE_ROOT_FORMAT,
          manifest: EMPTY_WORKSPACE_MANIFEST,
        },
      ]);
      expect(database.prepare("SELECT * FROM workspace_state").all()).toEqual([
        { singleton_id: 1, current_root_id: EMPTY_WORKSPACE_ROOT_ID },
      ]);
      expect(database.prepare("SELECT * FROM workspace_root_manifest_refs").all()).toEqual([]);
      expect(database.prepare("SELECT * FROM workspace_root_blob_refs").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("WS0e: existing-run recognition and its run row share one SQLite snapshot", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "recognition-snapshot");
    yield* withStorage(root, function* () {
      yield* createRun({ runId: "recognition-snapshot" });
    });

    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA journal_mode = WAL");
    let observedTransaction = false;
    let probes = 0;
    try {
      const found = yield* scoped(function* () {
        yield* WorkflowRunRecognition.set((reader) => {
          probes += 1;
          observedTransaction = reader.isTransaction;
          writer
            .prepare("UPDATE workflow_run SET run_id = ? WHERE id = 1")
            .run("committed-after-validation");
        });
        return yield* withStorage(root, function* () {
          return yield* lookup("recognition-snapshot");
        });
      });

      expect(found.ok).toBe(true);
      expect(found.ok && found.value.record.runId).toBe("recognition-snapshot");
      expect(probes).toBe(1);
      expect(observedTransaction).toBe(true);
      expect(writer.prepare("SELECT run_id FROM workflow_run WHERE id = 1").get()?.["run_id"]).toBe(
        "committed-after-validation",
      );
    } finally {
      writer.close();
    }
  });

  it("WS0f: a recognition failure closes its SQLite read transaction", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "recognition-rollback");
    yield* withStorage(root, function* () {
      yield* createRun({ runId: "recognition-rollback" });
    });
    const before = yield* until(readFile(path));
    let observed: DatabaseSync | undefined;

    const raised = yield* scoped(function* () {
      yield* WorkflowRunRecognition.set((reader) => {
        observed = reader;
        throw new Error("recognition probe failed");
      });
      return yield* withStorage(root, function* () {
        let failure: unknown;
        try {
          yield* lookup("recognition-rollback");
        } catch (error) {
          failure = error;
        }
        expect(observed?.isTransaction).toBe(false);
        return failure;
      });
    });

    expect(raised).toBeInstanceOf(Error);
    expect(yield* until(readFile(path))).toEqual(before);
  });
});

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

    // One file named for the run, and the empty sidecar its write-capable
    // opening took to keep a reader from copying the database and journal
    // half-recovered. The sidecar is host arrangement outside the
    // `<hash>.sqlite` namespace discovery matches, and neither file indexes
    // anything: there is still no registry.
    expect(yield* entries(root)).toEqual([
      `${hashRunId("release-1.4")}.sqlite`,
      `${hashRunId("release-1.4")}.sqlite.recovery.lock`,
    ]);
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
    // Still one run: the second entry is the coordination sidecar, which the
    // cached connection did not take a second time either.
    const kept = yield* entries(root);
    expect(kept.filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
    expect(kept).toHaveLength(2);
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
    expect(yield* entries(root)).toEqual([]);
    expect(yield* exists(runPath(root, "never-started"))).toBe(false);
  });

  it("WS7: a database holding another run is a collision, not this run's", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      yield* createRun({ runId: "release-1.4" });

      // The file is moved to where a different id would look for it, which is
      // what a hash collision or a tampered root would produce.
      const wrong = runPath(root, "release-9.9");
      yield* until(writeFile(wrong, yield* until(readFile(runPath(root, "release-1.4")))));

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

    expect(yield* entries(root)).toEqual([]);
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
    expect(yield* entries(root)).toEqual([]);
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
    expect(yield* entries(root)).toEqual([]);
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

    const seen: { status: WorkflowRunStatus; reason: WorkflowStopReason | undefined }[] = [];
    for (const status of WORKFLOW_RUN_STATUSES) {
      // A status is published by settling an execution, and one acquisition
      // settles one — so each status is a run of its own rather than six
      // rewrites of one row.
      yield* withBegunRun(
        root,
        function* (run) {
          const updated = yield* run.settle({
            status,
            reason: { kind: "host", code: `stopped-${status}` },
          });
          if (!updated.ok) {
            throw updated.error;
          }
          seen.push({ status: updated.value.status, reason: updated.value.stopReason });
        },
        `release-${status}`,
      );
    }
    const stored = seen;

    expect(stored.map((entry) => entry.status)).toEqual([...WORKFLOW_RUN_STATUSES]);
    for (const entry of stored) {
      expect(entry.reason).toEqual({ kind: "host", code: `stopped-${entry.status}` });
    }
  });

  it("WS11: a stop reason may point at a filtered journal event instead", function* () {
    const root = yield* useStorageRoot();

    const record = yield* withBegunRun(root, function* (run) {
      const database = run.database;

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

      const updated = yield* run.settle({
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

    const result = yield* withBegunRun(root, function* (run) {
      return yield* run.settle({
        status: "failed",
        reason: { kind: "journal", eventId: "an-event-that-was-never-appended" },
      });
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
  });

  it("WS11c: an execution stop reason naming a missing event is refused", function* () {
    const root = yield* useStorageRoot();

    const seen = yield* withBegunRun(root, function* (run) {
      const result = yield* run.settle({
        status: "failed",
        reason: { kind: "journal", eventId: "an-event-that-was-never-appended" },
      });
      const executions = yield* run.database.readDocumentExecutions();
      if (!executions.ok) {
        throw executions.error;
      }
      return { result, execution: executions.value[0] };
    });

    expect(seen.result.ok).toBe(false);
    expect(!seen.result.ok && seen.result.error).toBeInstanceOf(WorkflowRequestError);
    expect(seen.execution.stoppedAt).toBeUndefined();
    expect(seen.execution.stopStatus).toBeUndefined();
  });

  it("WS12: a stop reason is parsed on the way in, not only type-checked", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withBegunRun(root, function* (run) {
      // Type-legal and empty: a code that names nothing is refused here rather
      // than becoming a row whose reason says nothing.
      return yield* run.settle({ status: "failed", reason: { kind: "host", code: "" } });
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
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

    const written = yield* withBegunRun(root, function* (run) {
      yield* run.database.replaceRetrievalMetadata({ checkout: "/tmp/a" });
      const settled = yield* run.settle({
        status: "suspended",
        reason: { kind: "host", code: "awaiting-input" },
      });
      if (!settled.ok) {
        throw settled.error;
      }
      return { record: settled.value, executionId: run.execution.executionId };
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

    const executionId = yield* withBegunRun(root, function* (run) {
      return run.execution.executionId;
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

    const result = yield* escaped[0].readDocumentExecutions();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseClosedError);
  });

  it("WS18b: closing one lease leaves another lease on the authoritative entry usable", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const escaped: WorkflowRunDatabase[] = [];
      yield* scoped(function* () {
        escaped.push(yield* createRun());
      });

      const current = yield* createRun();
      const closed = yield* escaped[0].readDocumentExecutions();
      const read = yield* current.readDocumentExecutions();

      expect(closed.ok).toBe(false);
      expect(!closed.ok && closed.error).toBeInstanceOf(WorkflowDatabaseClosedError);
      expect(read.ok).toBe(true);
    });
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
      yield* until(writeFile(path, "this file is not a database, and padding to be sure of it"));
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseFormatError);
  });

  it("WS21: an unsupported schema version is not read or migrated", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "run-2");

    const result = yield* withStorage(root, function* () {
      yield* createRun({ runId: "run-2" });
      tamper(path, (database) => {
        database.exec("PRAGMA user_version = 2");
      });
      return yield* lookup("run-2");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowSchemaVersionError);

    tamper(path, (database) => {
      expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
      expect(database.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(
        APPLICATION_ID,
      );
    });
  });

  it("WS21a: XMD-identified version zero is partial initialization", function* () {
    const root = yield* useStorageRoot();
    const partials: Array<[string, (database: DatabaseSync) => void]> = [
      [
        "identified-v0",
        (database) => {
          database.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 0`);
        },
      ],
      [
        "identified-v0-dofs",
        (database) => {
          database.exec(`
            PRAGMA application_id = ${APPLICATION_ID};
            PRAGMA user_version = 0;
            CREATE TABLE vfs_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
          `);
        },
      ],
    ];

    for (const [runId, initialize] of partials) {
      const path = runPath(root, runId);
      tamper(path, initialize);
      const before = yield* until(readFile(path));

      const result = yield* withStorage(root, function* () {
        return yield* lookup(runId);
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
      expect(!result.ok && result.error).not.toBeInstanceOf(WorkflowSchemaVersionError);
      expect(yield* until(readFile(path))).toEqual(before);
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
      const before = yield* until(readFile(path));

      const result = yield* withStorage(root, function* () {
        return yield* create(request({ runId }));
      });

      expect(result.ok).toBe(false);
      expect(yield* until(readFile(path))).toEqual(before);
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
        "extra-index",
        (database) => database.exec("CREATE INDEX souvenirs ON workflow_run(updated_at)"),
      ],
      [
        "extra-view",
        (database) => database.exec("CREATE VIEW shortcut AS SELECT run_id FROM workflow_run"),
      ],
    ];

    const results = yield* withStorage(root, function* () {
      const seen: {
        runId: string;
        result: Result<WorkflowRunDatabase>;
        unchanged: boolean;
      }[] = [];
      for (const [runId, damage] of damaged) {
        yield* createRun({ runId });
        const path = runPath(root, runId);
        tamper(path, damage);
        const before = yield* until(readFile(path));
        const result = yield* lookup(runId);
        seen.push({
          runId,
          result,
          unchanged: (yield* until(readFile(path))).equals(before),
        });
      }
      return seen;
    });

    for (const { runId, result, unchanged } of results) {
      expect(result.ok).toBe(false);
      expect(unchanged).toBe(true);
      if (result.ok) {
        continue;
      }
      expect([runId, result.error.constructor.name]).toEqual([
        runId,
        WorkflowDatabaseCorruptError.name,
      ]);
    }
  });

  it("WS22b: the exact intermediate metadata-only version 1 is refused unchanged", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    tamper(path, initializeIntermediateVersionOne);
    const before = yield* until(readFile(path));

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowIncompleteVersionOneError);
    expect(!result.ok && result.error.message).toContain("Delete and recreate");
    expect(yield* until(readFile(path))).toEqual(before);
  });

  it("WS22c: partial DOFS and retained-root initialization are corruption and stay unchanged", function* () {
    const root = yield* useStorageRoot();
    const partials: Array<[string, (database: DatabaseSync) => void]> = [
      [
        "partial-dofs",
        (database) => {
          database.exec("CREATE TABLE vfs_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
        },
      ],
      [
        "partial-root",
        (database) => {
          database.exec(`
            PRAGMA application_id = ${APPLICATION_ID};
            PRAGMA user_version = 1;
            CREATE TABLE workspace_roots (
              root_id TEXT PRIMARY KEY,
              format_version INTEGER NOT NULL,
              manifest TEXT NOT NULL
            ) STRICT;
          `);
        },
      ],
    ];

    for (const [runId, initialize] of partials) {
      const path = runPath(root, runId);
      tamper(path, initialize);
      const before = yield* until(readFile(path));
      const result = yield* withStorage(root, function* () {
        return yield* lookup(runId);
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
      expect(yield* until(readFile(path))).toEqual(before);
    }
  });

  it("WS22d: malformed empty-root and live-frontier state is refused unchanged", function* () {
    const root = yield* useStorageRoot();
    const corruptions: Array<[string, (database: DatabaseSync) => void]> = [
      [
        "malformed-root",
        (database) => {
          database.prepare("UPDATE workspace_roots SET manifest = '{}'").run();
        },
      ],
      [
        "changed-frontier",
        (database) => {
          database.prepare("UPDATE vfs_nodes SET mtime = 1 WHERE inode = 1").run();
        },
      ],
      [
        "unexpected-blob",
        (database) => {
          const bytes = new Uint8Array([1]);
          database
            .prepare("INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, 1, 0)")
            .run(bytes);
          database
            .prepare("INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)")
            .run(bytes, bytes);
        },
      ],
    ];

    for (const [runId, corrupt] of corruptions) {
      yield* withStorage(root, function* () {
        yield* createRun({ runId });
      });
      const path = runPath(root, runId);
      tamper(path, corrupt);
      const before = yield* until(readFile(path));

      const result = yield* withStorage(root, function* () {
        return yield* lookup(runId);
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
      expect(yield* until(readFile(path))).toEqual(before);
    }
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

    const stopped = yield* withBegunRun(
      root,
      function* (run) {
        const settled = yield* run.settle({ status: "completed" });
        if (!settled.ok) {
          throw settled.error;
        }

        // Deliberately impossible retained state: no supported transition
        // writes a stop time that is not a time, so the row is edited directly.
        tamper(runPath(root, "bad-stop-time"), (raw) => {
          raw.prepare("UPDATE document_executions SET stopped_at = 'whenever'").run();
        });

        const found = yield* lookup("bad-stop-time");
        if (!found.ok) {
          throw found.error;
        }
        return yield* found.value.readDocumentExecutions();
      },
      "bad-stop-time",
    );

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
    const executions = yield* withBegunRun(root, function* () {
      // A sequence SQLite can hold and JavaScript cannot: no transition writes
      // one, so it is set directly.
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
    expect(yield* entries(root)).toEqual([]);
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
      const bytes = yield* until(readFile(path));
      bytes.fill(0x5a, 4096, bytes.length);
      yield* until(writeFile(path, bytes));

      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
    expect((yield* until(readFile(path))).length).toBeGreaterThan(4096);
  });
});

describe("Tier WS — a run of one section", () => {
  it("WS28: a stored exact target survives the process unchanged", function* () {
    const root = yield* useStorageRoot();
    const targeted = definition({ targetPath: "Release/Publish%2FNotes" });

    const written = yield* withStorage(root, function* () {
      const database = yield* createRun({ definition: targeted });
      return database.record;
    });

    expect(written.definition.targetPath).toBe("Release/Publish%2FNotes");

    // A second scope reads it back out of SQLite and parses it again, so the
    // column, the serializer, and the parser all agree about one target.
    const restored = yield* withStorage(root, function* () {
      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      return found.value.record;
    });

    expect(restored.definition).toEqual(written.definition);
    expect(restored.definition.targetPath).toBe("Release/Publish%2FNotes");
  });

  it("WS29: an untargeted run reopens with no target member at all", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const restored = yield* withStorage(root, function* () {
      const found = yield* lookup("release-1.4");
      if (!found.ok) {
        throw found.error;
      }
      return found.value.record;
    });

    expect("targetPath" in restored.definition).toBe(false);
  });

  it("WS30: one run id cannot be reused for a different section, or for the whole document", function* () {
    const root = yield* useStorageRoot();

    const conflicts = yield* withStorage(root, function* () {
      yield* createRun({ definition: definition({ targetPath: "Release/Publish" }) });

      const attempts = [
        { asked: "another section", definition: definition({ targetPath: "Release/Announce" }) },
        { asked: "the whole document", definition: definition() },
      ];

      const errors: { asked: string; result: Result<WorkflowRunDatabase> }[] = [];
      for (const attempt of attempts) {
        errors.push({
          asked: attempt.asked,
          result: yield* create(request({ definition: attempt.definition })),
        });
      }
      return errors;
    });

    for (const { asked, result } of conflicts) {
      expect({ asked, ok: result.ok }).toEqual({ asked, ok: false });
      if (result.ok) {
        continue;
      }
      expect(result.error).toBeInstanceOf(WorkflowRunConflictError);
      expect(result.error.message).toContain("definition");
      // The section that was asked for is document content, not a field name.
      expect(result.error.message).not.toContain("Announce");
      expect(result.error.message).not.toContain("Publish");
    }
  });

  it("WS31: a targeted run is found again by the request that created it", function* () {
    const root = yield* useStorageRoot();
    const targeted = definition({ targetPath: "Release/Publish" });

    const same = yield* withStorage(root, function* () {
      const first = yield* createRun({ definition: targeted });
      const again = yield* create(request({ definition: targeted }));
      if (!again.ok) {
        throw again.error;
      }
      return first.record.runId === again.value.record.runId;
    });

    expect(same).toBe(true);
  });

  it("WS32: a whole-document run refuses to be reused as a targeted one", function* () {
    const root = yield* useStorageRoot();

    const result = yield* withStorage(root, function* () {
      yield* createRun();
      return yield* create(request({ definition: definition({ targetPath: "Release/Publish" }) }));
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WorkflowRunConflictError);
      expect(result.error.message).toContain("definition");
    }
  });
});

/**
 * The #293 amendment: Repository and Worktree metadata is part of version 1.
 *
 * There is no version 2, no migration and no second reader. A database a
 * pre-amendment development build produced is an incomplete pre-release, which
 * is the same answer the very first pre-release shape already gets — and the
 * point of these tests is that it is the *only* answer, because the alternative
 * is a build that reads half a schema and calls the run continued.
 */
describe("Tier WS — version 1 amended in place", () => {
  /**
   * The shape that was complete before Repository and Worktree metadata joined
   * it, derived from the current declaration rather than copied out of it.
   *
   * Derived, so this stays the pre-amendment shape as version 1 goes on being
   * amended: a hand-written copy would drift into being some third shape and
   * would then prove nothing about the one builds actually produced.
   */
  function initializePreAmendmentVersionOne(database: DatabaseSync): void {
    initializeShapeWithout(database, [...AMENDED_TABLES, ...ANSWER_TABLES, ...FORK_TABLES]);
  }

  /** The shape complete before retained answer delivery joined version 1. */
  function initializePreAnswerVersionOne(database: DatabaseSync): void {
    initializeShapeWithout(database, [...ANSWER_TABLES, ...FORK_TABLES]);
  }

  /** The shape complete before fork lineage and inherited provenance joined it. */
  function initializePreForkVersionOne(database: DatabaseSync): void {
    initializeShapeWithout(database, FORK_TABLES);
  }

  /**
   * One shape that once claimed to be a complete version 1.
   *
   * Built by leaving out whichever amendments had not been made yet, so a new
   * amendment adds one name here and one prior shape rather than silently
   * turning every fixture below into a shape no build ever produced.
   */
  function initializeShapeWithout(database: DatabaseSync, omitted: readonly string[]): void {
    database.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
    for (const object of EXPECTED_SCHEMA) {
      if (omitted.includes(object.name)) {
        continue;
      }
      database.exec(`${object.sql};`);
    }
    database.exec("PRAGMA user_version = 1;");
  }

  const AMENDED_TABLES = ["workspace_repositories", "workspace_worktrees"];

  const ANSWER_TABLES = ["workflow_suspension_answers"];

  const FORK_TABLES = ["workflow_fork_lineage", "journal_event_provenance"];

  it("WS23a: version 1 declares the Repository and Worktree tables", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const declared = EXPECTED_SCHEMA.filter((object) => AMENDED_TABLES.includes(object.name));
    expect(declared.map((object) => object.name)).toEqual(AMENDED_TABLES);

    const database = new DatabaseSync(runPath(root, "release-1.4"));
    try {
      expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(1);
      expect(database.prepare("SELECT * FROM workspace_repositories").all()).toEqual([]);
      expect(database.prepare("SELECT * FROM workspace_worktrees").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("WS23b: the pre-amendment complete shape is refused unchanged", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    tamper(path, initializePreAmendmentVersionOne);
    const before = yield* until(readFile(path));

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowIncompleteVersionOneError);
    expect(yield* until(readFile(path))).toEqual(before);
  });

  it("WS23c: a Worktree row naming no Repository is damage, not partial state", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const path = runPath(root, "release-1.4");
    // With enforcement turned off, which is how an editor outside XMD would
    // leave a row pointing at nothing.
    tamper(path, (database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare(
          `INSERT INTO workspace_worktrees
             (repository_name, name, requested_branch, requested_base, creation_commit, checkout_path)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("absent", "implementation", "feature/new", null, "0".repeat(40), "/worktrees/x");
    });

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
  });

  it("WS23d: a malformed retained row is reported rather than repaired", function* () {
    const database = new DatabaseSync(":memory:");
    try {
      // The constraints version 1 declares refuse these values outright, so the
      // only way one reaches a parser is a table somebody rebuilt without them
      // — which is exactly the state an outside editor leaves behind.
      database.exec(`
        CREATE TABLE workspace_repositories (
          name TEXT, locator TEXT, locator_fingerprint TEXT, requested_base TEXT,
          creation_commit TEXT, primary_branch TEXT, object_format TEXT, checkout_path TEXT
        );
      `);
      const insert = database.prepare(
        `INSERT INTO workspace_repositories VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("project", "/remote.git", "f".repeat(64), null, "abc", "main", "md5", "/r/p");
      expect(() => readRepositories(database)).toThrow(WorkflowRecordMalformedError);

      database.exec("DELETE FROM workspace_repositories");
      insert.run("project", "/remote.git", "not-a-digest", null, "abc", "main", "sha1", "/r/p");
      expect(() => readRepositories(database)).toThrow(WorkflowRecordMalformedError);

      database.exec("DELETE FROM workspace_repositories");
      insert.run("project", "/remote.git", "f".repeat(64), null, "abc", "main", "sha1", "relative");
      expect(() => readRepositories(database)).toThrow(WorkflowRecordMalformedError);
    } finally {
      database.close();
    }
  });

  it("WS23e: there is no version 2 to migrate to", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const path = runPath(root, "release-1.4");
    tamper(path, (database) => {
      database.exec("PRAGMA user_version = 2");
    });
    const before = yield* until(readFile(path));

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowSchemaVersionError);
    // Described and left exactly as found: nothing upgraded it, and nothing
    // downgraded it either.
    expect(yield* until(readFile(path))).toEqual(before);
  });

  it("WS33a: version 1 declares the retained answer table", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const declared = EXPECTED_SCHEMA.filter((object) => ANSWER_TABLES.includes(object.name));
    expect(declared.map((object) => object.name)).toEqual(ANSWER_TABLES);

    const database = new DatabaseSync(runPath(root, "release-1.4"));
    try {
      expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(1);
      expect(database.prepare("SELECT * FROM workflow_suspension_answers").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("WS33b: the shape before retained delivery is refused unchanged", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    tamper(path, initializePreAnswerVersionOne);
    const before = yield* until(readFile(path));

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    // An incomplete pre-release rather than arbitrary damage: this is a shape a
    // build really produced, and saying so is what tells its owner the run
    // cannot be continued rather than that the file is broken.
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowIncompleteVersionOneError);
    expect(yield* until(readFile(path))).toEqual(before);
  });

  it("WS34a: version 1 declares the fork lineage and provenance tables", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const declared = EXPECTED_SCHEMA.filter((object) => FORK_TABLES.includes(object.name));
    expect(declared.map((object) => object.name)).toEqual(FORK_TABLES);

    const database = new DatabaseSync(runPath(root, "release-1.4"));
    try {
      expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(1);
      // A run that is not a fork declares them and holds nothing in them.
      expect(database.prepare("SELECT * FROM workflow_fork_lineage").all()).toEqual([]);
      expect(database.prepare("SELECT * FROM journal_event_provenance").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("WS34b: the shape before fork lineage is refused unchanged", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    tamper(path, initializePreForkVersionOne);
    const before = yield* until(readFile(path));

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowIncompleteVersionOneError);
    expect(yield* until(readFile(path))).toEqual(before);
  });

  it("WS33c: a damaged answer row is damage, not a row to ignore", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun();
    });

    const path = runPath(root, "release-1.4");
    // Rebuilt without the constraints version 1 declares, which is the only way
    // a row like this exists — and exactly what an editor outside XMD leaves.
    tamper(path, (database) => {
      database.exec("DROP TABLE workflow_suspension_answers");
      database.exec(`
        CREATE TABLE workflow_suspension_answers (
          suspension_id TEXT PRIMARY KEY, request_event_id TEXT, request_fingerprint TEXT,
          answer TEXT, state TEXT, created_at TEXT, consumed_at TEXT
        );
      `);
    });

    const result = yield* withStorage(root, function* () {
      return yield* lookup("release-1.4");
    });

    expect(result.ok).toBe(false);
    // The table is there and its name is right; its declaration is not the one
    // version 1 writes, so recognition refuses it rather than reading rows
    // through a parser that assumes the constraints hold.
    expect(!result.ok && result.error).toBeInstanceOf(WorkflowDatabaseCorruptError);
  });
});
