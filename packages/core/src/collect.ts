/**
 * collect — wait for a document execution to complete and return the output.
 *
 * Convenience wrapper that unwraps the completion `Result<string>`:
 * the output string on `Ok`, a throw on `Err`.
 *
 * ```ts
 * const output = yield* collect(yield* execute(options));
 * ```
 */

import type { Operation } from "effection";
import type { DocumentExecution } from "./execute.ts";

/**
 * Wait for a document execution to complete and return the full output.
 * Throws the failure when the execution completed with `Err`.
 *
 * @param execution - A `DocumentExecution` as returned by `execute`.
 * @returns The full output string.
 */
export function* collect(execution: DocumentExecution): Operation<string> {
  const result = yield* execution;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
