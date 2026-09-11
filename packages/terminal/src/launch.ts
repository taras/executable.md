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
 *    sessions, so native UIs are sequential by construction. A terminal grid
 *    takes the same lease for its whole visible lifetime.
 * 2. `flush()` gives the reader everything the document has produced so far,
 *    so the native UI does not open on top of half-written output.
 * 3. `launch()` spawns the child with the terminal inherited, waits for it,
 *    and reports its terminal status and nothing else.
 *
 * There is no host default. `xmd run` installs the foreground launcher from
 * `@executablemd/terminal/posix`; a test or embedding host installs the
 * controlled one from `@executablemd/terminal/test`. Until one is installed
 * every operation refuses, which is what keeps document help and inspection
 * free of any of this.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

import { NativeLauncherUnavailableError } from "./errors.ts";

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

/**
 * The composition name is stable across loaded copies, so it does not follow
 * the module between packages: a host still running the previous copy composes
 * with this one through the name they share.
 */
export const NATIVE_LAUNCHER_API = "runtime.nativeLauncher";

export const NativeLauncher: Api<NativeLauncherHandler> = createApi<NativeLauncherHandler>(
  NATIVE_LAUNCHER_API,
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
