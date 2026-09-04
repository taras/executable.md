/**
 * One interactive child that inherits this process's terminal.
 *
 * Derived from the native launcher in `packages/runtime/launcher.ts`, with the
 * two facts the pane-worker topology needs separated out:
 *
 * - readiness is the child-process `spawn` event and nothing earlier. A pid
 *   from `forkpty` is not it, and neither is a pane that shows output; the
 *   `error` event for a missing executable arrives instead of `spawn`, never
 *   after it;
 * - settlement is the `exit` event, reported as an exact code or signal, and
 *   is independent of readiness — a child that starts and exits 1 at once is
 *   both ready and settled.
 *
 * Teardown is owned by the scope the resource was created in. `stop()` runs
 * the same escalation on demand and returns what it established, because a
 * worker has to send that proof over IPC before its own scope closes; the
 * `ensure` runs it again on cancellation and finds nothing left to do.
 *
 * The child shares this process's process group, so a `^C` on the pane reaches
 * both — the worker handles that by ignoring the signal itself. Sharing is
 * deliberate: `detached: true` would `setsid()` the child away from the pane's
 * controlling terminal, and job control is the point of the pane.
 */

import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { ensure, Err, Ok, resource, sleep, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { deliver, descendantsOf, groupMembers, isReachable, processTable } from "./processes.ts";
import type { Delivery, ProcessRow } from "./processes.ts";

export interface InteractiveRequest {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ProcessOutcome {
  exitCode?: number;
  signal?: string;
}

export class StartupFailure extends Error {
  override name = "StartupFailure";
  constructor(readonly code: string) {
    super(`the interactive child could not be started (${code})`);
  }
}

export interface DescendantOutcome {
  pid: number;
  command: string;
  /** Whether it shared the child's process group. */
  inGroup: boolean;
  delivery: Delivery;
  gone: boolean;
}

/** What escalation established, in the order it was established. */
export interface QuiescenceProof {
  method: "exited" | "interrupted" | "killed";
  childPid: number | undefined;
  childGone: boolean;
  descendants: DescendantOutcome[];
  /** Pids that could still be reached when the proof was written. */
  survivors: number[];
}

export interface InteractiveProcess {
  /** `Ok(pid)` once the kernel has the child; `Err` if it never will. */
  ready: Operation<Result<number>>;
  /** Settles only after `ready` succeeded. */
  exited: Operation<ProcessOutcome>;
  /** Idempotent: a second call after the first returns the same proof. */
  stop(): Operation<QuiescenceProof>;
}

const INTERRUPT_GRACE_MS = 2_000;
const KILL_SETTLE_MS = 500;
const POLL_MS = 25;

export function useInteractiveProcess(request: InteractiveRequest): Operation<InteractiveProcess> {
  return resource(function* (provide) {
    const [command, ...args] = request.command;
    if (command === undefined) {
      throw new Error("interactive process: command must not be empty");
    }
    const ready = withResolvers<Result<number>>();
    const exited = withResolvers<ProcessOutcome>();
    let child: ChildProcess | undefined;
    let outcome: ProcessOutcome | undefined;
    let stopping: ReturnType<typeof withResolvers<QuiescenceProof>> | undefined;

    // One escalation, however many callers: a worker's cancel and its own
    // exit-watching task can both ask while the first is still in flight.
    function* stop(): Operation<QuiescenceProof> {
      if (stopping) {
        return yield* stopping.operation;
      }
      stopping = withResolvers<QuiescenceProof>();
      try {
        const proof =
          child === undefined || child.pid === undefined
            ? {
                method: "exited" as const,
                childPid: undefined,
                childGone: true,
                descendants: [],
                survivors: [],
              }
            : yield* escalate(child, child.pid, process.pid, () => outcome !== undefined);
        stopping.resolve(proof);
        return proof;
      } catch (error) {
        stopping.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }

    // Registered before the spawn: a halt between acquiring a process and
    // registering its cleanup would leak the process.
    yield* ensure(function* () {
      yield* stop();
    });

    child = spawnChild(command, args, {
      cwd: request.cwd,
      env: request.env,
      stdio: "inherit",
    });
    child.once("spawn", () => {
      if (child?.pid !== undefined) {
        ready.resolve(Ok(child.pid));
      }
    });
    child.once("error", (error: Error & { code?: string }) => {
      ready.resolve(Err(new StartupFailure(error.code ?? error.message)));
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      const settled: ProcessOutcome = {};
      if (code !== null) {
        settled.exitCode = code;
      }
      if (signal !== null) {
        settled.signal = signal;
      }
      outcome = settled;
      exited.resolve(settled);
    });

    yield* provide({ ready: ready.operation, exited: exited.operation, stop });
  });
}

/**
 * Interrupt, then insist, then reach the descendants the interrupt left.
 *
 * The descendant snapshot is taken before the first signal: a child that is
 * killed stops being anyone's parent, and its children reparent to init, where
 * an ancestry walk no longer finds them. A descendant that leaves the process
 * group with `setsid()` is still in that snapshot while its parent lives; one
 * created after the snapshot is not, and this proof says so rather than
 * claiming otherwise.
 */
function* escalate(
  child: ChildProcess,
  pid: number,
  self: number | undefined,
  hasExited: () => boolean,
): Operation<QuiescenceProof> {
  const before = yield* processTable();
  // The child shares this process's group, so the group is looked up rather
  // than assumed to be the child's own pid.
  const group = before.find((row) => row.pid === pid)?.pgid ?? pid;
  const related = new Map<number, ProcessRow>();
  for (const row of descendantsOf(before, pid)) {
    related.set(row.pid, row);
  }
  for (const row of groupMembers(before, group)) {
    if (row.pid !== pid && row.pid !== self) {
      related.set(row.pid, row);
    }
  }

  let method: QuiescenceProof["method"] = "exited";
  if (!hasExited() && isReachable(pid)) {
    method = "interrupted";
    deliver(pid, "SIGINT");
    const left = yield* waitUntil(() => hasExited() || !isReachable(pid), INTERRUPT_GRACE_MS);
    if (!left) {
      method = "killed";
      const fatal = deliver(pid, "SIGKILL");
      const gone = yield* waitUntil(() => hasExited() || !isReachable(pid), KILL_SETTLE_MS);
      if (!gone && fatal !== "delivered" && fatal !== "absent") {
        throw new Error(`could not establish that process ${pid} stopped: SIGKILL was ${fatal}`);
      }
    }
  }
  // Deno's `node:child_process` holds the runtime open on a handle it will
  // never settle once a signal the child ignored has been delivered.
  try {
    child.unref();
  } catch {
    // Already released.
  }

  const descendants: DescendantOutcome[] = [];
  for (const row of related.values()) {
    const delivery = deliver(row.pid, "SIGKILL");
    descendants.push({
      pid: row.pid,
      command: row.command,
      inGroup: row.pgid === group,
      delivery,
      gone: false,
    });
  }
  yield* waitUntil(() => descendants.every((entry) => !isReachable(entry.pid)), KILL_SETTLE_MS);
  for (const entry of descendants) {
    entry.gone = !isReachable(entry.pid);
  }
  const survivors = descendants.filter((entry) => !entry.gone).map((entry) => entry.pid);
  const childGone = hasExited() || !isReachable(pid);
  if (!childGone) {
    survivors.unshift(pid);
  }
  return { method, childPid: pid, childGone, descendants, survivors };
}

function* waitUntil(condition: () => boolean, limitMs: number): Operation<boolean> {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      return false;
    }
    yield* sleep(POLL_MS);
  }
  return true;
}
