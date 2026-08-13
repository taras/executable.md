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
 * was taken: its identity, that its scope is still open, that it belongs to this
 * run, and that its generation is the one currently published. A value shaped
 * like a lease authorizes nothing, and neither does a run id, a path or a
 * retained descriptor.
 *
 * ## Generations address an owner, and only that owner
 *
 * Each acquisition publishes a fresh random generation. A cancellation request
 * names the generation it was written for, so a request left behind by a dead
 * owner cannot reach the next one — it is reconciled or cleared before the new
 * generation is published, never carried across.
 */

import { randomUUID } from "node:crypto";
import { ensure, type Operation, resource } from "effection";
import { ensureDir, exists, readTextFile, rm } from "@effectionx/fs";
import { dirname } from "node:path";
import type { ExecutorLease } from "../lifecycle/api.ts";
import { WorkflowRequestError } from "../storage/errors.ts";
import { workflowRunSidecars } from "./path.ts";
import { writeAtomically } from "./atomic.ts";

/**
 * One acquisition's authority, as this host keeps it.
 *
 * The public `ExecutorLease` is one field wide and describes the lease; this is
 * what the provider checks against. It never leaves the installation.
 */
export interface ExecutorHold {
  readonly lease: ExecutorLease;
  readonly runId: string;
  /** Fresh per acquisition, published only after the lock was taken. */
  readonly generation: string;
  readonly file: Deno.FsFile;
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

/** What the descriptor beside a run says about its live owner. */
export interface ControlDescriptor {
  readonly runId: string;
  readonly generation: string;
}

/** One request addressed to one exact executor generation. */
export interface ControlRequest {
  readonly runId: string;
  readonly generation: string;
  readonly requestId: string;
  readonly kind: "cancel";
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
        const sidecars = workflowRunSidecars(root, runId);
        yield* ensureDir(dirname(sidecars.lock));

        // Created if absent and never unlinked while a lease may hold it:
        // unlinking a locked file lets the next caller create and lock a
        // different file at the same path while this lease still exists.
        const file = Deno.openSync(sidecars.lock, { read: true, write: true, create: true });
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
          generation: randomUUID(),
          file,
          open: true,
        };
        issued.add(hold.lease);
        holds.set(hold.lease, hold);

        // Registered before the descriptor is published, so a failure between
        // here and the caller's first transition still releases the lock and
        // leaves no descriptor claiming a live owner.
        yield* ensure(function* () {
          hold.open = false;
          holds.delete(hold.lease);
          // Cleared before the lock goes: a descriptor outliving its lock is
          // stale data, and the window where both look valid is this one.
          yield* clearControl(sidecars.descriptor);
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

/** Publish who owns this run now. Replaces whatever the last owner left. */
export function* publishControl(root: string, hold: ExecutorHold): Operation<void> {
  const sidecars = workflowRunSidecars(root, hold.runId);
  const descriptor: ControlDescriptor = { runId: hold.runId, generation: hold.generation };
  yield* writeAtomically(sidecars.descriptor, `${JSON.stringify(descriptor)}\n`);
}

function* clearControl(path: string): Operation<void> {
  if (yield* exists(path)) {
    yield* rm(path);
  }
}

/** The descriptor a run currently publishes, or nothing when none is published. */
export function* readControl(
  root: string,
  runId: string,
): Operation<ControlDescriptor | undefined> {
  const sidecars = workflowRunSidecars(root, runId);
  if (!(yield* exists(sidecars.descriptor))) {
    return undefined;
  }
  return parseDescriptor(yield* readTextFile(sidecars.descriptor), runId);
}

/** Address one request to the generation named by `descriptor`. */
export function* writeRequest(
  root: string,
  descriptor: ControlDescriptor,
): Operation<ControlRequest> {
  const sidecars = workflowRunSidecars(root, descriptor.runId);
  const request: ControlRequest = {
    runId: descriptor.runId,
    generation: descriptor.generation,
    requestId: randomUUID(),
    kind: "cancel",
  };
  yield* writeAtomically(sidecars.request, `${JSON.stringify(request)}\n`);
  return request;
}

/** The request a run currently holds, or nothing when it holds none. */
export function* readRequest(root: string, runId: string): Operation<ControlRequest | undefined> {
  const sidecars = workflowRunSidecars(root, runId);
  if (!(yield* exists(sidecars.request))) {
    return undefined;
  }
  return parseRequest(yield* readTextFile(sidecars.request), runId);
}

/** Take the request away, whether it was answered or found stale. */
export function* clearRequest(root: string, runId: string): Operation<void> {
  const sidecars = workflowRunSidecars(root, runId);
  if (yield* exists(sidecars.request)) {
    yield* rm(sidecars.request);
  }
}

/** Remove every control sidecar. The lock file stays, empty. */
export function* clearControlState(root: string, runId: string): Operation<void> {
  const sidecars = workflowRunSidecars(root, runId);
  yield* clearControl(sidecars.descriptor);
  yield* clearRequest(root, runId);
}

/**
 * A sidecar is host arrangement, and anything can write to it.
 *
 * Unparseable content is treated as no descriptor rather than as a descriptor
 * with unknown fields: a control file that does not describe this run cannot
 * address anything, and refusing to read it would leave a run permanently
 * unownable because of a file that is not run state at all.
 */
function parseDescriptor(text: string, runId: string): ControlDescriptor | undefined {
  const parsed = parseObject(text);
  if (parsed === undefined) {
    return undefined;
  }
  const generation = parsed["generation"];
  if (parsed["runId"] !== runId || typeof generation !== "string" || generation === "") {
    return undefined;
  }
  return Object.freeze({ runId, generation });
}

function parseRequest(text: string, runId: string): ControlRequest | undefined {
  const parsed = parseObject(text);
  if (parsed === undefined) {
    return undefined;
  }
  const generation = parsed["generation"];
  const requestId = parsed["requestId"];
  if (parsed["runId"] !== runId || parsed["kind"] !== "cancel") {
    return undefined;
  }
  if (typeof generation !== "string" || generation === "" || typeof requestId !== "string") {
    return undefined;
  }
  return Object.freeze({ runId, generation, requestId, kind: "cancel" });
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return Object.fromEntries(Object.entries(value));
  } catch {
    return undefined;
  }
}
