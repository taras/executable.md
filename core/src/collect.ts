/**
 * collect — wait for a document execution to complete and return the output.
 *
 * Convenience wrapper that `yield*`s the execution to get the full
 * output string. Equivalent to `yield* execution` but reads more
 * clearly at call sites.
 *
 * ```ts
 * const output = yield* collect(yield* runDocument(options));
 * ```
 */

import type { Operation } from "effection";
import type { DocumentExecution } from "./run-document.ts";

/**
 * Wait for a document execution to complete and return the full output.
 *
 * @param execution - A `DocumentExecution` as returned by `runDocument`.
 * @returns The full output string.
 */
export function* collect(execution: DocumentExecution): Operation<string> {
  return yield* execution;
}
