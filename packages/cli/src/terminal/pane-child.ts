/**
 * One interactive child in a pane, and what its settlement establishes
 * (architecture.md §Interactive terminal grids).
 *
 * Two facts the pane topology needs kept apart:
 *
 * - **readiness** is the runtime's `spawn` event and nothing earlier. A pid is
 *   not it, and neither is a pane that has shown output; a missing executable
 *   delivers `error` *instead of* `spawn`, never after it. This is what a grid's
 *   attach barrier waits for.
 * - **settlement** is the escalation and the sweep that follow the child, not
 *   the `exit` event. A child that exited on its own may have left descendants
 *   in its process group, or an orphan still holding the pane's terminal, and
 *   the pane is not free for the next launch until neither is true.
 *
 * The child shares this process's process group deliberately, so `^C` typed in
 * the pane reaches it: `detached: true` would `setsid()` it away from the
 * pane's controlling terminal, and job control is the point of a pane. The
 * worker ignores those signals itself so the child is the one interrupted.
 */

import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { ensure, Err, Ok, resource, sleep, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import {
  deliverSignal,
  descendantsOf,
  groupMembers,
  processReachable,
  processTable,
  terminalHolders,
} from "@executablemd/runtime";
import type { Settlement } from "./pane-protocol.ts";

export interface PaneChildRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface PaneChildOutcome {
  exitCode?: number;
  signal?: string;
}

export class PaneStartFailure extends Error {
  override name = "PaneStartFailure";
  constructor(readonly code: string) {
    super(`the pane's child could not be started (${code})`);
  }
}

export interface PaneChild {
  /** `Ok(pid)` once the runtime reports the spawn; `Err` if it never will. */
  readonly started: Operation<Result<number>>;
  /** Settles when the child exits. Independent of `started`. */
  readonly exited: Operation<PaneChildOutcome>;
  /** Idempotent: every caller of the one settlement gets the same answer. */
  settle(): Operation<Settlement>;
}

const INTERRUPT_GRACE_MS = 2_000;
const KILL_SETTLE_MS = 500;
const POLL_MS = 25;

/**
 * Start one child with the pane's terminal inherited, and own its settlement.
 *
 * `tty` is the pane's terminal device, when the worker has one. The sweep needs
 * it: a descendant that called `setsid()` and outlived its parent is outside
 * the process snapshot, and holding the terminal open is the only way it is
 * still observable.
 */
export function usePaneChild(
  request: PaneChildRequest,
  tty: string | undefined,
): Operation<PaneChild> {
  return resource(function* (provide) {
    const [command, ...args] = request.argv;
    if (command === undefined) {
      throw new Error("a pane launch names no command");
    }
    const started = withResolvers<Result<number>>();
    const exited = withResolvers<PaneChildOutcome>();
    let child: ChildProcess | undefined;
    let outcome: PaneChildOutcome | undefined;
    let settling: ReturnType<typeof withResolvers<Settlement>> | undefined;

    function* settle(): Operation<Settlement> {
      if (settling) {
        return yield* settling.operation;
      }
      settling = withResolvers<Settlement>();
      try {
        const nothingStarted: Settlement = {
          method: "exited",
          quiet: true,
          swept: [],
          holders: [],
        };
        const settlement =
          child === undefined || child.pid === undefined
            ? nothingStarted
            : yield* escalate(child, child.pid, tty, () => outcome !== undefined);
        settling.resolve(settlement);
        return settlement;
      } catch (error) {
        settling.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }

    // Registered before the spawn: a halt between acquiring a process and
    // registering its cleanup leaks the process.
    yield* ensure(function* () {
      yield* settle();
    });

    child = spawnChild(command, args, {
      cwd: request.cwd,
      env: request.env,
      // The whole point of a pane: the child reads this terminal and draws on
      // it directly, so nothing between it and the reader can buffer, reorder
      // or capture what passes.
      stdio: "inherit",
    });
    child.once("spawn", () => {
      if (child?.pid !== undefined) {
        started.resolve(Ok(child.pid));
      }
    });
    child.once("error", (error: Error & { code?: string }) => {
      started.resolve(Err(new PaneStartFailure(error.code ?? error.message)));
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      const settled: PaneChildOutcome = {};
      if (code !== null) {
        settled.exitCode = code;
      }
      if (signal !== null) {
        settled.signal = signal;
      }
      outcome = settled;
      exited.resolve(settled);
    });

    yield* provide({ started: started.operation, exited: exited.operation, settle });
  });
}

/**
 * Interrupt, insist, then reach whatever the interrupt left behind.
 *
 * The snapshot is taken before the first signal, and that order is the whole
 * proof: a killed child stops being anyone's parent and its children reparent
 * to init, where an ancestry walk no longer finds them. A descendant that left
 * the group with `setsid()` is in the snapshot while its parent lives; one
 * created after the snapshot is not, and this says so rather than claiming
 * otherwise.
 */
function* escalate(
  child: ChildProcess,
  pid: number,
  tty: string | undefined,
  hasExited: () => boolean,
): Operation<Settlement> {
  const before = yield* processTable();
  // The child shares this process's group, so the group is looked up rather
  // than assumed to be the child's own pid.
  const group = before.find((row) => row.pid === pid)?.pgid ?? pid;
  // Never anything this worker came from. In a pane the worker is the session
  // leader, so its group holds nothing above it — but a settlement that could
  // reach an ancestor would be one signal away from killing the run that
  // started the grid, and that is not a thing to leave to the topology being
  // what it should be.
  const forebears = ancestorsOf(before, process.pid);
  const related = new Map<number, number>();
  for (const row of descendantsOf(before, pid)) {
    if (!forebears.has(row.pid)) {
      related.set(row.pid, row.pid);
    }
  }
  for (const row of groupMembers(before, group)) {
    if (row.pid !== pid && row.pid !== process.pid && !forebears.has(row.pid)) {
      related.set(row.pid, row.pid);
    }
  }

  let method: Settlement["method"] = "exited";
  if (!hasExited() && (yield* processReachable(pid))) {
    method = "interrupted";
    yield* deliverSignal(pid, "SIGINT");
    const left = yield* waitFor(function* () {
      return hasExited() || !(yield* processReachable(pid));
    }, INTERRUPT_GRACE_MS);
    if (!left) {
      method = "killed";
      const fatal = yield* deliverSignal(pid, "SIGKILL");
      const gone = yield* waitFor(function* () {
        return hasExited() || !(yield* processReachable(pid));
      }, KILL_SETTLE_MS);
      if (!gone && fatal !== "delivered" && fatal !== "absent") {
        throw new Error(`could not establish that process ${pid} stopped: SIGKILL was ${fatal}`);
      }
    }
  }
  // Deno's `node:child_process` holds the runtime open on a handle it never
  // settles once a signal the child ignored has been delivered.
  try {
    child.unref();
  } catch {
    // Already released.
  }

  for (const member of related.keys()) {
    yield* deliverSignal(member, "SIGKILL");
  }
  yield* waitFor(function* () {
    for (const member of related.keys()) {
      if (yield* processReachable(member)) {
        return false;
      }
    }
    return true;
  }, KILL_SETTLE_MS);
  const swept: { pid: number; gone: boolean }[] = [];
  for (const member of related.keys()) {
    swept.push({ pid: member, gone: !(yield* processReachable(member)) });
  }
  if (!(hasExited() || !(yield* processReachable(pid)))) {
    swept.unshift({ pid, gone: false });
  }

  // Whatever still has the pane's terminal open, after everything the snapshot
  // named is gone. This is where an escaped `setsid()` orphan is still visible.
  const holders = yield* sweepHolders(tty);
  const quiet = swept.every((entry) => entry.gone) && holders.every((entry) => entry.gone);
  return { method, quiet, child: pid, swept, holders };
}

/** Clear the pane's terminal of anything but this worker, and report it. */
export function* sweepHolders(
  tty: string | undefined,
): Operation<{ pid: number; gone: boolean }[]> {
  if (tty === undefined || tty === "??") {
    return [];
  }
  const found = (yield* terminalHolders(`/dev/${tty}`)).filter((pid) => pid !== process.pid);
  for (const pid of found) {
    yield* deliverSignal(pid, "SIGKILL");
  }
  yield* waitFor(function* () {
    for (const pid of found) {
      if (yield* processReachable(pid)) {
        return false;
      }
    }
    return true;
  }, KILL_SETTLE_MS);
  const swept: { pid: number; gone: boolean }[] = [];
  for (const pid of found) {
    swept.push({ pid, gone: !(yield* processReachable(pid)) });
  }
  return swept;
}

/** This process and everything it descends from, in one reading of the table. */
function ancestorsOf(table: readonly { pid: number; ppid: number }[], pid: number): Set<number> {
  const found = new Set<number>([pid]);
  let current = table.find((row) => row.pid === pid);
  while (current !== undefined && current.ppid > 0 && !found.has(current.ppid)) {
    found.add(current.ppid);
    const parent: number = current.ppid;
    current = table.find((row) => row.pid === parent);
  }
  return found;
}

function* waitFor(condition: () => Operation<boolean>, limitMs: number): Operation<boolean> {
  const deadline = Date.now() + limitMs;
  while (!(yield* condition())) {
    if (Date.now() >= deadline) {
      return false;
    }
    yield* sleep(POLL_MS);
  }
  return true;
}
