/**
 * Observing which executable build a command actually runs
 * (specs/native-agent-session-launch-spec.md §Executable binding).
 *
 * A provider session whose identity XMD chose itself only means something
 * while the build that established it can be reproduced. Two builds of one
 * provider accept the same session identity and disagree silently about what
 * it names — that is how issue #519's first gate produced a healthy-looking
 * session with no history in it. So before a session crosses an ownership
 * boundary, the exact file about to run is observed, and enough is retained to
 * recognize it later.
 *
 * What is observed is a canonical path, the SHA-256 of that file's bytes, and
 * whatever the file says when asked its version. Only the last two ever become
 * durable: a path stops being true when a build moves, and names host layout
 * besides.
 *
 * This is a plain capability the trusted host builds and hands directly to the
 * provider that needs it. It is deliberately not a contextual Api. Executable
 * validation decides which retained history is accepted, and a decision
 * document middleware could replace is not one — a replaceable resolver could
 * point the observation at a different binary than the one that runs.
 *
 * Provider-specific meaning is not this module's business: which command to
 * run, what a version string looks like, and what to do about a mismatch
 * belong to the adapter that knows the provider.
 */

import type { Operation } from "effection";

/** Why an executable could not be observed, in terms a caller can act on. */
export type ExecutableRefusal =
  | "not-found"
  | "not-a-file"
  | "not-executable"
  | "unreadable"
  | "version-unavailable";

/**
 * An observation failure that names its reason.
 *
 * The reason is the actionable part and the message is diagnostic. Neither is
 * retained: a caller turns this into its own refusal, and the paths involved
 * stay on this side of that boundary.
 */
export class ExecutableObservationError extends Error {
  override name = "ExecutableObservationError";
  refusal: ExecutableRefusal;

  constructor(message: string, options: { refusal: ExecutableRefusal; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.refusal = options.refusal;
  }
}

/**
 * One executable, as it exists during this invocation.
 *
 * `path` is canonical and live: it is what a caller spawns and what it asked
 * for a version, and it is absent from everything durable. `versionOutput` is
 * raw — the adapter that knows the provider parses it, and neither this string
 * nor the path may reach a record, a diagnostic, or the environment of
 * anything but the matching child.
 */
export interface ObservedExecutable {
  path: string;
  digest: { algorithm: "sha256"; value: string };
  versionOutput: string;
}

export interface ExecutableObserver {
  /**
   * Resolve `command`, canonicalize it, require an executable regular file,
   * hash its bytes, and ask that exact path for its version.
   *
   * Asking the same path that was hashed is the point: a version read from a
   * differently-resolved file describes a build this observation did not make.
   */
  observe(
    command: string,
    options?: { versionArgs?: readonly string[] },
  ): Operation<ObservedExecutable>;
}
