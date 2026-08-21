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
import type { ExecutorLock } from "../lifecycle/api.ts";
import { WorkflowRequestError } from "../storage/errors.ts";
import { workflowRunLock } from "./path.ts";
import { useAdvisoryLock } from "./advisory-lock.ts";

/**
 * One executor-lock acquisition, as this host keeps it.
 *
 * The public `ExecutorLock` is one field wide and describes the
 * acquisition; this hold is what the provider checks against. It never leaves
 * the installation. The open file is not among its fields: the acquisition
 * beneath owns the descriptor and releases it, and a second reference here
 * would describe ownership this record does not have.
 */
export interface ExecutorLockHold {
  readonly lock: ExecutorLock;
  readonly runId: string;
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
        // Refused rather than queued: waiting here would turn "another workflow
        // executor holds this run" into a hang.
        const file = yield* useAdvisoryLock(workflowRunLock(root, runId));
        if (file === undefined) {
          yield* provide(undefined);
          return;
        }

        const hold: ExecutorLockHold = {
          lock: Object.freeze({ runId }),
          runId,
          open: true,
        };
        issued.add(hold.lock);
        holds.set(hold.lock, hold);

        // Registered as soon as the lock is held, so a failure between here and
        // the caller's first transition still retires it. It runs before the
        // acquisition beneath releases the file, so no lock is ever open to the
        // operating system while this registry still answers for it.
        yield* ensure(() => {
          hold.open = false;
          holds.delete(hold.lock);
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
