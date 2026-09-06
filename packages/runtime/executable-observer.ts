/**
 * Observing which executable build a command actually runs, and what that exact
 * file declares about itself (specs/native-agent-session-launch-spec.md
 * §Executable binding).
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
 * the answers that same file gives to the read-only questions its adapter
 * declared. Only the digest is durable by itself: a path stops being true when
 * a build moves and names host layout besides, and the answers are the
 * adapter's to read.
 *
 * This is a plain capability the trusted host builds and hands directly to the
 * provider that needs it. It is deliberately not a contextual Api. Executable
 * validation decides which retained history is accepted, and a decision
 * document middleware could replace is not one — a replaceable resolver could
 * point the observation at a different binary than the one that runs.
 *
 * Provider-specific meaning is not this module's business. Which questions to
 * ask is the adapter's, what the answers mean is the adapter's, and what to do
 * about a mismatch is the caller's. Here a question is argv and an answer is a
 * settled status with the bytes the child wrote.
 */

import type { Operation } from "effection";

/** Why an executable could not be observed, in terms a caller can act on. */
export type ExecutableRefusal = "not-found" | "not-a-file" | "not-executable" | "unreadable";

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
 * One read-only question to ask the file that was just hashed.
 *
 * `name` is the caller's own label, and is what the answer comes back under, so
 * an adapter reads its questions by meaning rather than by position. `args` is
 * argv after the executable itself and is the adapter's whole dialect: this
 * module never adds to it, and a query that did anything but report is a query
 * this contract has no way to take back.
 */
export interface ExecutableMetadataQuery {
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * How one query settled.
 *
 * `settled` is false when the child never ran to completion, which is a
 * different fact from running and failing: an adapter may accept a missing
 * answer while refusing a wrong one. `code` exists only alongside a settled
 * child, and both channels are captured rather than inherited so nothing the
 * queried file writes reaches the caller's terminal.
 */
export interface ExecutableMetadataObservation {
  readonly settled: boolean;
  readonly code?: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every declared question's answer, under the name it was asked by. */
export type ExecutableMetadata = Readonly<Record<string, ExecutableMetadataObservation>>;

/**
 * One executable, as it exists during this invocation.
 *
 * `path` is canonical and live: it is what a caller spawns and what every query
 * was asked, and it is absent from everything durable. `metadata` is raw — the
 * adapter that knows the provider reads it, and neither those bytes nor the
 * path may reach a record, a diagnostic, or the environment of anything but the
 * matching child.
 */
export interface ObservedExecutable {
  path: string;
  digest: { algorithm: "sha256"; value: string };
  metadata: ExecutableMetadata;
}

export interface ExecutableObserver {
  /**
   * Resolve `command`, canonicalize it, require an executable regular file,
   * hash its bytes once, and ask that exact path each declared query.
   *
   * Asking the same path that was hashed is the point: an answer read from a
   * differently-resolved file describes a build this observation did not make.
   * A query that cannot start or cannot settle is reported as such rather than
   * failing the observation — whether a missing answer is fatal is a question
   * about the provider, and this module knows none.
   */
  observe(
    command: string,
    options?: { metadata?: readonly ExecutableMetadataQuery[] },
  ): Operation<ObservedExecutable>;
}
