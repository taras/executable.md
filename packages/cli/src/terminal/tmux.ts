/**
 * The tmux command surface, and what a host must have before a grid is opened
 * (architecture.md §Interactive terminal grids).
 *
 * Everything tmux is ever told goes through here, which is what makes tmux
 * substitutable: a grid is built against this interface, so the lifecycle can
 * be exercised without a tmux on the machine and without a terminal to draw on.
 *
 * The server is private to one grid. `-S <socket>` puts it on a socket inside
 * the invocation's own directory rather than the user's default one, and
 * `-f /dev/null` means the reader's `.tmux.conf` cannot change what a document
 * asked for — a grid is the author's layout, not the reader's configuration.
 *
 * Prerequisites are checked before anything is created. A host with no terminal
 * or no usable tmux refuses while there is still nothing to undo: no server, no
 * worker, no socket, no token, and no change to the reader's terminal.
 */

import { exec } from "@effectionx/process";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";

/** One private tmux server, addressed by its socket. */
export interface Tmux {
  readonly socket: string;
  /** Run one command; its trimmed stdout, or a failure. */
  run(args: readonly string[]): Operation<string>;
  /** The same, answering `undefined` instead of throwing. */
  tryRun(args: readonly string[]): Operation<string | undefined>;
  /**
   * The whole command vector for a client this grid starts itself.
   *
   * Attaching is not a command that returns; it is a process that runs. It goes
   * through this seam anyway, so that everything tmux is ever told is said in
   * one place — and so a grid's lifecycle can be exercised against something
   * other than tmux.
   */
  argv(args: readonly string[]): readonly string[];
}

/**
 * One tmux command did not work.
 *
 * The message names the command and nothing else. Not the arguments — they
 * carry the socket path, the session name, pane and client identifiers and the
 * worker's private directory. Not the exit status text — tmux writes paths into
 * it. A provider's private topology is private on every path out of it,
 * including the ones only taken when something has gone wrong, which are
 * exactly the paths a diagnostic is read on.
 */
export class TmuxCommandFailed extends Error {
  override name = "TmuxCommandFailed";
  constructor(readonly command: string) {
    super(`the terminal provider's "${command}" step failed`);
  }
}

/**
 * A grid could not be proved taken down.
 *
 * Distinct from a command that failed: this is the provider having done
 * everything it can and still being unable to say that nothing is left running.
 * The document does not continue past it.
 */
export class TerminalTeardownFailed extends Error {
  override name = "TerminalTeardownFailed";
  constructor(unproved: string) {
    super(
      `the terminal grid could not be proved torn down: ${unproved}. The document ` +
        `stops rather than continuing while a terminal may still be held.`,
    );
  }
}

export const TMUX_UNAVAILABLE =
  "this host cannot open a terminal grid: it needs a terminal and a tmux that " +
  "supports one. Run xmd from a terminal on a host with tmux 3.0 or newer, or " +
  "use a host that installs its own terminal provider.";

export class TmuxUnavailableError extends Error {
  override name = "TmuxUnavailableError";
  constructor(readonly reason: string) {
    super(`${TMUX_UNAVAILABLE} (${reason})`);
  }
}

/** Talk to the private server on `socket`. */
export function tmuxAt(socket: string, env: Record<string, string>): Tmux {
  // `-f /dev/null`: the reader's configuration does not get to redecide an
  // authored layout, a pane's border, or what a key does to the child.
  const base = ["-S", socket, "-f", "/dev/null"];
  return {
    socket,
    argv: (args) => ["tmux", ...base, ...args],
    *run(args) {
      const result = yield* exec("tmux", { arguments: [...base, ...args], env }).join();
      if (result.code !== 0) {
        throw new TmuxCommandFailed(args[0] ?? "");
      }
      return result.stdout.trim();
    },
    *tryRun(args) {
      const result = yield* exec("tmux", { arguments: [...base, ...args], env }).join();
      return result.code === 0 ? result.stdout.trim() : undefined;
    },
  };
}

/** The oldest tmux whose layout strings and control mode behave as required. */
const REQUIRED_TMUX = { major: 3, minor: 0 };

/**
 * Whether this host can present a grid, and why not when it cannot.
 *
 * Answered before a server exists. Two facts, both of them the host's: there is
 * a terminal to divide, and there is a tmux new enough to divide it the way an
 * authored layout needs.
 */
export function* probeTmux(options: {
  readonly isTerminal: () => boolean;
  readonly env: Record<string, string>;
  /** What asking tmux its version does. Substituted only by this package. */
  readonly askVersion?: () => Operation<{ code: number; stdout: string }>;
}): Operation<Result<string>> {
  if (!options.isTerminal()) {
    return Err(new TmuxUnavailableError("this invocation has no terminal"));
  }
  const result =
    options.askVersion === undefined
      ? yield* exec("tmux", { arguments: ["-V"], env: options.env }).join()
      : yield* options.askVersion();
  if (result.code !== 0) {
    return Err(new TmuxUnavailableError("tmux is not installed or would not run"));
  }
  const version = result.stdout.trim();
  const parsed = readVersion(version);
  if (parsed === undefined) {
    return Err(new TmuxUnavailableError(`tmux did not report a version (${version})`));
  }
  if (
    parsed.major < REQUIRED_TMUX.major ||
    (parsed.major === REQUIRED_TMUX.major && parsed.minor < REQUIRED_TMUX.minor)
  ) {
    return Err(
      new TmuxUnavailableError(
        `${version} is older than tmux ${REQUIRED_TMUX.major}.${REQUIRED_TMUX.minor}`,
      ),
    );
  }
  return Ok(version);
}

/** `tmux 3.6a` and `tmux next-3.7` alike, read to a major and a minor. */
function readVersion(reported: string): { major: number; minor: number } | undefined {
  const match = /(\d+)\.(\d+)/.exec(reported);
  if (match === null) {
    return undefined;
  }
  const [, major, minor] = match;
  if (major === undefined || minor === undefined) {
    return undefined;
  }
  return { major: Number(major), minor: Number(minor) };
}

/**
 * The environment every process in the topology receives.
 *
 * Named rather than inherited wholesale: a pane's child gets what a terminal
 * program needs and nothing this process happens to be carrying.
 */
export function paneEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "SHELL", "LANG", "TMPDIR", "USER", "LOGNAME"]) {
    const value = source[name];
    if (value !== undefined && value !== "") {
      env[name] = value;
    }
  }
  env.TERM = source.TERM ?? "xterm-256color";
  return env;
}
