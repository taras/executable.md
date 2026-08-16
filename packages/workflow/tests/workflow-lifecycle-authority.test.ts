/**
 * Tier WLA — who may advance a run.
 *
 * The subject is an operating-system lock, so these tests take it for real and,
 * where exclusion across processes is the claim, from a real second process.
 * An in-process stand-in would prove that this module agrees with itself.
 *
 * The lock's whole value is that the workflow executor cannot retain it beyond
 * its scope. Every test that acquires one also says what happens after that
 * scope ends, because "the lock was taken" and "the lock was released" are
 * different facts and only the pair is worth anything.
 */

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec } from "@effectionx/process";
import process from "node:process";
import { exists, writeTextFile } from "@effectionx/fs";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { WorkflowLifecycle, WorkflowRunNotFoundError } from "../mod.ts";
import type { ExecutorAcquisition, ExecutorLock } from "../mod.ts";
import { useWorkflowLifecycle } from "../deno.ts";
import {
  creation,
  withExecutorRun,
  runPath,
  tamper,
  useStorageRoot,
  withRunHost,
} from "./support/storage.ts";

const { acquireExecutor } = WorkflowLifecycle.operations;

const HOLDER = fileURLToPath(new URL("./support/executor-holder.ts", import.meta.url));

function withLifecycle<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowLifecycle({ root });
    return yield* body();
  });
}

function* acquired(runId: string): Operation<ExecutorAcquisition> {
  const answered = yield* acquireExecutor(runId);
  if (!answered.ok) {
    throw answered.error;
  }
  return answered.value;
}

/** The executor lock an acquisition produced, or a failure naming its outcome. */
function lockOf(acquisition: ExecutorAcquisition): ExecutorLock {
  if (acquisition.kind !== "acquired") {
    throw new Error(`expected an acquired executor lock, found ${acquisition.kind}`);
  }
  return acquisition.lock;
}

describe("Tier WLA — executor lock", () => {
  it("WLA1: the executor lock is exclusive within a host and released with its scope", function* () {
    const root = yield* useStorageRoot();
    yield* startedRun(root, "release-1.4");
    yield* startedRun(root, "release-1.5");

    yield* withLifecycle(root, function* () {
      yield* scoped(function* () {
        const first = yield* acquired("release-1.4");
        expect(first.kind).toBe("acquired");

        // A second acquisition while the first is held reports the workflow executor
        // rather than waiting for it.
        const second = yield* acquired("release-1.4");
        expect(second.kind).toBe("already-running");

        // Another run is not this run.
        expect((yield* acquired("release-1.5")).kind).toBe("acquired");
      });

      // The scope that asked has ended, so the run is available again.
      expect((yield* acquired("release-1.4")).kind).toBe("acquired");
    });
  });

  it("WLA5: an absent run refuses a resume and leaves no candidate behind", function* () {
    const root = yield* useStorageRoot();

    yield* withRunHost(root, function* (transitions) {
      const acquisition = yield* acquired("never-started");
      const begun = yield* transitions.begin(lockOf(acquisition), {
        runId: "never-started",
        action: "resume",
        // Carrying a definition must not turn a lookup into a creation.
        creation: creation(),
      });
      expect(begun.ok).toBe(false);
      expect(begun.ok ? undefined : begun.error).toBeInstanceOf(WorkflowRunNotFoundError);
    });

    // Opening a connection creates the file, so a refusal that opened one would
    // leave a candidate `list` then refuses for the whole store.
    expect(yield* exists(runPath(root, "never-started"))).toBe(false);
    yield* withLifecycle(root, function* () {
      const listed = yield* WorkflowLifecycle.operations.list();
      expect(listed.ok).toBe(true);
      expect(listed.ok ? listed.value : undefined).toEqual([]);
    });

    // A file that exists and holds nothing is not a run either. Existence is
    // what `exists()` can see; whether it is a run is a question only the
    // transaction can ask.
    const pristine = runPath(root, "half-started");
    yield* writeTextFile(pristine, "");

    yield* withRunHost(root, function* (transitions) {
      const acquisition = yield* acquired("half-started");
      const begun = yield* transitions.begin(lockOf(acquisition), {
        runId: "half-started",
        action: "resume",
        creation: creation(),
      });
      expect(begun.ok).toBe(false);
      expect(begun.ok ? undefined : begun.error).toBeInstanceOf(WorkflowRunNotFoundError);
    });

    // Still not a run: no schema, so no run row and no execution row either.
    // The bytes are not identical — SQLite writes a header when a transaction
    // opens and commits on an empty file, and refusing any later than this
    // would mean opening it. What matters is that nothing was initialized.
    expect(tables(pristine)).toEqual([]);
  });

  it("WLA7: one acquisition begins one execution", function* () {
    const root = yield* useStorageRoot();
    yield* startedRun(root, "release-1.4");

    yield* withRunHost(root, function* (transitions) {
      yield* scoped(function* () {
        const executorLock = lockOf(yield* acquired("release-1.4"));
        const first = yield* transitions.begin(executorLock, {
          runId: "release-1.4",
          action: "resume",
        });
        if (!first.ok) {
          throw first.error;
        }

        // The same executor lock again. Without a one-use rule this would find its own
        // live execution, read it as a dead executor's leftovers, close it and
        // start another — two live executions under one executor lock.
        const second = yield* transitions.begin(executorLock, {
          runId: "release-1.4",
          action: "resume",
        });
        expect(second.ok).toBe(false);

        yield* withLifecycle(root, function* () {
          const snapshot = yield* WorkflowLifecycle.operations.inspect("release-1.4");
          if (!snapshot.ok) {
            throw snapshot.error;
          }
          const live = snapshot.value.executions.filter(
            (execution) => execution.stoppedAt === undefined,
          );
          expect(live).toHaveLength(1);
          expect(live[0]?.executionId).toBe(first.value.execution.executionId);
        });
      });
    });
  });

  it("WLA8: the initial start and every resume get a record of their own", function* () {
    const root = yield* useStorageRoot();
    yield* startedRun(root, "release-1.4");

    // Each acquisition begins one execution, so a second record comes from a
    // second acquisition — which is what a resume is.
    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId: "release-1.4", action: "resume" },
        function* () {},
      );
    });

    yield* withLifecycle(root, function* () {
      const snapshot = yield* WorkflowLifecycle.operations.inspect("release-1.4");
      if (!snapshot.ok) {
        throw snapshot.error;
      }
      const executions = snapshot.value.executions;
      expect(executions).toHaveLength(2);
      // The first was left unfinished by a workflow executor that went away, and the
      // second acquisition proved it stale and closed it.
      expect(executions[0]?.stopStatus).toBe("interrupted");
      expect(executions[0]?.stoppedAt).toBeDefined();
      expect(executions[1]?.executionId).not.toBe(executions[0]?.executionId);
    });
  });

  it("WLA9: an execution is settled once, by the acquisition that began it", function* () {
    const root = yield* useStorageRoot();

    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId: "release-1.4", action: "start", creation: creation() },
        function* (begun, executorLock) {
          const completion = {
            executionId: begun.execution.executionId,
            status: "completed",
          } as const;

          expect((yield* transitions.settle(executorLock, completion)).ok).toBe(true);
          // Twice is not once.
          expect((yield* transitions.settle(executorLock, completion)).ok).toBe(false);
          // And an execution this acquisition never began is not its to settle.
          expect(
            (yield* transitions.settle(executorLock, {
              executionId: "never-began",
              status: "failed",
            })).ok,
          ).toBe(false);
        },
      );
    });
  });

  it("WLA3: no invalid executor lock moves a run or creates one", function* () {
    const root = yield* useStorageRoot();
    yield* startedRun(root, "release-1.4");
    yield* startedRun(root, "release-1.5");
    const path = runPath(root, "release-1.4");

    // Four ways an executor lock can be wrong, each presented against the same run.
    const candidates: { name: string; lock: ExecutorLock }[] = [];
    yield* withRunHost(root, function* (transitions) {
      // Closed: real, issued for this run, and its scope has ended.
      yield* scoped(function* () {
        candidates.push({
          name: "closed",
          lock: lockOf(yield* acquired("release-1.4")),
        });
      });
      // Foreign: real and live, issued for another run entirely.
      candidates.push({
        name: "foreign",
        lock: lockOf(yield* acquired("release-1.5")),
      });

      // The two that matter most are held against a run whose executor lock is *live*,
      // so nothing but identity can tell them from the real one. A copy that
      // was refused because the run happened to be unowned would prove nothing.
      const live = lockOf(yield* acquired("release-1.4"));
      candidates.push({ name: "copied", lock: { ...live } });
      candidates.push({ name: "fabricated", lock: { runId: live.runId } });

      const before = yield* fingerprint(path);
      const outcomes: string[] = [];
      for (const { name, lock: candidate } of candidates) {
        const begun = yield* transitions.begin(candidate, {
          runId: "release-1.4",
          action: "resume",
        });
        const settled = yield* transitions.settle(candidate, {
          executionId: "any-execution",
          status: "completed",
        });
        outcomes.push(`${name}: begin ${begun.ok}, settle ${settled.ok}`);
        // Every row and every byte of the run it addressed.
        expect(yield* fingerprint(path)).toEqual(before);
      }
      expect(outcomes).toEqual([
        "closed: begin false, settle false",
        "foreign: begin false, settle false",
        "copied: begin false, settle false",
        "fabricated: begin false, settle false",
      ]);

      // And none of them brought a run into existence on the way to refusal.
      const invented = lockOf(yield* acquired("never-started"));
      expect(
        (yield* transitions.begin(invented, { runId: "never-started", action: "resume" })).ok,
      ).toBe(false);
      expect(yield* exists(runPath(root, "never-started"))).toBe(false);
    });
  });

  it("WLA10: a transaction that fails after writing half of itself shows neither", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");

    yield* withRunHost(root, function* (transitions) {
      // Settlement finishes the execution record and then publishes the run
      // state. The trigger fires from inside SQLite between those two writes —
      // the only moment a half-settled run could become visible.
      yield* withExecutorRun(
        transitions,
        { runId: "release-1.4", action: "start", creation: creation() },
        function* (begun, executorLock) {
          tamper(path, (database) => {
            database.exec(`
              CREATE TRIGGER refuse_publish BEFORE UPDATE OF status ON workflow_run
              BEGIN
                SELECT raise(ABORT, 'the run state refuses this write');
              END
            `);
          });
          const before = yield* fingerprint(path);

          // An unclassified SQLite failure is a defect rather than an expected
          // outcome, so it is raised rather than returned. What matters here is
          // what it left behind.
          const raised = yield* raise(
            transitions.settle(executorLock, {
              executionId: begun.execution.executionId,
              status: "completed",
            }),
          );
          expect(raised).toBeDefined();

          // The execution is not finished and the status did not move.
          expect(yield* fingerprint(path)).toEqual(before);
        },
      );
    });

    // Begin writes in the same order: it recovers the execution that the workflow executor left
    // unfinished, publishes, and inserts its own. The same trigger catches it
    // after the first of those writes.
    const before = yield* fingerprint(path);
    yield* withRunHost(root, function* (transitions) {
      const executorLock = lockOf(yield* acquired("release-1.4"));
      // However it reports — a refusal or a raise — what matters is that it
      // added no execution and moved no status.
      yield* raise(transitions.begin(executorLock, { runId: "release-1.4", action: "resume" }));
    });
    expect(yield* fingerprint(path)).toEqual(before);
  });

  it("WLA4: a second process is refused, and the lock outlives nothing", function* () {
    const root = yield* useStorageRoot();
    yield* startedRun(root, "release-1.4");

    yield* withLifecycle(root, function* () {
      yield* scoped(function* () {
        yield* acquired("release-1.4");
        // A real second process, because a lock this host respects and the
        // operating system does not is not a lock.
        const refused = yield* holder(root, "release-1.4");
        expect(refused).toBe("already-running");
      });

      // Released with the scope, so the same second process can now acquire it.
      expect(yield* holder(root, "release-1.4")).toBe("acquired");
    });
  });
});

/** A run that exists, created the only way one can be: under the executor lock. */
function* startedRun(root: string, runId: string): Operation<void> {
  yield* withRunHost(root, function* (transitions) {
    yield* withExecutorRun(
      transitions,
      { runId, action: "start", creation: creation() },
      function* () {},
    );
  });
}

/** Every row and every byte a transition would have had to change. */
function* fingerprint(path: string): Operation<{ bytes: string; rows: string }> {
  const bytes = yield* until(readFile(path));
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = [
      ...database.prepare("SELECT * FROM workflow_run").all(),
      ...database.prepare("SELECT * FROM document_executions").all(),
      ...database.prepare("SELECT event_id, record FROM journal_events").all(),
    ];
    return { bytes: bytes.toString("base64"), rows: JSON.stringify(rows) };
  } finally {
    database.close();
  }
}

/** Whatever anybody declared in this database, which for a pristine one is nothing. */
function tables(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row["name"]));
  } finally {
    database.close();
  }
}

/** Whatever an operation raised, or nothing when it returned. */
function* raise(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** What one separate process makes of this run's lock, right now. */
function* holder(root: string, runId: string): Operation<string> {
  const result = yield* exec(process.execPath, {
    arguments: ["run", "-A", HOLDER, root, runId],
  }).join();
  if (result.code !== 0) {
    throw new Error(`the holder process failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
