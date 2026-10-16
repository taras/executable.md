/**
 * The portable half of a REPL host, over what a runtime states about itself.
 *
 * Three things only a host can answer: where this person's data lives, what to
 * call a new execution, and how to create a file that must not already exist and
 * append a line to it. `@effectionx/fs` has neither of those last two — an
 * exclusive create and an append are the two operations it does not offer — so
 * they arrive here as asynchronous primitives the entrypoint supplies, adapted
 * with `until` and never called synchronously.
 *
 * Nothing registers this. A runtime entrypoint installs it when the REPL command
 * is the one selected, which is what keeps a per-user directory and a terminal
 * off the path of `xmd run`.
 */

import { type Operation, until } from "effection";
import { ReplHost } from "./repl/host.ts";
import type { ReplHostFact } from "./repl/host.ts";
import { ReplStorage } from "./repl/storage.ts";
import { releaseTargetFor } from "./release-targets.ts";

/** What a runtime states about itself for the REPL to use. */
export interface ReplHostCapabilities {
  /** This platform's per-user data directory. */
  dataRoot(): string;
  /**
   * What this process is standing on, for a reply that asks.
   *
   * Stated here because this is the module that knows: the runtime's own name
   * and version, the build this copy came from, and whether it belongs to a
   * published release are all answers a process has and shared code can only
   * guess at. {@link replHostFacts} assembles the portable half from them.
   *
   * A capability like the rest, so a host may not have it — and one that does
   * not is not given a portable description assembled on its behalf. The read a
   * reply would use refuses instead, which is the honest answer: a host that
   * cannot say what it is has not thereby become a host that is something.
   */
  environment?(): readonly ReplHostFact[];
  /** A fresh opaque, URL-safe name for one execution. */
  identify(): string;
  /** Create this file, failing if it already exists. */
  createExclusive(path: string): Promise<void>;
  /** Append this already-terminated record to that file. */
  appendRecord(path: string, record: string): Promise<void>;
}

/** Install one runtime's REPL host for the calling scope. */
export function* installReplHost(host: ReplHostCapabilities): Operation<void> {
  yield* ReplStorage.around(
    {
      // deno-lint-ignore require-yield
      *dataRoot(): Operation<string> {
        return host.dataRoot();
      },
    },
    { at: "min" },
  );
  // Read off the object once, so a host that states no description installs no
  // implementation of one and the Api's own refusal stands.
  const described = host.environment?.bind(host);
  yield* ReplHost.around(
    {
      ...(described === undefined
        ? {}
        : {
            // deno-lint-ignore require-yield
            *environment(): Operation<readonly ReplHostFact[]> {
              return described();
            },
          }),
      // deno-lint-ignore require-yield
      *identify(): Operation<string> {
        return host.identify();
      },
      *createExclusive([path]: [string]): Operation<void> {
        yield* until(host.createExclusive(path));
      },
      *appendRecord([path, record]: [string, string]): Operation<void> {
        yield* until(host.appendRecord(path, record));
      },
    },
    { at: "min" },
  );
}

/**
 * The facts every runtime states, in the order a reply reads them.
 *
 * Assembled here rather than at each entrypoint so four hosts describe one
 * host: a list spelled four times is four chances for one runtime to report a
 * fact under a different label, and a reply comparing two sessions would read
 * that as two different machines.
 *
 * The release target is derived from the platform triple rather than stated,
 * and it is the one fact here that can be absent: a platform the release matrix
 * does not publish for has no target, and saying so is the truth about it. A
 * host running on one is still a host — it just belongs to no published build.
 */
export function replHostFacts(host: {
  /** The runtime and its version, as the process names them. */
  readonly runtime: string;
  /** The version this build of `xmd` reports. */
  readonly version: string;
  /** Node's `process.platform` for the machine this is running on. */
  readonly platform: string;
  /** Node's `process.arch` for the machine this is running on. */
  readonly architecture: string;
}): readonly ReplHostFact[] {
  return Object.freeze([
    Object.freeze({ label: "runtime", value: host.runtime }),
    Object.freeze({ label: "xmd", value: host.version }),
    Object.freeze({
      label: "release target",
      value: releaseTargetFor(host.platform, host.architecture)?.target,
    }),
  ]);
}

/**
 * Where a platform keeps per-user application data.
 *
 * Stated from what the process says about itself, at the entrypoint that knows
 * it is a process. The three answers are the platform conventions: macOS keeps
 * application support beside the user's library, Windows keeps local application
 * data in its own variable, and everything else follows the XDG base directory
 * specification with its documented default.
 */
export function platformDataRoot(
  platform: string,
  home: string,
  environment: { readonly [name: string]: string | undefined },
  separator: string,
): string {
  if (platform === "darwin") {
    return [home, "Library", "Application Support"].join(separator);
  }
  if (platform === "win32") {
    const local = environment["LOCALAPPDATA"];
    return local !== undefined && local.length > 0
      ? local
      : [home, "AppData", "Local"].join(separator);
  }
  const xdg = environment["XDG_DATA_HOME"];
  return xdg !== undefined && xdg.length > 0 ? xdg : [home, ".local", "share"].join(separator);
}
