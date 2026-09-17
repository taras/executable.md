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

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import { scoped, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { WorkflowLifecycle, WorkflowRunNotFoundError } from "../mod.ts";
import type { WorkflowRunRecord, WorkflowRunStatus } from "../mod.ts";
import { useWorkflowLifecycle, workflowRunLock, workflowRunPath } from "../deno.ts";
import {
  BUNDLE_ENTRYPOINT,
  BUNDLE_SOURCE,
  creation,
  runLeftUnfinished,
  sourceBundleCreation,
  storedBytes,
  useStorageRoot,
  withExecutor,
  withExecutorRun,
  withRunHost,
} from "./support/storage.ts";
import { useWorkflowRunConnections } from "../src/deno/connections.ts";
import type { RunConnection, WorkflowRunConnections } from "../src/deno/connections.ts";
import { SavepointObservation } from "../src/deno/savepoints.ts";
import { installWorkflowRunStorage } from "../src/deno/provider.ts";
import { installWorkflowLifecycle } from "../src/deno/lifecycle.ts";
import { legacySourceReader } from "./support/legacy-source.ts";
import { parseSourceBundleDefinition } from "../mod.ts";
import type { LegacyWorkflowSourceReader, WorkflowBeginRequest } from "../deno.ts";

const { cancel } = WorkflowLifecycle.operations;

function withLifecycle<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowLifecycle({ root, legacySource: legacySourceReader() });
    return yield* body();
  });
}

/** A run left in one retained state, by a workflow executor that is gone. */
function* runEndedAs(
  root: string,
  runId: string,
  status: WorkflowRunStatus | "unfinished",
): Operation<void> {
  if (status === "unfinished") {
    // A whole process, killed. Returning from a scope here would run the
    // executor hold's teardown, which settles the execution the acquisition
    // began — the opposite of what a workflow executor that went away leaves.
    return yield* runLeftUnfinished(root, runId);
  }
  yield* withRunHost(root, function* (transitions) {
    yield* withExecutorRun(
      transitions,
      { runId, action: "start", creation: creation() },
      function* (begun, executorLock) {
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
    const neighbourBytes = (yield* until(readFile(neighbour))).toString("base64");

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
    expect((yield* until(readFile(neighbour))).toString("base64")).toBe(neighbourBytes);
  });
});

/**
 * Tier WLT — a run cancelled after its creation committed.
 *
 * Between the moment a creation transaction commits and the moment its caller
 * has registered anything of its own there is real work: the begin transition
 * reads its retained source back and authenticates it, the caller reports the
 * run id, projects the closure and imports the Deno adapter. Every one of those
 * suspends, and a cancellation arriving in any of them used to leave the
 * durable run and its execution saying `running` while the executor lock was
 * released — a run nothing was advancing, that the next acquisition would have
 * to reconcile as somebody else's leftovers.
 *
 * The two cases below are those two windows, taken deterministically rather
 * than by timing: one halts the begin transition while it is still inside
 * source settlement, the other halts after it returned and before anything was
 * registered. Both read the durable file directly afterwards, with no executor
 * lock taken, so what they observe is what teardown itself wrote and not what a
 * later acquisition's recovery would have made of it.
 *
 * The negative control is the third case. Before the transaction commits there
 * is nothing to settle and nothing to find, and the run id is free.
 */
describe("Tier WLT — interrupted after the creation transaction committed", () => {
  /** The durable row, read without taking the run's executor lock. */
  /**
   * One row, narrowed to what a row is rather than asserted into it.
   *
   * SQLite hands back `unknown`, and a value that is not an object is a failure
   * about the row — not a `TypeError` somewhere downstream reading a member off
   * it.
   */
  function row(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${what} is not a row`);
    }
    return { ...value };
  }

  function rows(values: readonly unknown[], what: string): Record<string, unknown>[] {
    return values.map((value) => row(value, what));
  }

  function count(value: unknown, what: string): number {
    const n = row(value, what)["n"];
    if (typeof n !== "number") {
      throw new Error(`${what} counted nothing`);
    }
    return n;
  }

  interface Retained {
    readonly status: unknown;
    readonly reasonKind: unknown;
    readonly reasonCode: unknown;
    readonly executions: Record<string, unknown>[];
    readonly sources: Record<string, unknown>[];
    readonly definition: unknown;
    readonly events: number;
  }

  function retained(root: string, runId: string): Retained {
    const database = new DatabaseSync(workflowRunPath(root, runId), { readOnly: true });
    try {
      const run = row(database.prepare("SELECT * FROM workflow_run").get(), "the run");
      return {
        status: run["status"],
        reasonKind: run["stop_reason_kind"],
        reasonCode: run["stop_reason_code"],
        definition: run["definition"],
        executions: rows(
          database.prepare("SELECT * FROM document_executions ORDER BY sequence ASC").all(),
          "a document execution",
        ),
        sources: rows(
          database
            .prepare(
              "SELECT s.path, s.source_hash, b.byte_length, b.content FROM " +
                "workflow_definition_source s JOIN workflow_definition_blob b " +
                "ON b.source_hash = s.source_hash ORDER BY s.path ASC",
            )
            .all(),
          "a retained source",
        ),
        events: count(
          database.prepare("SELECT count(*) AS n FROM journal_events").get(),
          "the journal",
        ),
      };
    } finally {
      database.close();
    }
  }

  /** Everything both post-commit windows owe, whichever one produced them. */
  function* settledInterrupted(root: string, runId: string): Operation<void> {
    const after = retained(root, runId);

    // The complete version-2 snapshot is durable: the descriptor, and the exact
    // bytes behind every path it names. Read through the same parser a host
    // reads it through, so what is inspected is a descriptor rather than
    // whatever shape `JSON.parse` happened to produce.
    const parsed = parseSourceBundleDefinition(JSON.parse(String(after.definition)));
    if (!parsed.ok) {
      throw parsed.error;
    }
    const definition = parsed.value;
    expect(definition.version).toBe(2);
    expect(definition.kind).toBe("source-bundle");
    expect(definition.entrypoint).toBe(BUNDLE_ENTRYPOINT);
    expect(definition.sources).toHaveLength(1);
    expect(after.sources).toHaveLength(1);
    expect(after.sources[0]?.["path"]).toBe(BUNDLE_ENTRYPOINT);
    expect(after.sources[0]?.["source_hash"]).toBe(definition.sources[0]?.sourceHash);
    expect(new TextDecoder().decode(storedBytes(after.sources[0], "content"))).toBe(BUNDLE_SOURCE);

    // The exact first execution is finished, and finished as this and nothing
    // else. `executor-interrupted` is what teardown writes; a later
    // acquisition reconciling leftovers would have written something else.
    expect(after.executions).toHaveLength(1);
    expect(after.executions[0]?.["stopped_at"]).not.toBe(null);
    expect(after.executions[0]?.["stop_status"]).toBe("interrupted");
    expect(after.executions[0]?.["stop_reason_kind"]).toBe("host");
    expect(after.executions[0]?.["stop_reason_code"]).toBe("executor-interrupted");

    // And the run publishes it, rather than staying `running` beside a
    // finished execution.
    expect(after.status).toBe("interrupted");
    expect(after.reasonKind).toBe("host");
    expect(after.reasonCode).toBe("executor-interrupted");

    // Nothing ran: no root import, no authored effect, no journal at all.
    expect(after.events).toBe(0);

    // The lock is free, and it was already settled when it became free — the
    // reads above took no lock, so nothing between teardown and here could
    // have written what they saw. Acquiring is what proves the release.
    yield* withRunHost(root, function* () {
      yield* withExecutor(runId, function* () {
        expect(retained(root, runId).status).toBe("interrupted");
      });
    });

    // And the run resumes from the bytes it retained, not from anything a host
    // would have to go and find.
    yield* withRunHost(root, function* (transitions) {
      yield* withExecutor(runId, function* (executorLock) {
        const resumed = yield* transitions.begin(executorLock, { runId, action: "resume" });
        if (!resumed.ok) {
          throw resumed.error;
        }
        const { sources } = resumed.value;
        if (sources.definitionVersion !== 2) {
          throw new Error("the resumed run is not a source bundle");
        }
        expect(sources.sources.map((one) => one.path)).toEqual([BUNDLE_ENTRYPOINT]);
        const retainedBytes = sources.sources[0]?.bytes;
        if (retainedBytes === undefined) {
          throw new Error("the resumed run retains no entrypoint");
        }
        expect(new TextDecoder().decode(retainedBytes)).toBe(BUNDLE_SOURCE);
      });
    });
  }

  it("WLT1: halted inside source settlement, the committed run settles interrupted", function* () {
    const root = yield* useStorageRoot();
    const runId = "committed-then-halted";
    const request: WorkflowBeginRequest = {
      runId,
      action: "start",
      creation: yield* sourceBundleCreation(),
    };

    // The first time the connection lock is taken after the creation
    // transaction committed is source settlement reading the retained bytes
    // back to authenticate them. Holding that acquisition open is what puts
    // this case inside the window by construction rather than by winning a race
    // against it: the transition is provably still in `settleSources`, because
    // it is stopped there.
    const arrived = withResolvers<void>();
    const held = withResolvers<void>();
    let gated = false;
    /** Whether the creation transaction has committed, asked of the file. */
    function committed(): boolean {
      try {
        return retained(root, runId).executions.length === 1;
      } catch {
        // No database, or no table in it yet: nothing has committed.
        return false;
      }
    }
    function gate(inner: RunConnection): RunConnection {
      return {
        ...inner,
        lock: {
          *hold(): Operation<void> {
            yield* inner.lock.hold();
            if (!gated && committed()) {
              gated = true;
              arrived.resolve();
              yield* held.operation;
            }
          },
        },
      };
    }

    yield* scoped(function* () {
      const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
      const gated: WorkflowRunConnections = {
        ...connections,
        *at(path: string): Operation<RunConnection> {
          return gate(yield* connections.at(path));
        },
      };
      yield* installWorkflowRunStorage({ root }, {}, gated);
      const transitions = yield* installWorkflowLifecycle(
        { root, legacySource: legacySourceReader() },
        gated,
      );

      yield* scoped(function* () {
        const acquisition = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
        if (!acquisition.ok) {
          throw acquisition.error;
        }
        if (acquisition.value.kind !== "acquired") {
          throw new Error(`${runId} already has a live workflow executor`);
        }
        const executorLock = acquisition.value.lock;

        let returned = false;
        const begun = yield* spawn(function* () {
          const result = yield* transitions.begin(executorLock, request);
          returned = true;
          return result;
        });

        // Settlement has the lock and is stopped in it. Everything below is
        // therefore about a run whose creation transaction committed and whose
        // transition has not returned.
        yield* arrived.operation;
        expect(returned).toBe(false);
        expect(retained(root, runId).status).toBe("running");
        expect(retained(root, runId).executions).toHaveLength(1);
        expect(retained(root, runId).executions[0]?.["stopped_at"]).toBe(null);

        // Halted where it stands, and the acquisition torn down under it —
        // structured cancellation, inside the window.
        yield* begun.halt();
        held.resolve();
      });
    });

    yield* settledInterrupted(root, runId);
  });

  it("WLT2: halted after admission returned and before a caller registered anything", function* () {
    const root = yield* useStorageRoot();
    const runId = "admitted-then-halted";
    const creation = yield* sourceBundleCreation();

    yield* withRunHost(root, function* (transitions) {
      yield* scoped(function* () {
        const acquisition = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
        if (!acquisition.ok) {
          throw acquisition.error;
        }
        if (acquisition.value.kind !== "acquired") {
          throw new Error(`${runId} already has a live workflow executor`);
        }
        const begun = yield* transitions.begin(acquisition.value.lock, {
          runId,
          action: "start",
          creation,
        });
        if (!begun.ok) {
          throw begun.error;
        }

        // Exactly where the command stands when it reports the run id,
        // projects the closure and imports the Deno adapter: admitted, running,
        // and with nothing of its own registered yet. The scope ends here.
        expect(retained(root, runId).status).toBe("running");
        expect(retained(root, runId).executions[0]?.["stopped_at"]).toBe(null);
      });
    });

    yield* settledInterrupted(root, runId);
  });

  it("WLT3: halted inside pre-commit authentication, nothing is recognized and the id is free", function* () {
    const root = yield* useStorageRoot();
    const runId = "never-committed";

    // The source-authentication window, held open from inside it. A version-1
    // creation is what makes this deterministic: its source lives in a
    // repository this package does not reach, so `begin` asks the host's
    // legacy reader for it — before the lifecycle transaction opens, and
    // therefore before anything at all is written. That reader is a public
    // seam, and a reader that does not answer is a `begin` provably stopped in
    // the window this case is about.
    const arrived = withResolvers<void>();
    const held = withResolvers<void>();
    const blockingReader: LegacyWorkflowSourceReader = function* () {
      arrived.resolve();
      yield* held.operation;
      throw new Error("the reader was expected to be halted, not resumed");
    };

    yield* scoped(function* () {
      const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
      yield* installWorkflowRunStorage({ root }, {}, connections);
      const transitions = yield* installWorkflowLifecycle(
        { root, legacySource: blockingReader },
        connections,
      );

      yield* scoped(function* () {
        const acquisition = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
        if (!acquisition.ok) {
          throw acquisition.error;
        }
        if (acquisition.value.kind !== "acquired") {
          throw new Error(`${runId} already has a live workflow executor`);
        }
        const executorLock = acquisition.value.lock;
        const request: WorkflowBeginRequest = {
          runId,
          action: "start",
          creation: creation(),
        };
        let returned = false;
        const begun = yield* spawn(function* () {
          const result = yield* transitions.begin(executorLock, request);
          returned = true;
          return result;
        });

        // Stopped in authentication, with the transaction not yet opened.
        yield* arrived.operation;
        expect(returned).toBe(false);

        // Halted where it stands, and the acquisition torn down under it.
        yield* begun.halt();
        held.resolve();
      });
    });

    // No run is recognized, and no document execution was retained. Inspection
    // is the question a host asks, and the file — if a connection created one
    // at all — is the question nothing can hide from.
    yield* withLifecycle(root, function* () {
      const inspected = yield* WorkflowLifecycle.operations.inspect(runId);
      expect(inspected.ok).toBe(false);
    });
    expect(() => retained(root, runId)).toThrow();

    // The executor lock is released: acquiring it is the only proof that takes.
    yield* withRunHost(root, function* () {
      yield* withExecutor(runId, function* () {
        expect(true).toBe(true);
      });
    });

    // And the id is free: the same one starts cleanly, and what it retains is
    // its own creation rather than anything the halted attempt left. The status
    // below belongs to that clean start, which this scope then ends — the
    // checks above are the control, and they hold whether or not a committed
    // run settles on teardown.
    yield* withRunHost(root, function* (transitions) {
      yield* withExecutor(runId, function* (executorLock) {
        const started = yield* transitions.begin(executorLock, {
          runId,
          action: "start",
          creation: yield* sourceBundleCreation(),
        });
        if (!started.ok) {
          throw started.error;
        }
        expect(started.value.record.runId).toBe(runId);
      });
    });
    expect(retained(root, runId).status).toBe("interrupted");
    expect(new TextDecoder().decode(storedBytes(retained(root, runId).sources[0], "content"))).toBe(
      BUNDLE_SOURCE,
    );
  });
});
