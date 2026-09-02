/**
 * The persistent pane worker: tmux's initial process in one pane.
 *
 * It owns the pane's terminal for the pane's whole life. Everything it does is
 * asked over the private socket: display text on the pane, start one
 * interactive child that inherits the terminal, cancel it, shut down. It never
 * reads the terminal itself, so keystrokes reach the child and only the child.
 *
 * The worker is the pane's session leader and shares its process group with
 * the child, so `^C` on the pane is delivered to both. The worker handles
 * SIGINT, SIGQUIT and SIGTSTP by doing nothing — the child inherits default
 * dispositions across `exec`, so it is the one interrupted. SIGHUP keeps its
 * default: when the pane's terminal goes away, so does the worker.
 *
 * The program is started with `run()` rather than Effection's `main()`, which
 * would bind SIGINT to its own shutdown and exit 130 on the first `^C` typed
 * into the pane — the exact keystroke the child is supposed to receive.
 *
 * Usage (only ever as a tmux pane command):
 *   deno run --allow-all worker.ts <ordinal> <private-directory>
 */

import net from "node:net";
import process from "node:process";
import { readTextFile, rm } from "@effectionx/fs";
import { run, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { useInteractiveProcess } from "./interactive-process.ts";
import type { InteractiveProcess, QuiescenceProof } from "./interactive-process.ts";
import { frames, send, socketPath, tokenPath, ToWorkerSchema } from "./ipc.ts";
import type { FromWorker } from "./ipc.ts";
import { deliver, holdersOf, isReachable, processFacts } from "./processes.ts";

interface ActiveChild {
  id: string;
  process: InteractiveProcess | undefined;
}

function ignoreTerminalSignals(): void {
  for (const name of ["SIGINT", "SIGQUIT", "SIGTSTP"] as const) {
    process.on(name, () => {
      // Delivered to the whole foreground group; the child is the one it is for.
    });
  }
}

function* sweepTerminalHolders(
  tty: string | undefined,
): Operation<{ pid: number; gone: boolean }[]> {
  if (tty === undefined || tty === "??") {
    return [];
  }
  const holders = (yield* holdersOf(`/dev/${tty}`)).filter((pid) => pid !== process.pid);
  for (const pid of holders) {
    deliver(pid, "SIGKILL");
  }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && holders.some(isReachable)) {
    yield* sleep(25);
  }
  return holders.map((pid) => ({ pid, gone: !isReachable(pid) }));
}

function writeOut(text: string): Operation<void> {
  const written = withResolvers<void>();
  process.stdout.write(text, () => written.resolve());
  return written.operation;
}

const [ordinalArg, directory] = process.argv.slice(2);
const ordinal = Number(ordinalArg);
if (!Number.isInteger(ordinal) || directory === undefined) {
  process.stderr.write("usage: worker.ts <ordinal> <private-directory>\n");
  process.exit(2);
}
ignoreTerminalSignals();

await run(function* () {
  const token = (yield* readTextFile(tokenPath(directory, ordinal))).trim();
  yield* rm(tokenPath(directory, ordinal));

  const socket = net.createConnection(socketPath(directory, ordinal));
  const connected = withResolvers<void>();
  socket.once("connect", () => connected.resolve());
  socket.once("error", (error: Error) => connected.reject(error));
  yield* connected.operation;
  const inbound = frames(socket, (value) => ToWorkerSchema.parse(value));
  const say = (message: FromWorker) => send(socket, message);

  const facts = yield* processFacts(process.pid);
  yield* say({
    type: "hello",
    ordinal,
    token,
    pid: process.pid,
    ppid: process.ppid,
    pgid: facts?.pgid ?? -1,
    tty: facts?.tty ?? "??",
    isatty: [
      process.stdin.isTTY === true,
      process.stdout.isTTY === true,
      process.stderr.isTTY === true,
    ],
  });

  let active: ActiveChild | undefined;

  function* quiesce(): Operation<QuiescenceProof> {
    const child = active?.process;
    if (child === undefined) {
      return {
        method: "exited",
        childPid: undefined,
        childGone: true,
        descendants: [],
        survivors: [],
      };
    }
    return yield* child.stop();
  }

  while (true) {
    const next = yield* inbound.next();
    if (next.done) {
      break;
    }
    const message = next.value;
    switch (message.type) {
      case "welcome":
        break;
      case "display":
        yield* writeOut(message.text);
        yield* say({ type: "displayed", seq: message.seq });
        break;
      case "launch": {
        if (active !== undefined) {
          yield* say({ type: "refused", id: message.id, reason: "busy" });
          break;
        }
        const entry: ActiveChild = { id: message.id, process: undefined };
        active = entry;
        yield* spawn(function* () {
          const child = yield* useInteractiveProcess({
            command: message.argv,
            cwd: message.cwd,
            env: message.env,
          });
          entry.process = child;
          const ready = yield* child.ready;
          if (!ready.ok) {
            yield* say({ type: "startup-failed", id: message.id, reason: ready.error.message });
            active = undefined;
            return;
          }
          yield* say({ type: "ready", id: message.id, pid: ready.value });
          const outcome = yield* child.exited;
          // A child that exited on its own may have left descendants in the
          // pane's process group. They are swept before `exited` is reported,
          // because `exited` is what makes the pane free for the next child —
          // and a sweep running beside a new child would reach that child too.
          yield* child.stop();
          if (active === entry) {
            active = undefined;
          }
          yield* say({ type: "exited", id: message.id, ...outcome });
        });
        break;
      }
      case "cancel": {
        const proof = yield* quiesce();
        yield* say({ type: "quiescent", id: message.id, proof });
        break;
      }
      case "shutdown": {
        const proof = yield* quiesce();
        yield* say({ type: "quiescent", proof });
        // The pane's last sweep, by the only process that can still make it:
        // once this worker exits, tmux closes the pane's pty master and macOS
        // revokes the slave, after which nothing can name a process that kept
        // the terminal open. A holder here escaped every earlier sweep.
        const ttyHolders = yield* sweepTerminalHolders(facts?.tty);
        yield* say({ type: "bye", ttyHolders });
        socket.end();
        return;
      }
    }
  }
});
