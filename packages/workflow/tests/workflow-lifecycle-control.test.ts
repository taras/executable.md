/**
 * Tier WLC — making a run terminal, and removing one.
 *
 * Cancellation never reaches into a live document execution. The lock is the
 * whole test for whether one is live, so these suites take it for real: a run
 * with a live workflow executor is refused, and everything else is decided from what the
 * run retains.
 *
 * Every refusal is checked for what it left behind. A cancellation that refused
 * and still moved a row would be worse than one that failed outright.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import { scoped } from "effection";
import type { Operation } from "effection";
import { WorkflowLifecycle, WorkflowRunNotFoundError } from "../mod.ts";
import type { WorkflowRunRecord, WorkflowRunStatus } from "../mod.ts";
import { useWorkflowLifecycle, workflowRunLock, workflowRunPath } from "../deno.ts";
import { creation, useStorageRoot, withExecutorRun, withRunHost } from "./support/storage.ts";

const { cancel } = WorkflowLifecycle.operations;

function withLifecycle<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowLifecycle({ root });
    return yield* body();
  });
}

/** A run left in one retained state, by a workflow executor that is gone. */
function* runEndedAs(
  root: string,
  runId: string,
  status: WorkflowRunStatus | "unfinished",
): Operation<void> {
  yield* withRunHost(root, function* (transitions) {
    yield* withExecutorRun(
      transitions,
      { runId, action: "start", creation: creation() },
      function* (begun, executorLock) {
        if (status === "unfinished") {
          // Nothing settles it: the workflow executor went away mid-execution.
          return;
        }
        const settled = yield* transitions.settle(executorLock, {
          executionId: begun.execution.executionId,
          status,
        });
        if (!settled.ok) {
          throw settled.error;
        }
      },
    );
  });
}

/** Every row a cancellation could have touched. */
function fingerprint(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify([
      ...database.prepare("SELECT * FROM workflow_run").all(),
      ...database.prepare("SELECT * FROM document_executions").all(),
    ]);
  } finally {
    database.close();
  }
}

function* status(root: string, runId: string): Operation<WorkflowRunStatus> {
  return yield* withLifecycle(root, function* () {
    const snapshot = yield* WorkflowLifecycle.operations.inspect(runId);
    if (!snapshot.ok) {
      throw snapshot.error;
    }
    return snapshot.value.record.status;
  });
}

function* cancelled(root: string, runId: string): Operation<WorkflowRunRecord> {
  return yield* withLifecycle(root, function* () {
    const answered = yield* cancel(runId);
    if (!answered.ok) {
      throw answered.error;
    }
    return answered.value;
  });
}

describe("Tier WLC — cancellation and deletion", () => {
  it("WLC1: a live workflow executor is not cancelled, and nothing moves", function* () {
    const root = yield* useStorageRoot();
    yield* runEndedAs(root, "release-1.4", "unfinished");
    const path = workflowRunPath(root, "release-1.4");

    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(transitions, { runId: "release-1.4", action: "resume" }, function* () {
        const before = fingerprint(path);

        // This scope holds the lock, which is what makes its workflow executor live.
        const refused = yield* cancel("release-1.4");
        expect(refused.ok).toBe(false);
        // The caller is told what to do instead of being left guessing.
        expect(refused.ok ? "" : refused.error.message).toContain("Interrupt");

        expect(fingerprint(path)).toBe(before);
      });
    });
  });

  it("WLC2: a run with no live workflow executor follows its retained state", function* () {
    const root = yield* useStorageRoot();

    // Nothing running, nothing recorded: cancellable directly.
    yield* runEndedAs(root, "interrupted-1", "interrupted");
    expect((yield* cancelled(root, "interrupted-1")).status).toBe("cancelled");

    yield* runEndedAs(root, "suspended-1", "suspended");
    expect((yield* cancelled(root, "suspended-1")).status).toBe("cancelled");

    // Saying it twice is the same answer.
    expect((yield* cancelled(root, "suspended-1")).status).toBe("cancelled");

    // An outcome that already won is not cancelled.
    for (const terminal of ["completed", "failed"] as const) {
      yield* runEndedAs(root, `${terminal}-1`, terminal);
      const path = workflowRunPath(root, `${terminal}-1`);
      const before = fingerprint(path);

      yield* withLifecycle(root, function* () {
        const refused = yield* cancel(`${terminal}-1`);
        expect(refused.ok).toBe(false);
      });

      expect(fingerprint(path)).toBe(before);
      expect(yield* status(root, `${terminal}-1`)).toBe(terminal);
    }

    // A run nobody started is reported rather than invented.
    yield* withLifecycle(root, function* () {
      const absent = yield* cancel("never-started");
      expect(absent.ok).toBe(false);
      expect(absent.ok ? undefined : absent.error).toBeInstanceOf(WorkflowRunNotFoundError);
    });
    expect(yield* exists(workflowRunPath(root, "never-started"))).toBe(false);
  });

  it("WLC3: a stale execution cancels, unless its root already recorded one", function* () {
    const root = yield* useStorageRoot();

    // A workflow executor that went away mid-execution, recording nothing.
    yield* runEndedAs(root, "stale-1", "unfinished");
    const record = yield* cancelled(root, "stale-1");
    expect(record.status).toBe("cancelled");
    yield* withLifecycle(root, function* () {
      const snapshot = yield* WorkflowLifecycle.operations.inspect("stale-1");
      if (!snapshot.ok) {
        throw snapshot.error;
      }
      // The execution it left is finished too, not left open beside a
      // cancelled run.
      expect(snapshot.value.executions.every((one) => one.stoppedAt !== undefined)).toBe(true);
      expect(snapshot.value.executions[0]?.stopStatus).toBe("cancelled");
    });

    // A workflow executor that went away after its root recorded an outcome. The Close
    // proves the document finished before anything could cancel it.
    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId: "closed-1", action: "start", creation: creation() },
        function* (begun) {
          yield* begun.database.journal.append({
            type: "close",
            coroutineId: "root",
            result: { status: "ok", value: "rendered" },
          });
        },
      );
    });

    yield* withLifecycle(root, function* () {
      const refused = yield* cancel("closed-1");
      expect(refused.ok).toBe(false);
    });
    // Restored to what its root recorded, rather than cancelled.
    expect(yield* status(root, "closed-1")).toBe("completed");

    // The same rule when what the root recorded was a failure: a Close that
    // says the document failed is still an outcome that won.
    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId: "failed-close-1", action: "start", creation: creation() },
        function* (begun) {
          yield* begun.database.journal.append({
            type: "close",
            coroutineId: "root",
            result: { status: "err", error: { message: "filtered" } },
          });
        },
      );
    });

    yield* withLifecycle(root, function* () {
      const refused = yield* cancel("failed-close-1");
      expect(refused.ok).toBe(false);
    });
    expect(yield* status(root, "failed-close-1")).toBe("failed");
  });

  it("WLC5: every state without a live workflow executor may be deleted", function* () {
    const root = yield* useStorageRoot();
    const states = [
      "suspended",
      "interrupted",
      "cancelled",
      "completed",
      "failed",
      "unfinished",
    ] as const;

    for (const state of states) {
      const runId = `delete-${state}`;
      // `cancelled` is reached the only way it can be: by cancelling one.
      yield* runEndedAs(root, runId, state === "cancelled" ? "interrupted" : state);
      if (state === "cancelled") {
        yield* cancelled(root, runId);
      }

      yield* withLifecycle(root, function* () {
        const removed = yield* WorkflowLifecycle.operations.delete(runId);
        if (!removed.ok) {
          throw removed.error;
        }
        // Exactly the categories that went, and `run-storage` is the only one
        // this host retains.
        expect(removed.value.removed).toEqual(["run-storage"]);
      });
      expect(yield* exists(workflowRunPath(root, runId))).toBe(false);
    }

    // Including a `running` record whose workflow executor is gone: the released lock is
    // what proves it stale, and nothing else is consulted.
    expect(yield* exists(workflowRunPath(root, "delete-unfinished"))).toBe(false);
  });

  it("WLC4: deletion removes the exact run only without a live workflow executor", function* () {
    const root = yield* useStorageRoot();
    yield* runEndedAs(root, "release-1.4", "completed");
    yield* runEndedAs(root, "release-1.5", "completed");
    const path = workflowRunPath(root, "release-1.4");
    const neighbour = workflowRunPath(root, "release-1.5");
    const neighbourBytes = readFileSync(neighbour).toString("base64");

    // A live workflow executor is refused, and the run is still there afterwards.
    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(transitions, { runId: "release-1.4", action: "resume" }, function* () {
        const refused = yield* WorkflowLifecycle.operations.delete("release-1.4");
        expect(refused.ok).toBe(false);
      });
    });
    expect(yield* exists(path)).toBe(true);

    yield* withLifecycle(root, function* () {
      const removed = yield* WorkflowLifecycle.operations.delete("release-1.4");
      if (!removed.ok) {
        throw removed.error;
      }
      // Only what actually went, and the lock is not retained run state.
      expect(removed.value.removed).toEqual(["run-storage"]);

      // Absent is reported rather than treated as an idempotent success.
      const again = yield* WorkflowLifecycle.operations.delete("release-1.4");
      expect(again.ok).toBe(false);
      expect(again.ok ? undefined : again.error).toBeInstanceOf(WorkflowRunNotFoundError);
    });

    expect(yield* exists(path)).toBe(false);
    // The empty lock file may remain; unlinking one a workflow executor could hold would
    // let the next caller lock a different file at the same path.
    expect(yield* exists(workflowRunLock(root, "release-1.4"))).toBe(true);
    // And the run beside it is untouched, byte for byte.
    expect(readFileSync(neighbour).toString("base64")).toBe(neighbourBytes);
  });
});
