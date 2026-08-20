/**
 * Tier WLI — immutable lifecycle inspection.
 *
 * These suites are about what reading a run may and may not do. The provider
 * under test is the real Deno one against real SQLite files, because the claim
 * is physical: a command that reports a run must leave its bytes, its rows and
 * its file mode exactly as it found them, and must never reach the connection
 * pool execution uses.
 *
 * A snapshot is checked as one reading rather than field by field. "The record
 * says completed" and "the frontier is this event" are only worth anything
 * together: separately they could describe two different moments of the same
 * run.
 */

import { chmod, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { copyFile, ensureDir, exists, rm, stat, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { when } from "@effectionx/converge";
import type { Close, DurableEvent, Yield } from "@executablemd/durable-streams";
import { SOURCE_POSITION_FIELD } from "@executablemd/core";
import {
  Git,
  WorkflowDatabaseFormatError,
  WorkflowInspectionRecoveryError,
  WorkflowLifecycle,
  type WorkflowHistoryEntry,
  type WorkflowLifecycleSnapshot,
  WorkflowRecordMalformedError,
  WorkflowRunIdMismatchError,
  WorkflowRunLocationMismatchError,
  WorkflowRunNotFoundError,
  WorkflowRunStorage,
} from "../mod.ts";
import { useWorkflowLifecycle } from "../deno.ts";
import { useWorkflowRunConnections } from "../src/deno/connections.ts";
import {
  installWorkflowLifecycle,
  type RecoveryObserver,
  type RecoveryPhase,
} from "../src/deno/lifecycle.ts";
import { holdRecoveryCoordination } from "../src/deno/recovery-coordination.ts";
import { translateSqliteError, WorkflowReadonlyRollbackError } from "../src/deno/schema.ts";
import { EMPTY_WORKSPACE_ROOT_ID } from "../src/deno/workspace/manifest.ts";
import {
  creation,
  withExecutorRun,
  runPath,
  tamper,
  useStorageRoot,
  withRunHost,
} from "./support/storage.ts";

const { history, inspect, list } = WorkflowLifecycle.operations;

/**
 * A run with a settled record, one execution and three retained events.
 *
 * The events name the run they belong to, so two runs of this fixture are told
 * apart by what they retain and not only by the ids SQLite happened to assign.
 */
function* retainedRun(root: string, runId: string): Operation<void> {
  yield* withRunHost(root, function* (transitions) {
    yield* withExecutorRun(
      transitions,
      { runId, action: "start", creation: creation() },
      function* (begun, executorLock) {
        yield* begun.database.journal.append(
          sourced("import_component", `Release:${runId}`, { line: 4, column: 2 }),
        );
        yield* begun.database.journal.append(unsourced("exec", `exec:echo ${runId}`));
        yield* begun.database.journal.append(closed("root"));
        const settled = yield* transitions.settle(executorLock, {
          executionId: begun.execution.executionId,
          status: "completed",
        });
        if (!settled.ok) {
          throw settled.error;
        }
      },
    );
  });
}

/** A run interrupted mid-execution: two events, no root Close, still `running`. */
function* partialRun(root: string, runId: string): Operation<void> {
  yield* withRunHost(root, function* (transitions) {
    yield* withExecutorRun(
      transitions,
      { runId, action: "start", creation: creation() },
      function* (begun) {
        yield* begun.database.journal.append(
          sourced("import_component", `Release:${runId}`, { line: 4, column: 2 }),
        );
        yield* begun.database.journal.append(unsourced("exec", `exec:echo ${runId}`));
      },
    );
  });
}

function sourced(type: string, name: string, at: { line: number; column: number }): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: {
      type,
      name,
      [SOURCE_POSITION_FIELD]: {
        path: "workflows/release.md",
        offset: 12,
        line: at.line,
        column: at.column,
      },
    },
    result: { status: "ok", value: "done" },
  };
}

function unsourced(type: string, name: string): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name },
    result: { status: "ok", value: "done" },
  };
}

function closed(coroutineId: string): Close {
  return { type: "close", coroutineId, result: { status: "ok", value: "rendered" } };
}

/** Read a run through the lifecycle provider alone, with no storage installed. */
function withLifecycle<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowLifecycle({ root });
    return yield* body();
  });
}

/** Everything about a file that a read must not change. */
interface Fingerprint {
  readonly bytes: string;
  readonly mode: number;
  readonly rows: string;
}

function* fingerprint(path: string): Operation<Fingerprint> {
  const bytes = yield* until(readFile(path));
  const mode = (yield* stat(path)).mode;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = [
      ...database.prepare("SELECT * FROM workflow_run").all(),
      ...database.prepare("SELECT event_id, record, workspace_root_id FROM journal_events").all(),
      ...database.prepare("SELECT * FROM document_executions").all(),
      ...database.prepare("SELECT * FROM workspace_state").all(),
    ];
    return {
      bytes: bytes.toString("base64"),
      mode,
      rows: JSON.stringify(rows),
    };
  } finally {
    database.close();
  }
}

function* snapshotOf(runId: string): Operation<WorkflowLifecycleSnapshot> {
  const answered = yield* inspect(runId);
  if (!answered.ok) {
    throw answered.error;
  }
  return answered.value;
}

function* historyOf(runId: string): Operation<readonly WorkflowHistoryEntry[]> {
  const answered = yield* history(runId);
  if (!answered.ok) {
    throw answered.error;
  }
  return answered.value;
}

describe("Tier WLI — immutable lifecycle inspection", () => {
  it("WLI1: one snapshot describes the record, executions, frontier and root together", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");

    yield* withLifecycle(root, function* () {
      const snapshot = yield* snapshotOf("release-1.4");
      const entries = yield* historyOf("release-1.4");

      expect(snapshot.record.runId).toBe("release-1.4");
      expect(snapshot.record.status).toBe("completed");
      expect(snapshot.record.props).toEqual({ channel: "stable" });
      expect(snapshot.record.definition.rootDocumentPath).toBe("workflows/release.md");
      expect(snapshot.executions).toHaveLength(1);
      expect(snapshot.executions[0]?.stopStatus).toBe("completed");
      expect(snapshot.currentWorkspaceRootId).toBe(EMPTY_WORKSPACE_ROOT_ID);

      // The frontier is the last event this same reading returned, not whatever
      // a second reading would have found.
      const last = entries[entries.length - 1];
      expect(snapshot.journalFrontier?.eventId).toBe(last?.eventId);
      expect(snapshot.journalFrontier?.workspaceRootId).toBe(last?.workspaceRootId);
    });
  });

  it("WLI2: an absent run is reported and no database is created", function* () {
    const root = yield* useStorageRoot();

    yield* withLifecycle(root, function* () {
      const answered = yield* inspect("never-started");
      expect(answered.ok).toBe(false);
      expect(answered.ok ? undefined : answered.error).toBeInstanceOf(WorkflowRunNotFoundError);

      const listed = yield* list();
      expect(listed.ok).toBe(true);
      expect(listed.ok ? listed.value : undefined).toEqual([]);
    });
  });

  it("WLI3: status, list and history change no byte, row or mode", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");
    const path = runPath(root, "release-1.4");
    const before = yield* fingerprint(path);

    yield* withLifecycle(root, function* () {
      yield* snapshotOf("release-1.4");
      yield* list();
      yield* historyOf("release-1.4");
    });

    expect(yield* fingerprint(path)).toEqual(before);
  });

  it("WLI4: list orders newest update first and reads only the run namespace", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "older");
    yield* retainedRun(root, "newer");
    // Names outside the hashed `.sqlite` namespace are the provider's own
    // arrangement, and a lifecycle sidecar is never a database candidate.
    yield* writeTextFile(join(root, "lifecycle.lock"), "");
    yield* writeTextFile(join(root, `${"b".repeat(64)}.lock`), "");

    yield* withLifecycle(root, function* () {
      const listed = yield* list();
      if (!listed.ok) {
        throw listed.error;
      }
      expect(listed.value.map((snapshot) => snapshot.record.runId)).toEqual(["newer", "older"]);
    });
  });

  it("WLI5: one validly named foreign candidate fails the whole list", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");
    // Named exactly the way a run is named, and holding something else.
    const candidate = join(root, `${"a".repeat(64)}.sqlite`);
    yield* writeTextFile(candidate, "not a workflow run database");
    const foreign = yield* fileFingerprint(candidate);

    yield* withLifecycle(root, function* () {
      const listed = yield* list();
      expect(listed.ok).toBe(false);
      expect(listed.ok ? undefined : listed.error).toBeInstanceOf(WorkflowDatabaseFormatError);
    });

    // Reported, and left exactly as it was found.
    expect(yield* fileFingerprint(candidate)).toEqual(foreign);
  });

  it("WLI5b: a healthy database at another run's name is not a second run", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");
    const original = runPath(root, "release-1.4");
    // A perfectly good version-1 workflow database, recognized in every
    // structural way, sitting where another run id would put it. Nothing about
    // its contents says so — only its name does.
    const copy = join(root, `${"a".repeat(64)}.sqlite`);
    yield* copyFile(original, copy);
    const before = {
      original: yield* fileFingerprint(original),
      copy: yield* fileFingerprint(copy),
    };

    yield* withLifecycle(root, function* () {
      const listed = yield* list();
      expect(listed.ok).toBe(false);
      const error = listed.ok ? undefined : listed.error;
      expect(error).toBeInstanceOf(WorkflowRunLocationMismatchError);
      // The same condition storage reports when a lookup lands on another run.
      expect(error).toBeInstanceOf(WorkflowRunIdMismatchError);
      // Not as a healthy list with a duplicate in it.
      expect(listed.ok ? listed.value : undefined).toBeUndefined();

      // The run itself still reads at its own location.
      const snapshot = yield* snapshotOf("release-1.4");
      expect(snapshot.record.runId).toBe("release-1.4");
    });

    expect(yield* fileFingerprint(original)).toEqual(before.original);
    expect(yield* fileFingerprint(copy)).toEqual(before.copy);
  });

  it("WLI5c: a retained id whose stored bytes no reader sees fails the whole list", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");
    // An id SQLite stores every byte of and every reader sees only the first
    // seven characters of: `length()` says 7 where the blob says 14, and
    // node:sqlite hands back the truncated string. Bound parameters truncate at
    // the NUL too, so the bytes go in as a blob cast to text.
    //
    // What refuses this is the location check, not the run-id rule: the reader
    // never sees a NUL, so what it compares is `release` against a file named
    // for `release\u0000shadow`. Removing the retained run-id parity leaves
    // this test passing, and removing the location check fails it — which is
    // why the parity is a contract rather than something this proves.
    const shadowed = `release\u0000shadow`;
    const original = runPath(root, "release-1.4");
    const candidate = runPath(root, shadowed);
    yield* copyFile(original, candidate);
    tamper(candidate, (database) => {
      database.exec(
        `UPDATE workflow_run SET run_id = CAST(x'${hex(shadowed)}' AS TEXT) WHERE id = 1`,
      );
    });
    const before = {
      original: yield* fileFingerprint(original),
      candidate: yield* fileFingerprint(candidate),
    };

    yield* withLifecycle(root, function* () {
      const listed = yield* list();
      // The whole request, not the healthy subset beside it.
      expect(listed.ok).toBe(false);
      expect(listed.ok ? listed.value : undefined).toBeUndefined();
      // What the file retains and what any reader can see disagree, so the id
      // that names this file is not the id read back out of it.
      expect(listed.ok ? undefined : listed.error).toBeInstanceOf(WorkflowRunIdMismatchError);

      const snapshot = yield* snapshotOf("release-1.4");
      expect(snapshot.record.runId).toBe("release-1.4");
    });

    expect(yield* fileFingerprint(original)).toEqual(before.original);
    expect(yield* fileFingerprint(candidate)).toEqual(before.candidate);
  });

  it("WLI6: history is every retained event with its exact id, root and source", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");
    const stored = storedEvents(runPath(root, "release-1.4"));

    yield* withLifecycle(root, function* () {
      const entries = yield* historyOf("release-1.4");

      expect(entries.map((entry) => entry.eventId)).toEqual(stored.map((row) => row.eventId));
      expect(entries.map((entry) => entry.event)).toEqual(stored.map((row) => row.event));
      expect(entries.map((entry) => entry.workspaceRootId)).toEqual(
        stored.map((row) => row.workspaceRootId),
      );

      // An authored operation exposes the position it was written with; a
      // trusted-host event and a Close expose nothing rather than a guess.
      expect(entries[0]?.source).toEqual({
        path: "workflows/release.md",
        offset: 12,
        line: 4,
        column: 2,
      });
      expect(entries[1]?.source).toBeUndefined();
      expect(entries[2]?.event.type).toBe("close");
      expect(entries[2]?.source).toBeUndefined();
    });
  });

  it("WLI7: a present source that does not parse makes the entry unreadable", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");
    const path = runPath(root, "release-1.4");
    const secret = "s3cret-position-value";
    tamper(path, (database) => {
      database.prepare("UPDATE journal_events SET record = ? WHERE sequence = 1").run(
        `${JSON.stringify({
          type: "yield",
          coroutineId: "root",
          description: {
            type: "import_component",
            name: "Release",
            [SOURCE_POSITION_FIELD]: secret,
          },
          result: { status: "ok", value: "done" },
        })}\n`,
      );
    });

    yield* withLifecycle(root, function* () {
      const answered = yield* history("release-1.4");
      expect(answered.ok).toBe(false);
      const error = answered.ok ? undefined : answered.error;
      expect(error).toBeInstanceOf(WorkflowRecordMalformedError);
      // The condition is named; what the field held is not.
      expect(error?.message).not.toContain(secret);
      // And it is not quietly reported as an entry without a source.
      const snapshot = yield* inspect("release-1.4");
      expect(snapshot.ok).toBe(true);
    });
  });

  it("WLI8: a partial run is inspected without reaching storage, Git or the journal", function* () {
    const root = yield* useStorageRoot();
    yield* partialRun(root, "release-1.4");
    const path = runPath(root, "release-1.4");
    const before = yield* fingerprint(path);
    const reached: string[] = [];

    yield* scoped(function* () {
      // What execution opens, and what establishing a definition asks. An
      // inspection that reached either records itself here rather than being
      // argued about; neither provider answers, so a call is also a failure.
      yield* WorkflowRunStorage.around({
        *create() {
          reached.push("storage.create");
          throw new Error("inspection opened a writable database");
        },
        *lookup() {
          reached.push("storage.lookup");
          throw new Error("inspection opened a writable database");
        },
      });
      yield* Git.around({
        *revParse() {
          reached.push("git.revParse");
          throw new Error("inspection consulted Git");
        },
        *repositoryRoot() {
          reached.push("git.repositoryRoot");
          throw new Error("inspection consulted Git");
        },
        *objectFormat() {
          reached.push("git.objectFormat");
          throw new Error("inspection consulted Git");
        },
        *readObject() {
          reached.push("git.readObject");
          throw new Error("inspection consulted Git");
        },
      });
      yield* useWorkflowLifecycle({ root });

      const snapshot = yield* snapshotOf("release-1.4");
      expect(snapshot.record.status).toBe("running");
      expect(snapshot.executions[0]?.stoppedAt).toBeUndefined();

      const entries = yield* historyOf("release-1.4");
      expect(entries).toHaveLength(2);
      expect(entries.some((entry) => entry.event.type === "close")).toBe(false);

      const listed = yield* list();
      expect(listed.ok).toBe(true);
    });

    expect(reached).toEqual([]);
    // No row appended, no byte moved, no mode changed.
    expect(yield* fingerprint(path)).toEqual(before);
  });
  it("WLI9: an id holding * or ? addresses exactly its own run", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-*");
    yield* retainedRun(root, "release-?");
    yield* retainedRun(root, "release-1");
    const reached: string[] = [];

    yield* scoped(function* () {
      yield* WorkflowRunStorage.around({
        *create() {
          reached.push("storage.create");
          throw new Error("inspection opened a writable database");
        },
        *lookup() {
          reached.push("storage.lookup");
          throw new Error("inspection opened a writable database");
        },
      });
      yield* Git.around({
        *revParse() {
          reached.push("git.revParse");
          throw new Error("inspection consulted Git");
        },
        *repositoryRoot() {
          reached.push("git.repositoryRoot");
          throw new Error("inspection consulted Git");
        },
        *objectFormat() {
          reached.push("git.objectFormat");
          throw new Error("inspection consulted Git");
        },
        *readObject() {
          reached.push("git.readObject");
          throw new Error("inspection consulted Git");
        },
      });
      yield* useWorkflowLifecycle({ root });

      // Every character is part of the id. The path a run lives at is the hash
      // of the whole string, so these address one run each and no pattern is
      // ever evaluated against the other two.
      expect((yield* snapshotOf("release-*")).record.runId).toBe("release-*");
      expect((yield* snapshotOf("release-?")).record.runId).toBe("release-?");
      expect((yield* snapshotOf("release-1")).record.runId).toBe("release-1");
      // History has to be attributable to the exact run, not merely the right
      // shape: three runs of one fixture have three histories that look alike.
      // The rows are read straight out of `release-*`'s own file, outside the
      // provider, and compared whole.
      const own = storedEvents(runPath(root, "release-*"));
      const wildcard = yield* historyOf("release-*");
      expect(wildcard.map((entry) => entry.eventId)).toEqual(own.map((row) => row.eventId));
      expect(wildcard.map((entry) => entry.event)).toEqual(own.map((row) => row.event));
      expect(wildcard.map((entry) => entry.workspaceRootId)).toEqual(
        own.map((row) => row.workspaceRootId),
      );

      // And it is not either neighbour's history. The event ids are assigned
      // per row and the events name their own run, so both tell these apart;
      // the Workspace roots do not, because three runs that never mutated a
      // Workspace share the one empty root, which is why they are compared
      // against the independent read rather than across runs.
      for (const neighbour of ["release-?", "release-1"]) {
        const other = storedEvents(runPath(root, neighbour));
        expect(own.map((row) => row.eventId)).not.toEqual(other.map((row) => row.eventId));
        expect(own.map((row) => row.event)).not.toEqual(other.map((row) => row.event));
        // Each neighbour reads back as itself on the same terms.
        const read = yield* historyOf(neighbour);
        expect(read.map((entry) => entry.eventId)).toEqual(other.map((row) => row.eventId));
        expect(read.map((entry) => entry.event)).toEqual(other.map((row) => row.event));
      }

      // An id that a pattern would have matched, and that nothing retains.
      const absent = yield* inspect("release-2");
      expect(absent.ok).toBe(false);
      expect(absent.ok ? undefined : absent.error).toBeInstanceOf(WorkflowRunNotFoundError);

      // All three are their own runs in the list, and none is a match for
      // another.
      const listed = yield* list();
      if (!listed.ok) {
        throw listed.error;
      }
      expect(listed.value.map((snapshot) => snapshot.record.runId).sort()).toEqual([
        "release-*",
        "release-1",
        "release-?",
      ]);
    });

    expect(reached).toEqual([]);
  });
});

/** The rows a run's journal actually holds, read outside the provider. */
function storedEvents(
  path: string,
): { eventId: string; event: DurableEvent; workspaceRootId: string }[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT event_id, record, workspace_root_id FROM journal_events ORDER BY sequence")
      .all()
      .map((row) => ({
        eventId: String(row["event_id"]),
        event: JSON.parse(String(row["record"])),
        workspaceRootId: String(row["workspace_root_id"]),
      }));
  } finally {
    database.close();
  }
}

/** A string's UTF-8 bytes as SQLite's blob literals spell them. */
function hex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

function* fileFingerprint(path: string): Operation<string> {
  const bytes = yield* until(readFile(path));
  return `${bytes.toString("base64")}:${(yield* stat(path)).mode}`;
}

/**
 * Tier WLI — inspecting a run a lost host left mid-transaction (issue #513).
 *
 * The condition is physical and cannot be simulated: a rollback journal exists
 * only between the moment SQLite starts writing pages and the moment it
 * commits, and every in-process way of ending work commits or rolls back. So a
 * real child process opens the real database, changes committed rows inside one
 * immediate transaction, and is killed where it stands.
 *
 * What inspection then has to do is read that run without becoming its owner.
 * Recovery belongs to the next write-capable connection, and these suites hold
 * inspection to leaving that job — and every byte of the pair it is about —
 * exactly where it found it.
 */

const RECOVERY_CHILD = fileURLToPath(
  new URL("./support/workflow-recovery-child.ts", import.meta.url),
);
const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));

/** `SQLITE_READONLY_ROLLBACK`, as an independent reader meets it. */
const READONLY_ROLLBACK = 776;

/** A live child process, and whatever it has announced so far. */
interface RecoveryChild {
  readonly pid: number;
  announced(): boolean;
}

function useRecoveryChild(mode: "hot" | "open", path: string): Operation<RecoveryChild> {
  return resource<RecoveryChild>(function* (provide) {
    const child = yield* exec(process.execPath, {
      arguments: ["run", "--allow-all", "--frozen", RECOVERY_CHILD, mode, path],
      cwd: REPOSITORY,
    });
    let announced = false;
    yield* spawn(function* () {
      const output = yield* child.stdout;
      let next = yield* output.next();
      while (!next.done) {
        if (new TextDecoder().decode(next.value).includes("READY")) {
          announced = true;
        }
        next = yield* output.next();
      }
    });
    // Killed rather than asked: this child exists to be lost, and a mode that
    // is still waiting has no other way to end.
    yield* ensure(function* () {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the outcome this wanted.
      }
      yield* child.join();
    });
    yield* provide({ pid: child.pid, announced: () => announced });
  });
}

/**
 * Leave this run's database beside a rollback journal nobody will put back.
 *
 * The child is killed once it says it has spilled pages inside an open
 * transaction, so what remains is a healthy database one rollback away from its
 * last committed state — the exact condition a read-only connection cannot get
 * past.
 */
function* leaveHot(root: string, runId: string): Operation<void> {
  const path = runPath(root, runId);
  yield* scoped(function* () {
    const child = yield* useRecoveryChild("hot", path);
    yield* when(
      function* () {
        expect(child.announced()).toBe(true);
      },
      { timeout: 30_000 },
    );
    process.kill(child.pid, "SIGKILL");
  });
  expect(directCode(path)).toBe(READONLY_ROLLBACK);
}

/** Where a run keeps the journal that says what to put back. */
function journalOf(database: string): string {
  return `${database}-journal`;
}

/** The SQLite extended code an independent read-only reader meets, if any. */
function directCode(path: string): number | undefined {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
    return undefined;
  } catch (error) {
    if (error instanceof Error && "errcode" in error && typeof error.errcode === "number") {
      return error.errcode;
    }
    return undefined;
  } finally {
    database.close();
  }
}

/** Let a write-capable owner do what recovery is actually its job. */
function recoverInPlace(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
  } finally {
    database.close();
  }
}

/** Everything about the retained pair that inspection may not change. */
interface PairPrint {
  readonly database: string;
  readonly journal: string;
}

function* pairPrint(path: string): Operation<PairPrint> {
  const journal = `${path}-journal`;
  return {
    database: yield* fileFingerprint(path),
    journal: (yield* exists(journal)) ? yield* fileFingerprint(journal) : "absent",
  };
}

/** What recovered inspection did, in the order it did it. */
interface Recorder {
  readonly phases: RecoveryPhase[];
  readonly directories: string[];
  /** The highest number of scratch directories alive at any one moment. */
  concurrent(): number;
  observe: RecoveryObserver;
}

function recorder(
  pause: Partial<Record<RecoveryPhase, (directory: string) => Operation<void>>> = {},
): Recorder {
  const phases: RecoveryPhase[] = [];
  const directories: string[] = [];
  let live = 0;
  let peak = 0;
  return {
    phases,
    directories,
    concurrent: () => peak,
    *observe(observation) {
      phases.push(observation.phase);
      if (observation.phase === "scratch-created") {
        directories.push(observation.directory);
        live += 1;
        peak = Math.max(peak, live);
      }
      if (observation.phase === "before-cleanup") {
        live -= 1;
      }
      yield* (pause[observation.phase] ?? noPause)(observation.directory);
    },
  };
}

// deno-lint-ignore require-yield
function* noPause(_directory: string): Operation<void> {
  return undefined;
}

/** Read a run through a lifecycle installation a test can watch. */
function withObserved<T>(
  root: string,
  observe: RecoveryObserver,
  body: () => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const connections = yield* useWorkflowRunConnections();
    yield* installWorkflowLifecycle({ root }, connections, observe);
    return yield* body();
  });
}

describe("Tier WLI — inspecting a crashed run", () => {
  it("WLI10: a hot run reports its last committed state, and stays hot", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "hot-1");
    const path = runPath(root, "hot-1");

    // What the run committed, read while it is still readable.
    const committed = yield* withLifecycle(root, function* () {
      return { snapshot: yield* snapshotOf("hot-1"), history: yield* historyOf("hot-1") };
    });
    expect(committed.snapshot.record.status).toBe("completed");

    yield* leaveHot(root, "hot-1");
    const before = yield* pairPrint(path);
    expect(before.journal).not.toBe("absent");

    const watched = recorder();
    const read = yield* withObserved(root, watched.observe, function* () {
      const snapshot = yield* snapshotOf("hot-1");
      // Checked after this reading and again after the next, rather than once
      // at the end: a pair that survives two inspections together would hide
      // one of them having changed it and the other having changed it back.
      expect(yield* pairPrint(path)).toEqual(before);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);

      const entries = yield* historyOf("hot-1");
      expect(yield* pairPrint(path)).toEqual(before);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);
      return { snapshot, history: entries };
    });

    // The killed transaction changed the record and deleted and inserted
    // events. None of it is here: this is the state the run committed.
    expect(read.snapshot).toEqual(committed.snapshot);
    expect(read.history).toEqual(committed.history);
    expect(watched.phases).toEqual([
      "scratch-created",
      "source-pair-copied",
      "scratch-recovered",
      "before-cleanup",
      "scratch-created",
      "source-pair-copied",
      "scratch-recovered",
      "before-cleanup",
    ]);

    // The retained pair is byte-for-byte what the crash left, and still hot:
    // recovering it is the next write-capable owner's job, not inspection's.
    expect(yield* pairPrint(path)).toEqual(before);
    expect(directCode(path)).toBe(READONLY_ROLLBACK);
    for (const directory of watched.directories) {
      expect(yield* exists(directory)).toBe(false);
    }
  });

  it("WLI11: list answers a healthy run and a hot one together, one copy at a time", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "healthy-1");
    yield* retainedRun(root, "hot-2");
    yield* retainedRun(root, "hot-3");

    // The order these are answered in while every one of them is readable.
    const ordered = yield* withLifecycle(root, function* () {
      const clean = yield* list();
      if (!clean.ok) {
        throw clean.error;
      }
      return clean.value.map((entry) => entry.record.runId);
    });
    expect(ordered).toHaveLength(3);

    yield* leaveHot(root, "hot-2");
    yield* leaveHot(root, "hot-3");

    const watched = recorder();
    const listed = yield* withObserved(root, watched.observe, function* () {
      const answered = yield* list();
      if (!answered.ok) {
        throw answered.error;
      }
      return answered.value;
    });

    // Same runs in the same order: recovering two of them changed neither what
    // the list holds nor the sequence it holds them in.
    expect(listed.map((entry) => entry.record.runId)).toEqual(ordered);
    // And that sequence is still the rule rather than the order the files
    // happened to be enumerated in: newest update first, run id breaking ties.
    expect(listed.map((entry) => entry.record.runId)).toEqual(
      [...listed]
        .sort((left, right) =>
          left.record.updatedAt === right.record.updatedAt
            ? left.record.runId < right.record.runId
              ? -1
              : 1
            : left.record.updatedAt < right.record.updatedAt
              ? 1
              : -1,
        )
        .map((entry) => entry.record.runId),
    );
    // Two candidates were recovered, and never both at once.
    expect(watched.directories).toHaveLength(2);
    expect(watched.concurrent()).toBe(1);
  });

  it("WLI12: a copy is taken before any owner may recover, and a recovered source is read as itself", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "race-1");
    yield* leaveHot(root, "race-1");
    const path = runPath(root, "race-1");

    // Paused holding coordination, with the pair already copied. A real owner
    // opening the same database through the production registry cannot finish
    // its first read until this releases.
    const release = withResolvers<void>();
    const copied = withResolvers<void>();
    const watched = recorder({
      *"source-pair-copied"(_directory) {
        copied.resolve();
        yield* release.operation;
      },
    });

    yield* scoped(function* () {
      const inspecting = yield* spawn(() =>
        withObserved(root, watched.observe, () => snapshotOf("race-1")),
      );
      yield* copied.operation;

      const owner = yield* useRecoveryChild("open", path);
      yield* sleep(1_000);
      // Still hot, still untouched: the owner is waiting on the sidecar.
      expect(owner.announced()).toBe(false);
      expect(yield* exists(`${path}-journal`)).toBe(true);

      release.resolve();
      const snapshot = yield* inspecting;
      expect(snapshot.record.runId).toBe("race-1");

      // Released, the owner finishes its read and recovers the source itself.
      yield* when(
        function* () {
          expect(owner.announced()).toBe(true);
        },
        { timeout: 30_000 },
      );
      expect(yield* exists(`${path}-journal`)).toBe(false);
    });

    // Recovered by its owner, the run is ordinary again: inspection reads it
    // directly and copies nothing.
    const after = recorder();
    const plain = yield* withObserved(root, after.observe, () => snapshotOf("race-1"));
    expect(plain.record.runId).toBe("race-1");
    expect(after.phases).toEqual([]);

    // The other way round: an owner holds coordination and recovers the source
    // while inspection is already waiting for it. The coordinated retry reads
    // the run as itself, so nothing is ever copied.
    yield* retainedRun(root, "race-2");
    yield* leaveHot(root, "race-2");
    const second = recorder();
    const holding = withResolvers<void>();
    const owned = withResolvers<void>();
    yield* scoped(function* () {
      yield* spawn(function* () {
        yield* scoped(function* () {
          yield* holdRecoveryCoordination(runPath(root, "race-2"));
          holding.resolve();
          yield* owned.operation;
          recoverInPlace(runPath(root, "race-2"));
        });
      });
      yield* holding.operation;

      const waiting = yield* spawn(() =>
        withObserved(root, second.observe, () => snapshotOf("race-2")),
      );
      yield* sleep(500);
      // Its direct read has already refused; it is waiting on the sidecar.
      expect(second.phases).toEqual([]);

      owned.resolve();
      const snapshot = yield* waiting;
      expect(snapshot.record.runId).toBe("race-2");
    });
    expect(second.phases).toEqual([]);
  });

  it("WLI13: damage a copy reveals keeps its own refusal, naming the source", function* () {
    // Planted, committed, and only then crashed — so each condition is one the
    // run genuinely retains and recovery has to put back rather than discard.
    // What each refusal is, is not asserted by name here: it is read once while
    // the candidate is still readable and compared with what recovery answers,
    // which is the actual claim — recovery changes no recognition outcome.
    const secret = "props-nobody-should-see";
    const damages: Array<{
      readonly runId: string;
      readonly what: string;
      damage(root: string, path: string): Operation<void>;
    }> = [
      {
        runId: "shape-1",
        what: "an object nobody declared",
        *damage(_root, path) {
          tamper(path, (database) => {
            database.exec("CREATE TABLE nobody_declared (value TEXT)");
          });
          yield* noPause(path);
        },
      },
      {
        runId: "identity-1",
        what: "a healthy run under another run's name",
        *damage(root, path) {
          yield* copyFile(runPath(root, "healthy-source"), path);
        },
      },
      {
        runId: "content-1",
        what: "a retained row that does not describe what its column claims",
        *damage(_root, path) {
          // A column SQLite is satisfied by and a reader is not: the text is
          // there, and it is not the timestamp the record says it holds.
          tamper(path, (database) => {
            database
              .prepare("UPDATE workflow_run SET updated_at = ? WHERE id = 1")
              .run(`not-a-timestamp-${secret}`);
          });
          yield* noPause(path);
        },
      },
      {
        runId: "workspace-1",
        what: "a current Workspace root the run does not retain",
        *damage(_root, path) {
          tamper(path, (database) => {
            // Planted the way a lost or mis-copied root would leave it, which
            // no constraint can be relied on to have prevented.
            database.exec("PRAGMA foreign_keys = OFF");
            database
              .prepare("UPDATE workspace_state SET current_root_id = ? WHERE singleton_id = 1")
              .run("f".repeat(64));
          });
          yield* noPause(path);
        },
      },
    ];

    for (const planted of damages) {
      const root = yield* useStorageRoot();
      yield* retainedRun(root, "healthy-source");
      yield* retainedRun(root, planted.runId);
      const path = runPath(root, planted.runId);
      yield* planted.damage(root, path);

      // The refusal this damage already produces, while it is still readable.
      const direct = yield* withLifecycle(root, () => list());
      expect(direct.ok).toBe(false);
      if (direct.ok) {
        throw new Error(`${planted.what} was listed`);
      }
      const expected = direct.error;

      yield* leaveHot(root, planted.runId);
      const before = yield* pairPrint(path);

      const watched = recorder();
      const answered = yield* withObserved(root, watched.observe, () => list());

      expect(answered.ok).toBe(false);
      if (answered.ok) {
        throw new Error(`${planted.what} was listed after recovery`);
      }
      // The same condition, worded the same way, about the same file: what the
      // copy revealed is the run's own state and is reported as such.
      expect(answered.error.constructor).toBe(expected.constructor);
      expect(answered.error.name).toBe(expected.name);
      expect(answered.error.message).toBe(expected.message);
      expect(answered.error).not.toBeInstanceOf(WorkflowInspectionRecoveryError);
      // A refusal that names a file names the run's own. One that names a
      // retained location instead has no path to get wrong.
      if (expected.message.includes(path)) {
        expect(answered.error.message).toContain(path);
      }
      expect(answered.error.message).not.toContain(secret);
      expect(answered.error.cause).toBeUndefined();

      // Recovery happened, left nothing behind, and named none of it.
      expect(watched.directories.length).toBeGreaterThan(0);
      for (const directory of watched.directories) {
        expect(answered.error.message).not.toContain(directory);
        expect(yield* exists(directory)).toBe(false);
      }
      // A failed list is not a shorter one, and the candidate is untouched.
      expect(Object.hasOwn(answered, "value")).toBe(false);
      expect(yield* pairPrint(path)).toEqual(before);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);
    }
  });

  it("WLI14: only the exact rollback code enters recovery", function* () {
    const sqlite = (errcode: number): Error => {
      const error = new Error("attempt to write a readonly database");
      return Object.assign(error, { code: "ERR_SQLITE_ERROR", errcode });
    };

    expect(translateSqliteError(sqlite(776), "/runs/a.sqlite")).toBeInstanceOf(
      WorkflowReadonlyRollbackError,
    );
    // The primary readonly code and every other extended readonly condition —
    // including the ones carrying the identical message — are somebody else's
    // problem and pass through as themselves.
    for (const errcode of [8, 264, 520, 1032, 1288, 1544]) {
      expect(translateSqliteError(sqlite(errcode), "/runs/a.sqlite")).not.toBeInstanceOf(
        WorkflowReadonlyRollbackError,
      );
    }
  });

  it("WLI15: a recovery that cannot finish is refused, and says what it left", function* () {
    // Failures that clean up after themselves. Each is a real fault in a real
    // place — a lock that cannot be opened, a directory that is gone, a copy
    // that is not a database — rather than an injected error object.
    const cleaned: Array<{
      readonly what: string;
      pause(path: string): Partial<Record<RecoveryPhase, (directory: string) => Operation<void>>>;
      arrange(path: string): Operation<void>;
    }> = [
      {
        what: "the coordination sidecar cannot be opened",
        pause: () => ({}),
        *arrange(path) {
          // A directory where the lock file goes: the open fails, and nothing
          // downstream of it ever runs. The run host that created this run left
          // its own empty sidecar here, which goes first.
          yield* rm(`${path}.recovery.lock`, { force: true });
          yield* ensureDir(`${path}.recovery.lock`);
        },
      },
      {
        what: "the scratch directory is gone before the copy",
        pause: () => ({
          *"scratch-created"(directory) {
            yield* rm(directory, { recursive: true });
          },
        }),
        *arrange(path) {
          yield* noPause(path);
        },
      },
      {
        what: "the copied database cannot be recovered",
        pause: (path) => ({
          *"source-pair-copied"(directory) {
            yield* writeTextFile(join(directory, basename(path)), "not a database at all");
          },
        }),
        *arrange(path) {
          yield* noPause(path);
        },
      },
    ];

    for (const fault of cleaned) {
      const root = yield* useStorageRoot();
      yield* retainedRun(root, "fault-1");
      const path = runPath(root, "fault-1");
      yield* leaveHot(root, "fault-1");
      const before = yield* pairPrint(path);
      yield* fault.arrange(path);

      const watched = recorder(fault.pause(path));
      const answered = yield* withObserved(root, watched.observe, () => inspect("fault-1"));

      expect(answered.ok).toBe(false);
      if (answered.ok) {
        throw new Error(`${fault.what} produced a snapshot`);
      }
      const failure = answered.error;
      expect(failure).toBeInstanceOf(WorkflowInspectionRecoveryError);
      if (!(failure instanceof WorkflowInspectionRecoveryError)) {
        throw failure;
      }
      expect(failure.path).toBe(path);
      // Cleanup succeeded, so there is nothing for an operator to remove and
      // nothing to name.
      expect(failure.scratchPath).toBeUndefined();
      expect(failure.cause).toBeUndefined();
      // The condition, not SQLite's words for it and not anything retained.
      expect(failure.message).not.toContain("SQLITE");
      expect(failure.message).not.toContain("readonly");
      for (const directory of watched.directories) {
        expect(yield* exists(directory)).toBe(false);
        expect(failure.message).not.toContain(directory);
      }

      // The same fault fails a list whole rather than shortening it.
      const listed = yield* withObserved(root, recorder(fault.pause(path)).observe, () => list());
      expect(listed.ok).toBe(false);
      expect(Object.hasOwn(listed, "value")).toBe(false);

      expect(yield* pairPrint(path)).toEqual(before);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);
    }

    // Cancellation is control flow. The copy still goes, and there is no
    // `Result` to return because nobody is waiting for one.
    {
      const root = yield* useStorageRoot();
      yield* retainedRun(root, "cancel-1");
      const path = runPath(root, "cancel-1");
      yield* leaveHot(root, "cancel-1");
      const before = yield* pairPrint(path);

      const copied = withResolvers<void>();
      const held = withResolvers<void>();
      const watched = recorder({
        *"source-pair-copied"(_directory) {
          copied.resolve();
          yield* held.operation;
        },
      });

      yield* scoped(function* () {
        const inspecting = yield* spawn(() =>
          withObserved(root, watched.observe, () => inspect("cancel-1")),
        );
        yield* copied.operation;
        yield* inspecting.halt();
      });

      expect(watched.phases).toContain("before-cleanup");
      expect(watched.directories.length).toBeGreaterThan(0);
      for (const directory of watched.directories) {
        expect(yield* exists(directory)).toBe(false);
      }
      expect(yield* pairPrint(path)).toEqual(before);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);
    }

    // A removal that cannot happen is the authoritative outcome, whichever way
    // the operation was ending.
    for (const cancelled of [false, true]) {
      const root = yield* useStorageRoot();
      const runId = cancelled ? "residue-2" : "residue-1";
      yield* retainedRun(root, runId);
      const path = runPath(root, runId);
      yield* leaveHot(root, runId);
      const before = yield* pairPrint(path);

      const copied = withResolvers<void>();
      const held = withResolvers<void>();
      const watched = recorder({
        *"source-pair-copied"(_directory) {
          if (cancelled) {
            copied.resolve();
            yield* held.operation;
          }
        },
        *"before-cleanup"(directory) {
          // A real refusal: the directory is made unwritable underneath the
          // removal, so teardown meets a filesystem that says no.
          yield* until(chmod(directory, 0o500));
        },
      });

      let raised: unknown;
      if (cancelled) {
        yield* scoped(function* () {
          const inspecting = yield* spawn(() =>
            withObserved(root, watched.observe, () => inspect(runId)),
          );
          yield* copied.operation;
          try {
            yield* inspecting.halt();
          } catch (error) {
            // A cancelled operation cannot answer with a `Result`, so the
            // failure its teardown found arrives here instead.
            raised = error;
          }
        });
      } else {
        const answered = yield* withObserved(root, watched.observe, () => inspect(runId));
        expect(answered.ok).toBe(false);
        raised = answered.ok ? undefined : answered.error;
      }

      expect(raised).toBeInstanceOf(WorkflowInspectionRecoveryError);
      if (!(raised instanceof WorkflowInspectionRecoveryError)) {
        throw raised;
      }
      expect(raised.path).toBe(path);
      expect(raised.scratchPath).toBe(watched.directories[0]);
      expect(raised.message).toContain(String(raised.scratchPath));
      expect(raised.cause).toBeUndefined();

      // The residue it named is really there, and the run is untouched.
      expect(yield* exists(String(raised.scratchPath))).toBe(true);
      expect(yield* pairPrint(path)).toEqual(before);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);

      yield* until(chmod(String(raised.scratchPath), 0o700));
      yield* rm(String(raised.scratchPath), { recursive: true });
    }

    // Cancellation that begins after the answer exists, while the removal is
    // suspended. "An answer was computed" is not the same question as "this
    // call can still deliver one", and a cleanup refusal found here has no
    // receiver either: it has to be raised.
    {
      const root = yield* useStorageRoot();
      yield* retainedRun(root, "residue-3");
      const path = runPath(root, "residue-3");
      yield* leaveHot(root, "residue-3");
      const before = yield* pairPrint(path);

      const suspended = withResolvers<void>();
      const held = withResolvers<void>();
      let pauses = 0;
      const watched = recorder({
        *"before-cleanup"(directory) {
          // Unwritable from the first pass on, so the removal genuinely cannot
          // happen whichever pass reaches it.
          yield* until(chmod(directory, 0o500));
          pauses += 1;
          if (pauses === 1) {
            // Reached only after the snapshot exists: this is the operation's
            // own removal, not the teardown net.
            suspended.resolve();
            yield* held.operation;
          }
        },
      });

      let raised: unknown;
      yield* scoped(function* () {
        const inspecting = yield* spawn(() =>
          withObserved(root, watched.observe, () => inspect("residue-3")),
        );
        yield* suspended.operation;
        try {
          yield* inspecting.halt();
        } catch (error) {
          raised = error;
        }
      });

      expect(raised).toBeInstanceOf(WorkflowInspectionRecoveryError);
      if (!(raised instanceof WorkflowInspectionRecoveryError)) {
        throw raised;
      }
      expect(raised.path).toBe(path);
      expect(raised.scratchPath).toBe(watched.directories[0]);
      expect(raised.message).toContain(String(raised.scratchPath));
      expect(yield* exists(String(raised.scratchPath))).toBe(true);
      expect(yield* pairPrint(path)).toEqual(before);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);

      yield* until(chmod(String(raised.scratchPath), 0o700));
      yield* rm(String(raised.scratchPath), { recursive: true });
    }
  });

  it("WLI17: a connection that is already open owns the pair until it closes", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "cached-1");
    const path = runPath(root, "cached-1");

    yield* scoped(function* () {
      // A write-capable connection this host opened while the run was healthy,
      // and has not read through since. Its opening recovered nothing, because
      // there was nothing to recover yet.
      const connections = yield* useWorkflowRunConnections();
      const cached = yield* connections.at(path);
      expect(cached.path).toBe(path);

      // Now another process crashes underneath it. The rollback journal is
      // there, and the next read through this connection — whenever some
      // unrelated caller happens to make one — is what would put it back.
      yield* leaveHot(root, "cached-1");
      expect(yield* exists(journalOf(path))).toBe(true);

      const watched = recorder();
      const inspecting = yield* spawn(() =>
        withObserved(root, watched.observe, () => inspect("cached-1")),
      );
      yield* sleep(1_000);

      // So inspection may not copy the pair. It is waiting, it has created no
      // scratch, and the journal it would have copied is still exactly there.
      expect(watched.phases).toEqual([]);
      expect(yield* exists(journalOf(path))).toBe(true);
      expect(directCode(path)).toBe(READONLY_ROLLBACK);

      // Closing the connection is what hands the pair over.
      connections.close(path);
      const answered = yield* inspecting;
      expect(answered.ok).toBe(true);
      if (!answered.ok) {
        throw answered.error;
      }
      expect(answered.value.record.runId).toBe("cached-1");
      // It recovered a copy, and the retained pair is still the crash's.
      expect(watched.phases).toContain("source-pair-copied");
      expect(directCode(path)).toBe(READONLY_ROLLBACK);
    });
  });

  it("WLI16: the clean path costs nothing, and the hot one takes no authority", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "clean-1");
    const path = runPath(root, "clean-1");

    // The run host that created it has closed, so the empty sidecar its
    // write-capable opening took is removed here: what this proves is that
    // inspection does not create one.
    yield* rm(`${path}.recovery.lock`, { force: true });
    const before = yield* fileFingerprint(path);

    const watched = recorder();
    const snapshot = yield* withObserved(root, watched.observe, () => snapshotOf("clean-1"));

    expect(snapshot.record.runId).toBe("clean-1");
    expect(watched.phases).toEqual([]);
    expect(watched.directories).toEqual([]);
    expect(yield* exists(`${path}.recovery.lock`)).toBe(false);
    expect(yield* fileFingerprint(path)).toBe(before);

    // Recovering a crashed run buys inspection nothing it did not already
    // have. The same probes WLI8 holds the clean path to, against a run that
    // does take the recovery path.
    yield* retainedRun(root, "hot-16");
    yield* leaveHot(root, "hot-16");
    const hot = runPath(root, "hot-16");
    // The executor that created this run left its own sidecar, which goes
    // first: what is proven below is that inspection does not take one.
    const executorSidecar = `${hot.slice(0, -".sqlite".length)}.lock`;
    yield* rm(executorSidecar, { force: true });
    const hotBefore = yield* pairPrint(hot);
    const reached: string[] = [];

    const hotWatched = recorder();
    yield* scoped(function* () {
      yield* WorkflowRunStorage.around({
        *create() {
          reached.push("storage.create");
          throw new Error("recovered inspection opened a writable database");
        },
        *lookup() {
          reached.push("storage.lookup");
          throw new Error("recovered inspection opened a writable database");
        },
      });
      yield* Git.around({
        *revParse() {
          reached.push("git.revParse");
          throw new Error("recovered inspection consulted Git");
        },
        *repositoryRoot() {
          reached.push("git.repositoryRoot");
          throw new Error("recovered inspection consulted Git");
        },
        *objectFormat() {
          reached.push("git.objectFormat");
          throw new Error("recovered inspection consulted Git");
        },
        *readObject() {
          reached.push("git.readObject");
          throw new Error("recovered inspection consulted Git");
        },
      });

      const connections = yield* useWorkflowRunConnections();
      const transitions = yield* installWorkflowLifecycle(
        { root },
        connections,
        hotWatched.observe,
      );
      // Handed back rather than installed, so a transition is something a
      // caller performs. Inspection never receives this object at all; that it
      // is untouched afterwards is what the execution counts below show.
      expect(typeof transitions.begin).toBe("function");

      const recovered = yield* snapshotOf("hot-16");
      expect(recovered.record.runId).toBe("hot-16");
      const entries = yield* historyOf("hot-16");
      expect(entries.length).toBeGreaterThan(0);
      const listed = yield* list();
      expect(listed.ok).toBe(true);

      // Coordination hands back nothing at all — least of all anything a
      // transition would accept as an executor lock.
      const granted = yield* holdRecoveryCoordination(hot);
      expect(granted).toBeUndefined();
    });

    // It recovered, and it reached none of them.
    expect(hotWatched.directories.length).toBeGreaterThan(0);
    expect(reached).toEqual([]);
    // No executor sidecar: inspection never asked to advance the run.
    expect(yield* exists(executorSidecar)).toBe(false);
    // Byte-for-byte what the crash left, which is a stronger claim than any
    // row count: no execution was begun or settled, nothing was appended, no
    // status was published, and no replay wrote anything.
    expect(yield* pairPrint(hot)).toEqual(hotBefore);
    expect(directCode(hot)).toBe(READONLY_ROLLBACK);
  });
});
