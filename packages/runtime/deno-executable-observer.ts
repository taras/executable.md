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
import type { ExecutableObserver, ObservedExecutable } from "./executable-observer.ts";

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

/** What the version invocation produced, decoded. */
function decode(value: unknown): { code: number; text: string } {
  if (typeof value !== "object" || value === null) {
    return { code: -1, text: "" };
  }
  const code = Reflect.get(value, "code");
  const stdout = Reflect.get(value, "stdout");
  const decoder = new TextDecoder();
  return {
    code: typeof code === "number" ? code : -1,
    text: stdout instanceof Uint8Array ? decoder.decode(stdout) : "",
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

      const versionArgs = options?.versionArgs ?? ["--version"];
      const produced = yield* until(
        host
          .command(path, { args: [...versionArgs], stdout: "piped", stderr: "null" })
          .output()
          .catch((cause: unknown) => {
            throw new ExecutableObservationError(`${command} could not be asked its version`, {
              refusal: "version-unavailable",
              cause,
            });
          }),
      );
      const version = decode(produced);
      if (version.code !== 0) {
        throw new ExecutableObservationError(`${command} refused to report a version`, {
          refusal: "version-unavailable",
        });
      }

      return {
        path,
        digest: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
        versionOutput: version.text,
      };
    },
  };
}
