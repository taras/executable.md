/**
 * The persistent pane worker: tmux's initial process in one pane
 * (architecture.md §Interactive terminal grids).
 *
 * It owns the pane's terminal for the pane's whole life, and everything it does
 * is asked of it over the private socket — show this text, start this child,
 * cancel it, shut down. It never reads the terminal itself, so keystrokes reach
 * the foreground child and only the child.
 *
 * It is the pane's session leader and shares the pane's process group with the
 * child, so `^C` on that pane is delivered to both. It handles SIGINT, SIGQUIT
 * and SIGTSTP by doing nothing: dispositions reset across `exec`, so the child
 * gets the defaults and is the one interrupted. SIGHUP keeps its default — when
 * the pane's terminal goes away, so does the worker.
 *
 * It runs under Effection's `run()` rather than `main()`. `main()` binds SIGINT
 * to its own shutdown and exits 130 on the first `^C` typed into the pane —
 * which is the exact keystroke the child is supposed to receive.
 *
 * Nothing here is reachable without the handshake. The worker is started with
 * an ordinal and a directory, reads the token only that pane's file holds,
 * removes it, and presents it; a worker that cannot do that connects to nothing
 * and performs no work at all.
 */

import net from "node:net";
import process from "node:process";
import { readTextFile, rm } from "@effectionx/fs";
import { ensure, resource, run, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { installDenoTerminalProcesses, processTable } from "@executablemd/runtime";
import { sweepHolders, usePaneChild } from "./pane-child.ts";
import type { PaneChild, PaneChildRequest } from "./pane-child.ts";
import {
  paneSocketPath,
  paneTokenPath,
  readFrames,
  ToWorkerSchema,
  writeFrame,
} from "./pane-protocol.ts";
import type { FromWorker, Settlement } from "./pane-protocol.ts";

/** The hidden invocation a grid starts a pane with. */
export const PANE_WORKER_COMMAND = "terminal-worker";

/**
 * Whether this process was started as a pane worker, and for which pane.
 *
 * Read from raw argv, because this is decided before any parser exists — the
 * worker must not run under Effection's `main()`, so it is dispatched at the
 * entrypoint rather than inside the command table. It is in no command table,
 * so it appears in no help output and no catalog.
 *
 * Anything but the exact shape is not a worker invocation and falls through to
 * the ordinary commands, where `terminal-worker` names no command and is a
 * document reference like any other unknown first token.
 */
export function paneWorkerInvocation(
  args: readonly string[],
): { ordinal: number; directory: string } | undefined {
  const [name, ordinal, directory, ...rest] = args;
  if (name !== PANE_WORKER_COMMAND || ordinal === undefined || directory === undefined) {
    return undefined;
  }
  if (rest.length > 0 || !/^\d+$/.test(ordinal)) {
    return undefined;
  }
  return { ordinal: Number(ordinal), directory };
}

/**
 * Run this process as a pane worker.
 *
 * `run()` rather than `main()`, deliberately: `main()` binds SIGINT to its own
 * shutdown and would exit 130 on the first `^C` typed into the pane — the exact
 * keystroke the foreground child is supposed to receive. The signal handlers go
 * on before anything else for the same reason.
 *
 * Naming this invocation grants nothing. The worker connects to a socket in a
 * private directory and must present that pane's single-use token before the
 * parent says a word to it, so a caller who types this gets a process that
 * fails to connect and performs no work at all.
 */
export function runPaneWorkerProcess(invocation: {
  ordinal: number;
  directory: string;
}): Promise<void> {
  return run(function* () {
    // Inside the run scope, so the handlers go on before any work and come off
    // with it — rather than living for the process's lifetime regardless.
    yield* useForegroundSignals();
    yield* runPaneWorker(invocation.ordinal, invocation.directory);
  });
}

/**
 * A pane that could not be proved free.
 *
 * Provider-neutral: it names no socket, session, pane, client, argv or
 * environment, because a settlement that failed is read in exactly the places a
 * private identifier must not appear.
 */
export class PaneNotQuiescent extends Error {
  override name = "PaneNotQuiescent";
  constructor(what: string) {
    super(`this terminal pane could not be proved free: ${what}`);
  }
}

/**
 * What a settlement means for the pane it settled.
 *
 * Exported because it is the rule, not an implementation detail: everything
 * downstream — clearing the pane, reporting a launch settled, admitting the
 * next one, letting teardown succeed — is conditional on it, and a rule that
 * several callers depend on is one worth being able to state and test on its
 * own.
 */
export function requireQuiescent(settlement: Settlement): void {
  if (settlement.quiet) {
    return;
  }
  // Everything the worker can do has been done and something is still there: a
  // survivor of the escalation, or a holder of the pane's terminal.
  throw new PaneNotQuiescent(
    settlement.holders.some((holder) => !holder.gone)
      ? "something still holds its terminal"
      : "something it started is still running",
  );
}

/** A settlement for a pane that never started anything. */
const NOTHING_TO_SETTLE: Settlement = {
  method: "exited",
  quiet: true,
  swept: [],
  holders: [],
};

interface Live {
  readonly id: string;
  child: PaneChild | undefined;
  /** The one settlement of this child, however many callers ask for it. */
  settled: ReturnType<typeof withResolvers<Settlement>> | undefined;
}

/**
 * Ignore the signals that belong to the foreground child.
 *
 * They are delivered to the whole foreground process group, and this worker is
 * in it. Doing nothing is the correct handling: the child inherits default
 * dispositions across `exec`, so it receives the same signal and acts on it.
 */
export function useForegroundSignals(): Operation<void> {
  return resource<void>(function* (provide) {
    const foreground: NodeJS.Signals[] = ["SIGINT", "SIGQUIT", "SIGTSTP"];
    const ignore = (): void => {};
    for (const name of foreground) {
      process.on(name, ignore);
    }
    yield* ensure(() => {
      // Installed and removed by the scope that runs this worker, so a worker
      // that has finished stops answering for a pane it no longer owns.
      for (const name of foreground) {
        process.off(name, ignore);
      }
    });
    yield* provide();
  });
}

/** How many handlers this process has for one signal. */
export function foregroundSignalListeners(name: NodeJS.Signals): number {
  return process.listenerCount(name);
}

function writeOut(text: string): Operation<void> {
  const written = withResolvers<void>();
  process.stdout.write(text, () => written.resolve());
  return written.operation;
}

/**
 * Run one pane worker until the parent says to stop.
 *
 * The caller has already ignored the foreground signals and is running this
 * under `run()`; both are properties of the *process*, not of this operation,
 * which is why they are the entrypoint's to establish.
 */
/**
 * What a worker uses to start a child.
 *
 * A seam rather than a hard call, because the one thing a suite cannot arrange
 * in another process is a child whose settlement *fails* — a real SIGKILL
 * always works, and a real terminal sweep on a pane with no terminal always
 * comes back empty. Substituting the child is how the worker's own behaviour on
 * that path is observable at all; the alternative would be a fault switch in
 * production code, which is not a trade worth making.
 */
export interface PaneWorkerDependencies {
  useChild(request: PaneChildRequest, tty: string | undefined): Operation<PaneChild>;
  /** Whether to install the POSIX observer. A caller that has one says no. */
  observe?: boolean;
}

export function* runPaneWorker(
  ordinal: number,
  directory: string,
  deps: PaneWorkerDependencies = { useChild: usePaneChild },
): Operation<void> {
  if (deps.observe !== false) {
    yield* installDenoTerminalProcesses();
  }

  // Read once, then spent. A second worker for this pane finds no token, so it
  // has nothing to present and is refused by the parent.
  const token = (yield* readTextFile(paneTokenPath(directory, ordinal))).trim();
  yield* rm(paneTokenPath(directory, ordinal), { force: true });

  const socket = net.createConnection(paneSocketPath(directory, ordinal));
  // The socket is this scope's, so however this worker ends — a shutdown it was
  // asked for, a channel that failed, a settlement it could not prove — the
  // parent sees the channel close rather than waiting on a worker that is no
  // longer there.
  yield* ensure(() => {
    socket.destroy();
  });
  const connected = withResolvers<void>();
  const onConnect = (): void => connected.resolve();
  const onConnectError = (error: Error): void => connected.reject(error);
  socket.on("connect", onConnect);
  socket.on("error", onConnectError);
  try {
    yield* connected.operation;
  } finally {
    // Removed synchronously, in the scope that installed them: a listener that
    // outlived this wait would answer for a socket this worker has finished
    // with.
    socket.off("connect", onConnect);
    socket.off("error", onConnectError);
  }

  const inbound = readFrames(socket, (value) => ToWorkerSchema.parse(value));
  const say = (message: FromWorker) => writeFrame(socket, message);

  const table = yield* processTable();
  const facts = table.find((row) => row.pid === process.pid);
  const tty = facts?.tty;
  yield* say({
    type: "hello",
    ordinal,
    token,
    pid: process.pid,
    pgid: facts?.pgid ?? -1,
    tty: tty ?? "??",
    isatty: [
      process.stdin.isTTY === true,
      process.stdout.isTTY === true,
      process.stderr.isTTY === true,
    ],
  });

  let live: Live | undefined;

  /** Settle one child once, however many callers ask, and free the pane. */
  function* settle(entry: Live): Operation<Settlement> {
    if (entry.settled) {
      return yield* entry.settled.operation;
    }
    entry.settled = withResolvers<Settlement>();
    try {
      const settlement =
        entry.child === undefined ? NOTHING_TO_SETTLE : yield* entry.child.settle();
      // Fails closed: a settlement that could not prove the pane free leaves it
      // uncleared, reports no success, and refuses the next launch.
      requireQuiescent(settlement);
      // Cleared only after the settlement, so a launch arriving now is refused
      // rather than started beside a sweep that would reach it.
      if (live === entry) {
        live = undefined;
      }
      entry.settled.resolve(settlement);
      return settlement;
    } catch (error) {
      entry.settled.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  function* quiesce(): Operation<Settlement> {
    return live === undefined ? NOTHING_TO_SETTLE : yield* settle(live);
  }

  while (true) {
    const next = yield* inbound.next();
    if (next.done) {
      return;
    }
    const message = next.value;
    switch (message.type) {
      case "welcome":
        break;
      case "display":
        // Written, never read: what the reader types belongs to the child.
        yield* writeOut(message.text);
        yield* say({ type: "displayed", seq: message.seq });
        break;
      case "launch": {
        if (live !== undefined) {
          yield* say({ type: "busy", id: message.id });
          break;
        }
        const entry: Live = { id: message.id, child: undefined, settled: undefined };
        live = entry;
        yield* spawn(function* () {
          const child = yield* deps.useChild(
            { argv: message.argv, cwd: message.cwd, env: message.env },
            tty,
          );
          entry.child = child;
          const started = yield* child.started;
          if (!started.ok) {
            // Never started, so never ready. The pane's readiness latch is not
            // tripped, and the grid it belongs to does not attach.
            yield* settle(entry);
            yield* say({ type: "start-failed", id: message.id, reason: started.error.message });
            return;
          }
          yield* say({ type: "started", id: message.id, pid: started.value });
          const outcome = yield* child.exited;
          // The exit is not the end of it. `exited` is what frees the pane for
          // the next launch, so it follows the whole settlement — and is sent
          // only when that settlement proved the pane free. A settlement that
          // did not throws out of here instead, and no success is reported.
          const settlement = yield* settle(entry);
          yield* say({ type: "exited", id: message.id, ...outcome, settlement });
        });
        break;
      }
      case "cancel": {
        const settlement = yield* quiesce();
        yield* say({ type: "quiet", id: message.id, settlement });
        break;
      }
      case "shutdown": {
        const settlement = yield* quiesce();
        yield* say({ type: "quiet", settlement });
        // The pane's last sweep, by the only process that can still make it:
        // once this worker exits, tmux closes the pane's pty master and the
        // kernel revokes the slave, after which nothing can name a process that
        // kept the terminal open. Every child's settlement already swept, so a
        // holder here arrived between that sweep and now.
        yield* say({ type: "bye", holders: yield* sweepHolders(tty) });
        socket.end();
        return;
      }
    }
  }
}
