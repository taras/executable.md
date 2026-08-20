/**
 * The exclusive file locks this host takes beside a run.
 *
 * Two callers need one, and they need opposite answers to the same question.
 * A workflow executor asks "may I advance this run", and being told to wait
 * would turn "somebody else is executing it" into a hang, so its acquisition
 * refuses immediately. Recovery coordination asks "may I touch this database
 * and its journal as a pair", where the other holder is finishing in
 * milliseconds and refusing would fail an inspection that only had to wait.
 * Both are the same operating-system primitive, so the file shape, the runtime
 * narrowing and the release live here once and each acquisition states its own
 * waiting behavior.
 *
 * Neither unlinks its file. Unlinking a locked path lets the next caller create
 * and lock a different file at the same name while this lock is still held, so
 * the sidecar is created if absent and then left, empty, for whoever comes next.
 *
 * The kernel is what makes this survive a lost host. A process that is killed
 * runs no cleanup, and the operating system releases its locks anyway; that
 * released lock is the only evidence an acquisition accepts that the previous
 * holder is gone.
 */

import { ensure, type Operation, resource, sleep } from "effection";
import { ensureDir } from "@effectionx/fs";
import { dirname } from "node:path";
import { WorkflowRequestError } from "../storage/errors.ts";

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
export interface AdvisoryLockFile {
  tryLockSync(exclusive: boolean): boolean;
  unlockSync(): void;
  close(): void;
}

interface LockingRuntime {
  openSync(
    path: string,
    options: { read: boolean; write: boolean; create: boolean },
  ): AdvisoryLockFile;
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
      "this host takes a run's advisory lock through the Deno runtime, and no Deno runtime that " +
        "opens files is present.",
    );
  }
  return runtime;
}

/** How long a waiting acquisition rests before asking again. */
const RETRY_INTERVAL = 10;

function release(file: AdvisoryLockFile): void {
  try {
    file.unlockSync();
  } finally {
    file.close();
  }
}

/**
 * Take the exclusive lock at `path`, or report that another holder has it.
 *
 * The file is closed immediately when the lock is refused: a descriptor that
 * holds nothing has nothing to release, and keeping it open until the scope
 * ends would make a refusal cost the caller a handle it never acquired.
 */
export function useAdvisoryLock(path: string): Operation<AdvisoryLockFile | undefined> {
  return resource<AdvisoryLockFile | undefined>(function* (provide) {
    yield* ensureDir(dirname(path));

    const file = locking().openSync(path, { read: true, write: true, create: true });
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

    yield* ensure(() => release(file));
    yield* provide(file);
  });
}

/**
 * Wait for the exclusive lock at `path`, asking again until it is free.
 *
 * Waiting is cooperative on purpose. `lockSync` would block the whole
 * interpreter, so nothing else in this process — including the owner this
 * caller is waiting for, and including a cancellation aimed at this scope —
 * would make progress until the host returned. Sleeping between attempts keeps
 * every one of those live.
 *
 * The release is registered before the file is opened, so no acquisition and no
 * cancellation of the wait can leave an open or locked file nothing owns.
 */
export function useWaitingAdvisoryLock(path: string): Operation<void> {
  return resource<void>(function* (provide) {
    yield* ensureDir(dirname(path));

    let file: AdvisoryLockFile | undefined;
    let locked = false;
    yield* ensure(() => {
      if (file === undefined) {
        return;
      }
      if (locked) {
        release(file);
      } else {
        file.close();
      }
    });

    file = locking().openSync(path, { read: true, write: true, create: true });
    while (!locked) {
      locked = file.tryLockSync(true);
      if (!locked) {
        yield* sleep(RETRY_INTERVAL);
      }
    }

    yield* provide(undefined);
  });
}
