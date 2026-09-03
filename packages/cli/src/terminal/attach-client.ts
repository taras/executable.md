/**
 * The one visible client: the reader's own view of a grid
 * (architecture.md §Interactive terminal grids).
 *
 * Deliberately *not* a pane child. A pane's child is settled by sweeping the
 * pane's process group and the pane's terminal, because a pane's terminal
 * belongs to the grid. This process's terminal belongs to the run: the things
 * holding it are XMD itself, whatever started XMD, and everything else in XMD's
 * foreground process group. A settlement of that shape pointed at this client
 * would be a settlement pointed at the document.
 *
 * So the rule here is narrow and absolute. This ends **one** process — the exact
 * one it started — and nothing else. It signals no group, sweeps no terminal,
 * and follows no descendants. Ending it is asked for first, through tmux, so
 * the client detaches and restores the terminal itself; a signal is what
 * follows only if the ask did not work, and it goes to that pid alone.
 */

import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { ensure, race, resource, sleep, withResolvers } from "effection";
import type { Operation } from "effection";
import { deliverSignal, processReachable } from "@executablemd/runtime";

export interface AttachClient {
  /** The client process, once the runtime says it started. */
  readonly pid: number;
  /** Settles when it leaves, however it leaves. */
  readonly exited: Operation<void>;
  /**
   * End it: ask first, then insist on this pid alone.
   *
   * Idempotent, and safe to call from a finalizer — a client that already left
   * is the outcome this was asking for.
   */
  stop(): Operation<void>;
}

const INTERRUPT_GRACE_MS = 2_000;
const KILL_SETTLE_MS = 500;
const POLL_MS = 25;

/**
 * Start the visible client, and own exactly its lifetime.
 *
 * `askToLeave` is the provider's way of telling tmux to detach this client. It
 * runs before any signal, because a client asked to detach restores the
 * terminal and one that is killed cannot.
 */
export function useAttachClient(options: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  askToLeave(): Operation<void>;
}): Operation<AttachClient> {
  return resource<AttachClient>(function* (provide) {
    const [command, ...args] = options.argv;
    if (command === undefined) {
      throw new Error("the visible client names no command");
    }
    const started = withResolvers<number>();
    const failed = withResolvers<never>();
    const exited = withResolvers<void>();
    let gone = false;
    let child: ChildProcess | undefined;
    let stopping: ReturnType<typeof withResolvers<void>> | undefined;

    function* stop(): Operation<void> {
      if (stopping) {
        return yield* stopping.operation;
      }
      stopping = withResolvers<void>();
      try {
        yield* end();
        stopping.resolve();
      } catch (error) {
        stopping.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }

    function* end(): Operation<void> {
      const pid = child?.pid;
      if (gone || pid === undefined) {
        return;
      }
      // Asked, not told. This is the only path that gives the reader their
      // terminal back in the state they lent it.
      yield* options.askToLeave();
      if (yield* leftWithin(INTERRUPT_GRACE_MS, pid)) {
        return;
      }
      // It did not leave. From here the escalation names this one pid and
      // nothing else: no process group, no terminal holders, no descendants —
      // every one of which would, on this terminal, be the run itself.
      yield* deliverSignal(pid, "SIGTERM");
      if (yield* leftWithin(INTERRUPT_GRACE_MS, pid)) {
        return;
      }
      yield* deliverSignal(pid, "SIGKILL");
      yield* leftWithin(KILL_SETTLE_MS, pid);
    }

    function* leftWithin(limitMs: number, pid: number): Operation<boolean> {
      const deadline = Date.now() + limitMs;
      while (Date.now() < deadline) {
        if (gone || !(yield* processReachable(pid))) {
          return true;
        }
        yield* sleep(POLL_MS);
      }
      return gone;
    }

    // Registered before the spawn: a halt between starting a client and
    // registering its cleanup would leave it holding the terminal.
    yield* ensure(function* () {
      yield* stop();
    });

    child = spawnChild(command, args, {
      cwd: options.cwd,
      env: options.env,
      // The reader's terminal, handed straight through.
      stdio: "inherit",
    });
    child.once("spawn", () => {
      if (child?.pid !== undefined) {
        started.resolve(child.pid);
      }
    });
    child.once("error", (error: Error) => failed.reject(error));
    child.once("exit", () => {
      gone = true;
      exited.resolve();
    });

    // The pid, or whatever arrived instead of a start.
    const pid = yield* race([started.operation, failed.operation]);
    yield* provide({ pid, exited: exited.operation, stop });
  });
}
