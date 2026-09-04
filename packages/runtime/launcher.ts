/**
 * The native launcher — how a host hands one child process the terminal.
 *
 * This is not `exec`. An ordinary command is a captured child: its stdout and
 * stderr are piped so a document can display, capture and journal them, and
 * its exit status is a value the document reads. A native coding-agent UI is
 * the opposite of that. It draws on the terminal, reads the person's
 * keystrokes, and owns the conversation it has with them. None of that may
 * become an XMD process result or a journaled transcript, and a piped child
 * cannot be interactive at all.
 *
 * So a launch asks for three things in order, and each is refusable on its
 * own:
 *
 * 1. `reserve()` takes the one foreground-terminal lease for the run. A host
 *    with no terminal refuses here, which is before any session ownership has
 *    moved. Two launches cannot hold it at once even when they name different
 *    sessions, so native UIs are sequential by construction.
 * 2. `flush()` gives the reader everything the document has produced so far,
 *    so the native UI does not open on top of half-written output.
 * 3. `launch()` spawns the child with the terminal inherited, waits for it,
 *    and reports its terminal status and nothing else.
 *
 * There is no host default. `xmd run` installs the foreground launcher;
 * a test or embedding host installs a controlled one that needs no terminal.
 * Until one is installed every operation refuses, which is what keeps
 * document help and inspection free of any of this.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensure, race, resource, scoped, until } from "effection";
import { once } from "@effectionx/node/events";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";

/**
 * What a provider asks the host to run.
 *
 * `command` is the complete argv, built by the provider's adapter from the
 * provider-native session identity. Raw prepared instructions never appear in
 * it, and never in `env`: a process's arguments and environment are readable
 * by other processes, so the instruction layer travels through the provider's
 * own session API instead.
 */
export interface NativeLaunchRequest {
  command: string[];
  cwd: string;
  env?: Record<string, string>;
}

/**
 * How the native UI ended. A child that exited on a signal reports the signal
 * and no code, which is how a signalled exit stays distinguishable from
 * status 0.
 */
export interface NativeLaunchOutcome {
  exitCode?: number;
  signal?: string;
}

export interface NativeLauncherHandler {
  reserve(): Operation<void>;
  flush(): Operation<void>;
  launch(request: NativeLaunchRequest): Operation<NativeLaunchOutcome>;
}

export const NATIVE_LAUNCHER_UNAVAILABLE =
  "no native launcher is installed — this host does not hand a native agent UI " +
  "the terminal. `xmd run` installs one; a test or embedding host installs its own.";

export class NativeLauncherUnavailableError extends Error {
  override name = "NativeLauncherUnavailableError";
  constructor(message: string = NATIVE_LAUNCHER_UNAVAILABLE) {
    super(message);
  }
}

export const NativeLauncher: Api<NativeLauncherHandler> = createApi<NativeLauncherHandler>(
  "runtime.nativeLauncher",
  {
    // deno-lint-ignore require-yield
    *reserve(): Operation<void> {
      throw new NativeLauncherUnavailableError();
    },
    // deno-lint-ignore require-yield
    *flush(): Operation<void> {
      throw new NativeLauncherUnavailableError();
    },
    // deno-lint-ignore require-yield
    *launch(_request: NativeLaunchRequest): Operation<NativeLaunchOutcome> {
      throw new NativeLauncherUnavailableError();
    },
  },
);

/** Hold the foreground-terminal lease for the calling scope. */
export function reserveTerminal(): Operation<void> {
  return NativeLauncher.operations.reserve();
}

/** Give the reader everything the document has produced so far. */
export function flushOutput(): Operation<void> {
  return NativeLauncher.operations.flush();
}

/** Run one native UI as a foreground child and report how it ended. */
export function nativeLaunch(request: NativeLaunchRequest): Operation<NativeLaunchOutcome> {
  return NativeLauncher.operations.launch(request);
}

export const NO_TERMINAL =
  "<Session.Launch> needs a terminal: a native agent UI reads keystrokes and " +
  "draws on the screen, and this invocation has none. Run xmd from a terminal, " +
  "or use a host that installs its own launcher.";

/**
 * How long an interrupted child is given to leave on its own before the
 * launcher escalates. Cancellation is not permitted to strand a process
 * holding the terminal, so the escalation is bounded rather than patient.
 */
const INTERRUPT_GRACE_MS = 2_000;

/** How often a reap re-checks whether the child is still reachable. */
const REAP_POLL_MS = 25;

/** How long an unanswerable kill is given before the child is called gone. */
const KILL_SETTLE_MS = 500;

interface ForegroundLauncherOptions {
  /**
   * Whether this host can hand a child the terminal. Read once, when the
   * launcher installs, so a run learns what it is before a document starts.
   */
  isTerminal?: () => boolean;
  /** Everything this host has still to show the reader. */
  drain?: () => Operation<void>;
}

/**
 * Install the launcher that hands a native UI this process's own terminal.
 *
 * XMD stays the parent. It does not replace itself with the child, because a
 * process that has execed away cannot cancel the document, reap the child,
 * own its exit status, or continue after the UI closes.
 */
export function* installForegroundLauncher(
  options: ForegroundLauncherOptions = {},
): Operation<void> {
  const isTerminal = options.isTerminal ?? (() => process.stdout.isTTY === true);
  const drain = options.drain;
  let held = false;

  yield* NativeLauncher.around(
    {
      reserve() {
        return resource<void>(function* (provide) {
          if (!isTerminal()) {
            throw new NativeLauncherUnavailableError(NO_TERMINAL);
          }
          if (held) {
            throw new Error(
              "another <Session.Launch> already holds this run's terminal — one " +
                "native UI owns the terminal at a time",
            );
          }
          held = true;
          try {
            yield* provide();
          } finally {
            held = false;
          }
        });
      },
      *flush() {
        if (drain) {
          yield* drain();
        }
        yield* drainStream(process.stdout);
        yield* drainStream(process.stderr);
      },
      *launch([request]) {
        return yield* runForeground(request);
      },
    },
    { at: "min" },
  );
}

/** The part of a host output stream that says whether it still owes bytes. */
interface DrainableStream {
  writableLength: number;
  write(chunk: string, callback: () => void): boolean;
}

/**
 * Wait until the host stream has written what was handed to it.
 *
 * A TTY write usually completes synchronously and `write()` reports it did;
 * when it reports back-pressure instead the bytes are still queued, and the
 * child would draw over them.
 */
function drainStream(stream: DrainableStream): Operation<void> {
  return until(
    new Promise<void>((resolve) => {
      if (stream.writableLength === 0) {
        resolve();
        return;
      }
      stream.write("", () => resolve());
    }),
  );
}

function runForeground(request: NativeLaunchRequest): Operation<NativeLaunchOutcome> {
  return scoped(function* (): Operation<NativeLaunchOutcome> {
    const [command, ...args] = request.command;
    if (command === undefined) {
      throw new Error("native launch: command must not be empty");
    }

    let child: ChildProcess | undefined;

    // Interrupt, then insist. A cancelled document may not continue — or
    // finish tearing down — while a child still holds the terminal, so this
    // waits for the child to be gone rather than for the signal to have been
    // sent. Registered before the spawn, because a halt between acquiring a
    // process and registering its cleanup leaks the process.
    yield* ensure(() => (child ? until(reap(child)) : undefined));

    // `inherit` is the whole point: the child reads this terminal and draws on
    // it directly, so nothing between it and the person using it can buffer,
    // reorder, capture or journal what passes.
    const started = spawnChild(command, args, {
      cwd: request.cwd,
      env: request.env,
      stdio: "inherit",
    });
    child = started;

    // Raced inline, in the same synchronous run as the spawn, so both arms are
    // attached before the child can report anything — a spawned race attaches
    // a turn later. Whichever loses is halted, which is what detaches it.
    return yield* race([
      (function* (): Operation<NativeLaunchOutcome> {
        const [code, signal] = yield* once<[number | null, string | null]>(started, "exit");
        const outcome: NativeLaunchOutcome = {};
        if (code !== null) {
          outcome.exitCode = code;
        }
        if (signal !== null) {
          outcome.signal = signal;
        }
        return outcome;
      })(),
      (function* (): Operation<never> {
        const [error] = yield* once<[Error]>(started, "error");
        throw error;
      })(),
    ]);
  });
}

/**
 * End one foreground child and wait for it to be gone.
 *
 * Exported for `packages/runtime/tests/native-launcher.test.ts` and not from
 * `mod.ts`: the listener this installs belongs to a bounded Promise, and the
 * only way to observe that it is released on every settlement path is to hold
 * the child.
 *
 * Deliberately one promise rather than an Effection race: this runs while the
 * scope is already being dismantled, and the cheapest correct thing to do
 * there is to wait on the process's own events instead of starting more
 * structured work beside them.
 *
 * A child that ignores the interrupt is killed outright once the grace period
 * is spent — a native UI holding the terminal is not something a cancelled run
 * can afford to wait on indefinitely.
 */
export function reap(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // What the escalation established. Bounded settlement is only permitted on
    // the strength of one of these: a fatal signal the kernel accepted, or a
    // process that was already gone. Anything else — a refused delivery, a
    // permission error — leaves a child that may still be running, and
    // reporting that as a successful reap would let the document continue
    // while a native UI still owns the terminal.
    let fatal: Delivery | undefined;

    const done = (outcome?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      clearTimeout(escalation);
      clearTimeout(deadline);
      // The one funnel every settlement goes through — the exit event, the
      // reachability poll, the escalation deadline, and the refusal that
      // rejects — so the handler comes off however this ends.
      child.off("exit", onExit);
      // Deno's `node:child_process` stops reporting a child's exit once a
      // signal that child ignored has been delivered, and holds the runtime
      // open on the handle it will now never settle. Dropping the reference is
      // what lets a cancelled run finish.
      try {
        child.unref();
      } catch {
        // The runtime already released the handle, which is the state this
        // was asking for.
      }
      if (outcome) {
        reject(outcome);
        return;
      }
      resolve();
    };
    const onExit = (): void => done();

    child.on("exit", onExit);
    // Reachability rather than the exit event, because that is the fact this
    // has to establish and the event is not dependable across runtimes here.
    const poll = setInterval(() => {
      if (!isReachable(pid)) {
        done();
      }
    }, REAP_POLL_MS);
    const escalation = setTimeout(() => {
      fatal = signal(pid, "SIGKILL");
    }, INTERRUPT_GRACE_MS);
    // A process does not survive SIGKILL, so once the kernel accepted one this
    // stops waiting on a report rather than on the child. What it will not do
    // is call an undelivered signal a termination.
    const deadline = setTimeout(() => {
      if (fatal === "delivered" || fatal === "absent") {
        done();
        return;
      }
      done(
        new Error(
          `native launch could not establish that process ${pid} stopped: ` +
            `SIGKILL was ${fatal ?? "not delivered"}`,
        ),
      );
    }, INTERRUPT_GRACE_MS + KILL_SETTLE_MS);

    signal(pid, "SIGINT");
  });
}

/** What one signal delivery established about the process it was aimed at. */
type Delivery = "delivered" | "absent" | "refused";

/**
 * Send one signal to the child by pid, and report what that established.
 *
 * Deliberately not `child.kill()`. Deno's `node:child_process` marks a child as
 * killed after the first call and delivers nothing on any later one, so a child
 * that ignores the interrupt could never be escalated through the handle — the
 * run would keep waiting on a native UI still holding the terminal. Addressing
 * the process directly is what makes escalation real.
 */
function signal(pid: number, name: "SIGINT" | "SIGKILL"): Delivery {
  try {
    process.kill(pid, name);
    return "delivered";
  } catch (error) {
    // Gone between the decision and the delivery is the outcome this was
    // asking for. Anything else is a delivery that did not happen, and is not
    // evidence of termination.
    return isNoSuchProcess(error) ? "absent" : "refused";
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

/**
 * Whether a process still exists. Signal 0 delivers nothing: it asks the
 * kernel whether the pid is reachable, which is the whole question here.
 */
function isReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A launcher a host installs when it has no terminal to give away, and no
 * intention of starting a native UI.
 *
 * `record` sees each request in the order the provider made it; `outcome`
 * decides what the child did; and `wait` is the operation the launch blocks
 * on, so a test controls exactly how long the document stays suspended.
 */
export interface ControlledLauncherOptions {
  record?: (request: NativeLaunchRequest) => void;
  outcome?: (request: NativeLaunchRequest) => NativeLaunchOutcome;
  wait?: (request: NativeLaunchRequest) => Operation<void>;
  onReserve?: () => void;
  onFlush?: () => void;
}

export function* installControlledLauncher(
  options: ControlledLauncherOptions = {},
): Operation<void> {
  let held = false;
  yield* NativeLauncher.around(
    {
      reserve() {
        return resource<void>(function* (provide) {
          if (held) {
            throw new Error(
              "another <Session.Launch> already holds this run's terminal — one " +
                "native UI owns the terminal at a time",
            );
          }
          held = true;
          options.onReserve?.();
          try {
            yield* provide();
          } finally {
            held = false;
          }
        });
      },
      // deno-lint-ignore require-yield
      *flush() {
        options.onFlush?.();
      },
      *launch([request]) {
        options.record?.(request);
        if (options.wait) {
          yield* options.wait(request);
        }
        return options.outcome?.(request) ?? { exitCode: 0 };
      },
    },
    { at: "min" },
  );
}
