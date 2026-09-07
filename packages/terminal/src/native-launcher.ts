/**
 * The native launcher contract — how a host hands one child process the
 * terminal, and nothing about how any particular host does it.
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
 * There is no host default. `xmd run` installs the foreground launcher from
 * `./posix-launcher.ts`; a test or embedding host installs the controlled one
 * from `./controlled-launcher.ts`. Until one is installed every operation
 * refuses, which is what keeps document help and inspection free of any of
 * this.
 *
 * Nothing here reaches a process, a stream or a host API, and that separation
 * is the point rather than a tidiness: this module is what the package root
 * exports, so importing the domain does not load `node:child_process`. A
 * consumer that only describes a launch pulls in nothing that could perform
 * one.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

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
  /**
   * Start the native UI, wait for it, and report how it ended.
   *
   * `spawned` is the runtime's child-start event, reported as a parameter
   * rather than through the request or the result. A host calls it once the
   * child has actually started and before it waits for the exit, so a UI that
   * starts and closes at once has still started. Preparation, a reservation, an
   * allocated PID and the child's first output are not that event, and a launch
   * that never starts never calls it.
   *
   * At the root nobody is listening and it does nothing. Composed middleware —
   * a terminal pane's launcher — is what gives it a meaning, which is why it
   * travels here instead of in `NativeLaunchRequest`.
   */
  launch(request: NativeLaunchRequest, spawned: () => void): Operation<NativeLaunchOutcome>;
  /**
   * Show the person one line about the launch itself, on the terminal this
   * launch reserved.
   *
   * Not document output. What a launch has to say — that a turn is about to be
   * spent in their name, what it answered, what it cost — is addressed to
   * whoever is sitting there, and it belongs on the screen the native UI is
   * about to open on rather than in the document's captured text, where a
   * `<File>` would keep it and a replay would print it again.
   *
   * It goes through the launcher for the same reason `flush` does: this is the
   * only thing that knows which terminal a given launch owns, so a pane's
   * launch writes into that pane and the root's writes to the root.
   */
  notify(text: string): Operation<void>;
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
    *launch(_request: NativeLaunchRequest, _spawned: () => void): Operation<NativeLaunchOutcome> {
      throw new NativeLauncherUnavailableError();
    },
    // deno-lint-ignore require-yield
    *notify(_text: string): Operation<void> {
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

/** Say one thing to whoever is at the terminal this launch reserved. */
export function notifyTerminal(text: string): Operation<void> {
  return NativeLauncher.operations.notify(text);
}

/**
 * Run one native UI as a foreground child and report how it ended.
 *
 * A provider adapter calls this and hears nothing about the child's start: the
 * spawn event is the host's to report and a pane's to act on, and an adapter
 * that could observe it could also fake it.
 */
export function nativeLaunch(request: NativeLaunchRequest): Operation<NativeLaunchOutcome> {
  return NativeLauncher.operations.launch(request, () => {});
}

export const NO_TERMINAL =
  "<Session.Launch> needs a terminal: a native agent UI reads keystrokes and " +
  "draws on the screen, and this invocation has none. Run xmd from a terminal, " +
  "or use a host that installs its own launcher.";
