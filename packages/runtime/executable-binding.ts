/**
 * Observing which executable build a command actually runs.
 *
 * A provider session that XMD names itself only means something while the
 * build that established it can be reproduced. Two builds of one provider
 * accept the same session identity and disagree silently about what it names,
 * so before a session is handed across an ownership boundary, XMD observes the
 * exact file it is about to run and retains enough to recognize it later.
 *
 * What it observes is a canonical path and the SHA-256 of that file's bytes.
 * The path is invocation-local and never retained: where a build lives changes,
 * and a record naming a path also names host layout. The digest is what
 * survives, because it answers the only question a later attachment has — is
 * this the same build?
 *
 * The host mechanics live here, behind an Api, so a test can substitute a
 * whole observation without a filesystem. Provider-specific meaning — what a
 * version string looks like, which command to run, what to do about a
 * mismatch — is not this module's business.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { type Operation, until } from "effection";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { API } from "./apis.ts";

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
 * One executable, as it exists during this invocation.
 *
 * `path` is canonical and live. It is what a caller spawns and what it asks
 * for a version, and it is deliberately absent from everything durable.
 */
export interface LiveExecutable {
  path: string;
  digest: { algorithm: "sha256"; value: string };
}

export interface ExecutableBindingApi {
  /**
   * Resolve `command` against the contextual host environment, canonicalize
   * it, require an executable regular file, and hash its bytes.
   */
  observe(command: string): Operation<LiveExecutable>;
}

/**
 * Resolve a command the way a shell would, using the contextual environment.
 *
 * A command carrying a separator names a file directly; a bare name is
 * searched along PATH. Resolution goes through `API.Env` rather than the
 * process environment so that a test can move PATH without moving it for
 * everything else running in the same process.
 */
function* resolveCommand(command: string): Operation<string> {
  if (command.length === 0) {
    throw new ExecutableObservationError("no executable was named", { refusal: "not-found" });
  }
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    return resolve(yield* API.Env.operations.cwd(), command);
  }
  const search = (yield* API.Env.operations.env("PATH")) ?? "";
  for (const entry of search.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, command);
    const found = yield* until(
      stat(candidate).then(
        () => true,
        () => false,
      ),
    );
    if (found) {
      return candidate;
    }
  }
  throw new ExecutableObservationError(
    `no executable named ${command} was found on the search path`,
    { refusal: "not-found" },
  );
}

function* observeExecutable(command: string): Operation<LiveExecutable> {
  const resolved = yield* resolveCommand(command);

  // Canonicalizing before stat and hash means a symlinked launcher shim and
  // the build it points at are observed as one file, so the same build reached
  // two ways produces one digest.
  const path = (yield* API.Fs.operations.realpath(resolved)) ?? resolved;

  const info = yield* until(
    stat(path).catch((cause: unknown) => {
      throw new ExecutableObservationError(`${command} could not be inspected`, {
        refusal: "not-found",
        cause,
      });
    }),
  );
  if (!info.isFile()) {
    throw new ExecutableObservationError(`${command} does not name a regular file`, {
      refusal: "not-a-file",
    });
  }
  // Any execute bit is enough: which one applies depends on who is asking, and
  // a file with none of them is not a program under any of them.
  if ((info.mode & 0o111) === 0) {
    throw new ExecutableObservationError(`${command} is not executable`, {
      refusal: "not-executable",
    });
  }

  const bytes = yield* until(
    readFile(path).catch((cause: unknown) => {
      throw new ExecutableObservationError(`${command} could not be read`, {
        refusal: "unreadable",
        cause,
      });
    }),
  );
  return {
    path,
    digest: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
  };
}

export const ExecutableBinding: Api<ExecutableBindingApi> = createApi<ExecutableBindingApi>(
  "runtime.executable.binding",
  { observe: observeExecutable },
);
