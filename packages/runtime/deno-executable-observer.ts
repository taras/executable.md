/**
 * The Deno implementation of executable observation.
 *
 * Constructed at a runtime-named boundary and handed to a provider by the host
 * that built it, exactly as the session coordinator is. Shared modules never
 * reach for it and never ask what runtime they are on.
 *
 * Resolution reads the real process environment rather than a contextual one.
 * That is the whole point of building this here: PATH decides which file is
 * observed, and a PATH document middleware could move is a PATH that can point
 * the observation at one binary while the run spawns another. A controlled test
 * substitutes the entire observer through the same constructor seam the host
 * uses, so nothing needs a replaceable resolver to be testable.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { ExecutableObservationError } from "./executable-observer.ts";
import type {
  ExecutableMetadataObservation,
  ExecutableObserver,
  ObservedExecutable,
} from "./executable-observer.ts";

type HostCall = (...args: unknown[]) => unknown;

/** One of the host's methods, bound to it, or nothing when it has none. */
function callable(host: object, name: string): HostCall | undefined {
  const member: unknown = Reflect.get(host, name);
  if (typeof member !== "function") {
    return undefined;
  }
  return (...args) => Reflect.apply(member, host, args);
}

/**
 * The process surface this adapter needs, read off the host rather than
 * imported, so the module stays loadable where it is never constructed.
 */
interface ObserverHost {
  command: (path: string, options: Record<string, unknown>) => { output(): Promise<unknown> };
  env: { toObject(): Record<string, string> };
  cwd: () => string;
}

function observerHost(): ObserverHost | undefined {
  const found: unknown = Reflect.get(globalThis, "Deno");
  if (typeof found !== "object" || found === null) {
    return undefined;
  }
  const env: unknown = Reflect.get(found, "env");
  const cwd = callable(found, "cwd");
  const commandCtor: unknown = Reflect.get(found, "Command");
  if (typeof commandCtor !== "function" || !cwd || typeof env !== "object" || env === null) {
    return undefined;
  }
  const toObject = callable(env, "toObject");
  if (!toObject) {
    return undefined;
  }
  return {
    command: (path, options) =>
      Reflect.construct(commandCtor as new (...a: unknown[]) => { output(): Promise<unknown> }, [
        path,
        options,
      ]),
    env: { toObject: () => toObject() as Record<string, string> },
    cwd: () => cwd() as string,
  };
}

/** Whether this host can observe an executable at all. */
export function hasDenoExecutableObserver(): boolean {
  return observerHost() !== undefined;
}

/** What one metadata query produced, decoded. */
function decode(value: unknown): ExecutableMetadataObservation {
  const decoder = new TextDecoder();
  const text = (channel: unknown) => (channel instanceof Uint8Array ? decoder.decode(channel) : "");
  if (typeof value !== "object" || value === null) {
    return { settled: false, stdout: "", stderr: "" };
  }
  const code = Reflect.get(value, "code");
  if (typeof code !== "number") {
    // A child that produced no status did not answer, whatever it wrote on the
    // way. Reporting output beside an unknown status would invite reading it as
    // an answer.
    return { settled: false, stdout: "", stderr: "" };
  }
  return {
    settled: true,
    code,
    stdout: text(Reflect.get(value, "stdout")),
    stderr: text(Reflect.get(value, "stderr")),
  };
}

/**
 * Build an observer rooted in this process's real environment.
 *
 * `overrides` exist for the focused proof only: a test that wants to watch
 * PATH search happen supplies its own search path and working directory rather
 * than moving the ones every other thing in the process is using.
 */
export function createDenoExecutableObserver(overrides?: {
  path?: string;
  cwd?: string;
}): ExecutableObserver | undefined {
  const found = observerHost();
  if (!found) {
    return undefined;
  }
  const host: ObserverHost = found;

  function* resolveCommand(command: string): Operation<string> {
    if (command.length === 0) {
      throw new ExecutableObservationError("no executable was named", { refusal: "not-found" });
    }
    const base = overrides?.cwd ?? host.cwd();
    if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
      return resolve(base, command);
    }
    const search = overrides?.path ?? host.env.toObject().PATH ?? "";
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

  return {
    *observe(command, options): Operation<ObservedExecutable> {
      const resolved = yield* resolveCommand(command);

      // Canonicalized before stat, hash and version: a symlinked launcher shim
      // and the build it points at are one file, so the same build reached two
      // ways produces one digest — and the version comes from that same file
      // rather than from whatever the shim would have re-resolved.
      const path = yield* until(realpath(resolved).catch(() => resolved));

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
      // Any execute bit is enough: which one applies depends on who is asking,
      // and a file with none of them is not a program under any of them.
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

      // Asked with nothing: no inherited environment, no stdin, and both
      // channels captured rather than attached. A metadata query is meant to
      // report and exit, so it is given nothing to read, nothing to inherit and
      // no terminal to draw on — and what it writes is returned to the caller
      // rather than appearing on the reader's.
      const metadata: Record<string, ExecutableMetadataObservation> = {};
      for (const query of options?.metadata ?? []) {
        // `output()` raises rather than rejecting when the child cannot be
        // spawned at all, so a failure to start is caught here as well as
        // there. Either way it is an observation that did not answer, not a
        // failed observation: the file was found, and asking it a question is
        // not what decides whether it is the build.
        let answer: unknown;
        try {
          answer = yield* until(
            host
              .command(path, {
                args: [...query.args],
                clearEnv: true,
                env: {},
                stdin: "null",
                stdout: "piped",
                stderr: "piped",
              })
              .output()
              .catch(() => undefined),
          );
        } catch {
          answer = undefined;
        }
        metadata[query.name] = decode(answer);
      }

      return {
        path,
        digest: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
        metadata,
      };
    },
  };
}
