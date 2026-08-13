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

import { copyFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { writeTextFile } from "@effectionx/fs";
import type { Close, DurableEvent, Yield } from "@executablemd/durable-streams";
import { SOURCE_POSITION_FIELD } from "@executablemd/core";
import {
  Git,
  WorkflowDatabaseFormatError,
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
import { EMPTY_WORKSPACE_ROOT_ID } from "../src/deno/workspace/manifest.ts";
import {
  creation,
  leasedRun,
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
  yield* withRunHost(root, function* (authority) {
    yield* leasedRun(
      authority,
      { runId, action: "start", creation: creation() },
      function* (begun, lease) {
        yield* begun.database.journal.append(
          sourced("import_component", `Release:${runId}`, { line: 4, column: 2 }),
        );
        yield* begun.database.journal.append(unsourced("exec", `exec:echo ${runId}`));
        yield* begun.database.journal.append(closed("root"));
        const settled = yield* authority.settle(lease, {
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
  yield* withRunHost(root, function* (authority) {
    yield* leasedRun(
      authority,
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

function fingerprint(path: string): Fingerprint {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = [
      ...database.prepare("SELECT * FROM workflow_run").all(),
      ...database.prepare("SELECT event_id, record, workspace_root_id FROM journal_events").all(),
      ...database.prepare("SELECT * FROM document_executions").all(),
      ...database.prepare("SELECT * FROM workspace_state").all(),
    ];
    return {
      bytes: readFileSync(path).toString("base64"),
      mode: statSync(path).mode,
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
    const before = fingerprint(path);

    yield* withLifecycle(root, function* () {
      yield* snapshotOf("release-1.4");
      yield* list();
      yield* historyOf("release-1.4");
    });

    expect(fingerprint(path)).toEqual(before);
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
    const foreign = fileFingerprint(candidate);

    yield* withLifecycle(root, function* () {
      const listed = yield* list();
      expect(listed.ok).toBe(false);
      expect(listed.ok ? undefined : listed.error).toBeInstanceOf(WorkflowDatabaseFormatError);
    });

    // Reported, and left exactly as it was found.
    expect(fileFingerprint(candidate)).toEqual(foreign);
  });

  it("WLI5b: a healthy database at another run's name is not a second run", function* () {
    const root = yield* useStorageRoot();
    yield* retainedRun(root, "release-1.4");
    const original = runPath(root, "release-1.4");
    // A perfectly good version-1 workflow database, recognized in every
    // structural way, sitting where another run id would put it. Nothing about
    // its contents says so — only its name does.
    const copy = join(root, `${"a".repeat(64)}.sqlite`);
    copyFileSync(original, copy);
    const before = { original: fileFingerprint(original), copy: fileFingerprint(copy) };

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

    expect(fileFingerprint(original)).toEqual(before.original);
    expect(fileFingerprint(copy)).toEqual(before.copy);
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
    copyFileSync(original, candidate);
    tamper(candidate, (database) => {
      database.exec(
        `UPDATE workflow_run SET run_id = CAST(x'${hex(shadowed)}' AS TEXT) WHERE id = 1`,
      );
    });
    const before = { original: fileFingerprint(original), candidate: fileFingerprint(candidate) };

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

    expect(fileFingerprint(original)).toEqual(before.original);
    expect(fileFingerprint(candidate)).toEqual(before.candidate);
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
    const before = fingerprint(path);
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
    expect(fingerprint(path)).toEqual(before);
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

function fileFingerprint(path: string): string {
  return `${readFileSync(path).toString("base64")}:${statSync(path).mode}`;
}
