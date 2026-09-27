/**
 * What the REPL needs from the process it is running in.
 *
 * Shared REPL code never asks which runtime it is on. It asks this Api, and a
 * runtime-named entrypoint — `src/deno.ts`, `src/node.ts`, `src/bun.ts`,
 * `src/compiled.ts` — installs the answers. That is the same boundary the rest
 * of the CLI keeps, and it is what lets every REPL test run under all three
 * runtimes against an injected host rather than an operator's filesystem.
 *
 * Only what `@effectionx/fs` does not already provide is here. Reading a file,
 * asking whether one exists and making a directory are ordinary operations with
 * a portable home; creating a name exclusively and appending to an open history
 * are not, so they cross here instead of being chosen inside the kernel.
 *
 * Installed at `{ at: "min" }`, because a host is an implementation rather than
 * instrumentation: the nearest installed one answers, and an outer install must
 * not shadow a nested one.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

/** No host installed this operation, so the REPL cannot perform it. */
export class ReplHostError extends Error {
  constructor(operation: string) {
    super(
      `the REPL has no host for ${operation}. A runtime entrypoint installs one with ` +
        'ReplHost.around({ ... }, { at: "min" }) before the command runs.',
    );
    this.name = "ReplHostError";
  }
}

export interface ReplHostApi {
  /**
   * An opaque, URL-safe name for one new execution.
   *
   * The host mints it because how a runtime produces an unguessable identifier
   * is the runtime's business. The kernel only requires that two executions
   * never receive the same one, and the exclusive create below is what makes a
   * collision a refusal rather than a merge.
   */
  identify(): Operation<string>;
  /**
   * Create this file, and fail if anything already holds the name.
   *
   * Exclusive rather than "create if absent": the identifier is what a location
   * names, so a name already taken is somebody else's history and quietly
   * appending to it would join two executions into one.
   */
  createExclusive(path: string): Operation<void>;
  /**
   * Append one record, returning only once it has reached the file.
   *
   * The return is the acknowledgement the kernel counts on: a record that has
   * not reached the file has not happened, and nothing downstream may see it.
   */
  appendRecord(path: string, record: string): Operation<void>;
}

export const ReplHost: Api<ReplHostApi> = createApi<ReplHostApi>("ReplHost", {
  // deno-lint-ignore require-yield
  *identify(): Operation<string> {
    throw new ReplHostError("naming an execution");
  },
  // deno-lint-ignore require-yield
  *createExclusive(_path: string): Operation<void> {
    throw new ReplHostError("creating an execution's history");
  },
  // deno-lint-ignore require-yield
  *appendRecord(_path: string, _record: string): Operation<void> {
    throw new ReplHostError("appending to an execution's history");
  },
});
