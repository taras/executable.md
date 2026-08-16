/**
 * Who may advance a run, on this host.
 *
 * A workflow executor takes an exclusive advisory lock on a file beside the
 * run's database and holds it open for as long as its scope lives. The operating
 * system enforces it, which is the whole point: a host that dies — killed, crashed,
 * unplugged — runs no cleanup, and the kernel releases its lock anyway. That
 * released lock is the only evidence the next acquisition accepts that the
 * previous workflow executor is gone. Nothing here infers staleness from a PID, a timestamp,
 * a timeout or a status column, because every one of those can describe a
 * process that is still running.
 *
 * ## Refusing is not waiting
 *
 * Acquisition is non-blocking. `tryLockSync` answers `false` immediately when
 * another process holds the lock, and the caller is told the run is already
 * running rather than being queued behind a workflow executor it cannot see.
 * Waiting would turn "somebody else is executing this" into a hang.
 *
 * ## The executor lock is identity, not shape
 *
 * What a transition checks is *this exact object*, registered here when the lock
 * was taken: its identity, that its scope is still open, and that it belongs to
 * this run. A value shaped like an executor lock authorizes nothing, and neither
 * does a run id or a path.
 *
 * ## Nothing addresses a live workflow executor
 *
 * There is no control channel here, and no way to ask a running executor to
 * stop. The foreground process that owns a run's Effection scope owns the only
 * supported way to halt it, which is interruption. Cancellation is for runs
 * with no live workflow executor, and it takes this same lock before it changes
 * anything.
 */

import { ensure, type Operation, resource } from "effection";
import { ensureDir } from "@effectionx/fs";
import { dirname } from "node:path";
import type { ExecutorLock } from "../lifecycle/api.ts";
import { WorkflowRequestError } from "../storage/errors.ts";
import { workflowRunLock } from "./path.ts";

/**
 * The open lock file this host holds, as much of it as this module uses.
 *
 * Named here rather than referred to as `Deno.FsFile` because this file
 * typechecks under the Node project like every other source, and that project
 * has no `Deno` namespace to name. Every other Deno-only capability in this
 * adapter arrives through a cross-runtime package; advisory locking is the one
 * with no such wrapper, so the shape it needs is stated and reached through the
 * global — a Deno-only adapter naming exactly the Deno it depends on.
 */
interface LockFile {
  tryLockSync(exclusive: boolean): boolean;
  unlockSync(): void;
  close(): void;
}

interface LockingRuntime {
  openSync(path: string, options: { read: boolean; write: boolean; create: boolean }): LockFile;
}

/**
 * Whether the global this host found is one that opens files.
 *
 * Asked rather than assumed. Describing the global's type at the point of use
 * would be this module telling its own typechecker what is out there — a claim
 * the compiler accepts and nothing verifies, which is exactly backwards for a
 * value that arrives from outside every module in this project. So the one
 * property this adapter depends on is checked, and the answer is what narrows.
 *
 * It cannot check further than one call deep: what `openSync` returns is only
 * knowable by calling it. That is the honest boundary of a runtime reached
 * through a global, and it is why the interface above is kept to the three
 * methods this module actually uses.
 */
function opensFiles(candidate: unknown): candidate is LockingRuntime {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof Reflect.get(candidate, "openSync") === "function"
  );
}

function locking(): LockingRuntime {
  const runtime: unknown = Reflect.get(globalThis, "Deno");
  if (!opensFiles(runtime)) {
    throw new WorkflowRequestError(
      "this host takes a run's executor lock through the Deno runtime, and no Deno runtime that " +
        "opens files is present.",
    );
  }
  return runtime;
}

/**
 * One executor-lock acquisition, as this host keeps it.
 *
 * The public `ExecutorLock` is one field wide and describes the
 * acquisition; this hold is what the provider checks against. It never leaves
 * the installation.
 */
export interface ExecutorLockHold {
  readonly lock: ExecutorLock;
  readonly runId: string;
  readonly file: LockFile;
  open: boolean;
  /**
   * The execution this acquisition began, once it has begun one.
   *
   * An acquisition begins at most one. The architecture's premise — that an
   * unfinished execution belongs to a *previous* workflow executor and is
   * therefore proven stale — holds only for the first begin under a hold; a
   * second would find this workflow executor's own live execution and reconcile
   * it away.
   */
  execution?: string;
}

/**
 * The executor locks this installation issued.
 *
 * A `WeakSet` keyed by the public object: membership is identity, so a
 * structural copy of a lock is not in it however carefully it was built. It
 * lives in the provider's closure rather than at module scope, so each lock
 * belongs to one installation and nothing accumulates between runs.
 */
export interface ExecutorLockRegistry {
  /** Take the lock for `runId`, or report that a live workflow executor holds it. */
  acquire(root: string, runId: string): Operation<ExecutorLockHold | undefined>;
  /**
   * The hold this exact lock stands for, or a refusal naming why it is not one.
   *
   * `runId` is compared only when the caller named one of its own — a request
   * says which run it means, and a lock for a different one must not answer for
   * it. Asking the lock which run it names and then comparing that
   * against itself would check nothing.
   */
  authorize(lock: ExecutorLock, runId?: string): ExecutorLockHold;
  /** Whether this installation still holds the executor lock for `runId`. */
  holds(runId: string): boolean;
}

export function createExecutorLockRegistry(): ExecutorLockRegistry {
  const issued = new WeakSet<ExecutorLock>();
  const holds = new Map<ExecutorLock, ExecutorLockHold>();

  function authorize(lock: ExecutorLock, runId?: string): ExecutorLockHold {
    if (typeof lock !== "object" || lock === null || !issued.has(lock)) {
      throw new WorkflowRequestError(
        "the executor lock is foreign or fabricated: only the lock this provider issued for " +
          "this acquisition authorizes a lifecycle transition.",
      );
    }
    const hold = holds.get(lock);
    if (hold === undefined || !hold.open) {
      throw new WorkflowRequestError(
        "the executor lock belongs to a scope that has ended, so another workflow executor " +
          "may already hold the run's lock.",
      );
    }
    if (runId !== undefined && hold.runId !== runId) {
      throw new WorkflowRequestError(
        "the executor lock was acquired for a different workflow run.",
      );
    }
    return hold;
  }

  return {
    acquire(root: string, runId: string): Operation<ExecutorLockHold | undefined> {
      return resource<ExecutorLockHold | undefined>(function* (provide) {
        const lock = workflowRunLock(root, runId);
        yield* ensureDir(dirname(lock));

        // Created if absent and never unlinked while a workflow executor holds it:
        // unlinking a locked file lets the next caller create and lock a
        // different file at the same path while this lock is still held.
        const file = locking().openSync(lock, { read: true, write: true, create: true });
        let locked = false;
        try {
          locked = file.tryLockSync(true);
        } catch (error) {
          file.close();
          throw error;
        }
        if (!locked) {
          file.close();
          yield* provide(undefined);
          return;
        }

        const hold: ExecutorLockHold = {
          lock: Object.freeze({ runId }),
          runId,
          file,
          open: true,
        };
        issued.add(hold.lock);
        holds.set(hold.lock, hold);

        // Registered as soon as the lock is held, so a failure between here and
        // the caller's first transition still releases it.
        yield* ensure(() => {
          hold.open = false;
          holds.delete(hold.lock);
          try {
            file.unlockSync();
          } finally {
            file.close();
          }
        });

        yield* provide(hold);
      });
    },

    authorize,

    holds(runId: string): boolean {
      for (const hold of holds.values()) {
        if (hold.open && hold.runId === runId) {
          return true;
        }
      }
      return false;
    },
  };
}
