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
import { ReplStorage } from "./repl/storage.ts";

/** What a runtime states about itself for the REPL to use. */
export interface ReplHostCapabilities {
  /** This platform's per-user data directory. */
  dataRoot(): string;
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
  yield* ReplHost.around(
    {
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
