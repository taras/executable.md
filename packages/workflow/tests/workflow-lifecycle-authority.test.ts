/**
 * Tier WLA — who may advance a run.
 *
 * The subject is an operating-system lock, so these tests take it for real and,
 * where ownership across processes is the claim, from a real second process.
 * An in-process stand-in would prove that this module agrees with itself.
 *
 * A lease's whole value is that it expires. Every test that acquires one also
 * says what happens after the scope ends, because "the lock was taken" and "the
 * lock is released when the holder is done with it" are different facts and only
 * the pair is worth anything.
 */

import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec } from "@effectionx/process";
import { exists, readTextFile } from "@effectionx/fs";
import { scoped } from "effection";
import type { Operation } from "effection";
import { WorkflowLifecycle } from "../mod.ts";
import type { ExecutorAcquisition, ExecutorLease } from "../mod.ts";
import { useWorkflowLifecycle, workflowRunSidecars } from "../deno.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";

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

/** The lease an acquisition produced, or a failure naming what it produced instead. */
function leaseOf(acquisition: ExecutorAcquisition): ExecutorLease {
  if (acquisition.kind !== "acquired") {
    throw new Error(`expected an acquired lease, found ${acquisition.kind}`);
  }
  return acquisition.lease;
}

describe("Tier WLA — executor authority", () => {
  it("WLA1: a lease is exclusive within a host, and released with its scope", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun({ runId: "release-1.4" });
    });

    yield* withLifecycle(root, function* () {
      yield* scoped(function* () {
        const first = yield* acquired("release-1.4");
        expect(first.kind).toBe("acquired");

        // A second acquisition while the first is held reports the owner
        // rather than waiting for it.
        const second = yield* acquired("release-1.4");
        expect(second.kind).toBe("already-running");

        // Another run is not this run.
        yield* withStorage(root, function* () {
          yield* createRun({ runId: "release-1.5" });
        });
        expect((yield* acquired("release-1.5")).kind).toBe("acquired");
      });

      // The scope that asked has ended, so the run is available again.
      expect((yield* acquired("release-1.4")).kind).toBe("acquired");
    });
  });

  it("WLA2: the descriptor names the live owner and goes when the lease does", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun({ runId: "release-1.4" });
    });
    const sidecars = workflowRunSidecars(root, "release-1.4");

    yield* withLifecycle(root, function* () {
      let published = "";
      yield* scoped(function* () {
        yield* acquired("release-1.4");
        published = yield* readTextFile(sidecars.descriptor);
        const descriptor = JSON.parse(published);
        expect(descriptor.runId).toBe("release-1.4");
        expect(typeof descriptor.generation).toBe("string");
      });

      // A descriptor outliving its lock would be read as a live owner.
      expect(yield* exists(sidecars.descriptor)).toBe(false);

      // The next acquisition publishes a generation of its own.
      yield* scoped(function* () {
        yield* acquired("release-1.4");
        const next = JSON.parse(yield* readTextFile(sidecars.descriptor));
        expect(next.generation).not.toBe(JSON.parse(published).generation);
      });
    });
  });

  it("WLA3: a foreign, fabricated or closed lease authorizes nothing", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun({ runId: "release-1.4" });
    });

    yield* withLifecycle(root, function* () {
      let closed: ExecutorLease | undefined;
      yield* scoped(function* () {
        closed = leaseOf(yield* acquired("release-1.4"));
      });
      expect(closed).toBeDefined();

      // Shaped exactly like the real thing, and issued by nobody.
      const fabricated: ExecutorLease = { runId: "release-1.4" };
      expect(fabricated).toEqual(closed);
      // Structural equality is not identity, which is the whole point: a
      // transition asks the provider which object this is, never what it holds.
      expect(fabricated).not.toBe(closed);
    });
  });

  it("WLA4: a second process is refused, and the lock outlives nothing", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      yield* createRun({ runId: "release-1.4" });
    });

    yield* withLifecycle(root, function* () {
      yield* scoped(function* () {
        yield* acquired("release-1.4");
        // A real second process, because a lock this host respects and the
        // operating system does not is not a lock.
        const refused = yield* holder(root, "release-1.4");
        expect(refused).toBe("already-running");
      });

      // Released with the scope, so the same second process now owns it.
      expect(yield* holder(root, "release-1.4")).toBe("acquired");
    });
  });
});

/** What one separate process makes of this run's lock, right now. */
function* holder(root: string, runId: string): Operation<string> {
  const result = yield* exec(Deno.execPath(), {
    arguments: ["run", "-A", HOLDER, root, runId],
  }).join();
  if (result.code !== 0) {
    throw new Error(`the holder process failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
