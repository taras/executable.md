/**
 * Who may advance a run, on this host.
 *
 * A lease is an exclusive advisory lock on a file beside the run's database,
 * held open for as long as the lease's scope lives. The operating system is what
 * enforces it, which is the whole point: a host that dies — killed, crashed,
 * unplugged — runs no cleanup, and the kernel releases its lock anyway. That
 * released lock is the only evidence the next acquisition accepts that the
 * previous owner is gone. Nothing here infers staleness from a PID, a timestamp,
 * a timeout or a status column, because every one of those can describe a
 * process that is still running.
 *
 * ## Refusing is not waiting
 *
 * Acquisition is non-blocking. `tryLockSync` answers `false` immediately when
 * another process holds the lock, and the caller is told the run is already
 * running rather than being queued behind an owner it cannot see. Waiting would
 * turn "somebody else owns this" into a hang.
 *
 * ## The lease is the authority; its shape is not
 *
 * What a transition checks is *this exact object*, registered here when the lock
 * was taken: its identity, that its scope is still open, and that it belongs to
 * this run. A value shaped like a lease authorizes nothing, and neither does a
 * run id or a path.
 *
 * ## Nothing addresses a live owner
 *
 * There is no control channel here, and no way to ask a running executor to
 * stop. The foreground process that owns a run's Effection scope owns the only
 * supported way to halt it, which is interruption. Cancellation is for runs
 * with no owner, and it takes this same lock before it changes anything.
 */

import { ensure, type Operation, resource } from "effection";
import { ensureDir } from "@effectionx/fs";
import { dirname } from "node:path";
import type { ExecutorLease } from "../lifecycle/api.ts";
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
 * One acquisition's authority, as this host keeps it.
 *
 * The public `ExecutorLease` is one field wide and describes the lease; this is
 * what the provider checks against. It never leaves the installation.
 */
export interface ExecutorHold {
  readonly lease: ExecutorLease;
  readonly runId: string;
  readonly file: LockFile;
  open: boolean;
  /**
   * The execution this acquisition began, once it has begun one.
   *
   * An acquisition begins at most one. The architecture's premise — that an
   * unfinished execution belongs to a *previous* lease and is therefore proven
   * stale — holds only for the first begin under a hold; a second would find
   * this owner's own live execution and reconcile it away.
   */
  execution?: string;
}

/**
 * The leases this installation issued.
 *
 * A `WeakSet` keyed by the public object: membership is identity, so a
 * structural copy of a lease is not in it however carefully it was built. It
 * lives in the provider's closure rather than at module scope, so leases belong
 * to one installation and nothing accumulates between runs.
 */
export interface ExecutorRegistry {
  /** Take the lock for `runId`, or report that a live executor holds it. */
  acquire(root: string, runId: string): Operation<ExecutorHold | undefined>;
  /**
   * The hold this exact lease stands for, or a refusal naming why it is not one.
   *
   * `runId` is compared only when the caller named one of its own — a request
   * says which run it means, and a lease that owns a different one must not
   * answer for it. Asking the lease which run it owns and then comparing that
   * against itself would check nothing.
   */
  authorize(lease: ExecutorLease, runId?: string): ExecutorHold;
  /** Whether any lease this installation issued is still open for `runId`. */
  holds(runId: string): boolean;
}

export function createExecutorRegistry(): ExecutorRegistry {
  const issued = new WeakSet<ExecutorLease>();
  const holds = new Map<ExecutorLease, ExecutorHold>();

  function authorize(lease: ExecutorLease, runId?: string): ExecutorHold {
    if (typeof lease !== "object" || lease === null || !issued.has(lease)) {
      throw new WorkflowRequestError(
        "the executor lease is foreign or fabricated: only the lease this provider issued for " +
          "this acquisition authorizes a lifecycle transition.",
      );
    }
    const hold = holds.get(lease);
    if (hold === undefined || !hold.open) {
      throw new WorkflowRequestError(
        "the executor lease belongs to a scope that has ended, so the run it held may already " +
          "have another owner.",
      );
    }
    if (runId !== undefined && hold.runId !== runId) {
      throw new WorkflowRequestError(
        "the executor lease was acquired for a different workflow run.",
      );
    }
    return hold;
  }

  return {
    acquire(root: string, runId: string): Operation<ExecutorHold | undefined> {
      return resource<ExecutorHold | undefined>(function* (provide) {
        const lock = workflowRunLock(root, runId);
        yield* ensureDir(dirname(lock));

        // Created if absent and never unlinked while a lease may hold it:
        // unlinking a locked file lets the next caller create and lock a
        // different file at the same path while this lease still exists.
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

        const hold: ExecutorHold = {
          lease: Object.freeze({ runId }),
          runId,
          file,
          open: true,
        };
        issued.add(hold.lease);
        holds.set(hold.lease, hold);

        // Registered as soon as the lock is held, so a failure between here and
        // the caller's first transition still releases it.
        yield* ensure(() => {
          hold.open = false;
          holds.delete(hold.lease);
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
