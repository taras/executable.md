/**
 * collect — wait for a document execution to complete and return its value.
 *
 * Convenience wrapper that unwraps the completion `Result<Json>`:
 * the document's return value on `Ok`, a throw on `Err`.
 *
 * ```ts
 * const output = yield* collect(yield* execute(options));
 * ```
 */

import type { Operation } from "effection";
import type { Json } from "./types.ts";
import type { DocumentExecution } from "./execute.ts";

/**
 * Wait for a document execution to complete and return the document's return
 * value — its rendered output for a text root, its validated JSON for a root
 * declaring `returns`. Throws the failure when the execution completed with
 * `Err`.
 *
 * Rendered body text is a separate channel: consume `execution.output` for it.
 *
 * @param execution - A `DocumentExecution` as returned by `execute`.
 * @returns The document's return value.
 */
export function* collect(execution: DocumentExecution): Operation<Json> {
  const result = yield* execution;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
