/**
 * What a terminal grid refuses with, and what a host says when it cannot
 * present one.
 *
 * Each constructor has exactly one definition here. Another entrypoint may
 * re-export it, and the value stays object-identical, so a `catch` written
 * against the root and one written against `./lifecycle` classify the same
 * error.
 */

/**
 * A presentation that authorized nothing: a request that was copied, changed,
 * kept past its grid, presented twice, or issued under another installation.
 */
export class TerminalGridPresentationError extends Error {
  override name = "TerminalGridPresentationError";
}

/** A grid that could not be run: a layout that disagrees with its cell work. */
export class TerminalGridError extends Error {
  override name = "TerminalGridError";
}

export const TERMINAL_PROVIDER_UNAVAILABLE =
  "no terminal provider is installed — this host does not present a grid of " +
  "interactive terminals. `xmd run` installs one; a test or embedding host installs " +
  "its own.";

export class TerminalProviderUnavailableError extends Error {
  override name = "TerminalProviderUnavailableError";
  constructor(message: string = TERMINAL_PROVIDER_UNAVAILABLE) {
    super(message);
  }
}

export class TerminalProviderInstallError extends Error {
  override name = "TerminalProviderInstallError";
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

export const NO_TERMINAL =
  "<Session.Launch> needs a terminal: a native agent UI reads keystrokes and " +
  "draws on the screen, and this invocation has none. Run xmd from a terminal, " +
  "or use a host that installs its own launcher.";

/** What a process observation says when no host installed one. */
export const PROCESS_OBSERVATION_UNAVAILABLE =
  "no process observation is installed — this host cannot say whether a process " +
  "is still running. A POSIX host installs `installPosixProcessObservation()`.";

export class ProcessObservationUnavailableError extends Error {
  override name = "ProcessObservationUnavailableError";
  constructor(message: string = PROCESS_OBSERVATION_UNAVAILABLE) {
    super(message);
  }
}
