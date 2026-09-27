/**
 * Where a person's REPL history lives, and who knows that.
 *
 * Only the runtime knows where a per-user data directory is: it is a different
 * path on macOS, Linux and Windows, and a compiled binary answers it the same
 * way the source runtime does but says so for itself. So the path is an Api a
 * runtime-named entrypoint installs, and shared code asks rather than inspects.
 *
 * Nothing here decides *what* is stored. The repository beneath this root holds
 * ordinary serialized DurableEvents and nothing else — no manifest, no cache, no
 * materialized model, no checkpoint file. A reader with the file and the URL has
 * everything, which is only true while that stays true.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensureDir } from "@effectionx/fs";
import { join } from "node:path";
import type { Operation } from "effection";

/** No adapter said where this host keeps a person's data. */
export class ReplStorageError extends Error {
  constructor() {
    super(
      "the REPL has no data directory on this host. A runtime adapter installs one with " +
        'ReplStorage.around({ ... }, { at: "min" }) before the command runs.',
    );
    this.name = "ReplStorageError";
  }
}

export interface ReplStorageApi {
  /** The per-user data directory this runtime keeps application state in. */
  dataRoot(): Operation<string>;
}

export const ReplStorage: Api<ReplStorageApi> = createApi<ReplStorageApi>("ReplStorage", {
  // deno-lint-ignore require-yield
  *dataRoot(): Operation<string> {
    throw new ReplStorageError();
  },
});

/** The directory beneath a data root that this REPL's histories live in. */
export const REPL_DIRECTORY: readonly string[] = ["xmd", "repl"];

/**
 * The repository root, created if this is the first time.
 *
 * Created rather than required, because the first `xmd repl` on a machine is
 * the ordinary case. Nothing is ever removed from it: what is in one of these
 * files is somebody's work.
 */
export function* useReplRoot(): Operation<string> {
  const root = join(yield* ReplStorage.operations.dataRoot(), ...REPL_DIRECTORY);
  yield* ensureDir(root);
  return root;
}
