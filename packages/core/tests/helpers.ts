import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { execute } from "../src/execute.ts";
import type { ExecuteOptions } from "../src/execute.ts";
import type { Json } from "../src/types.ts";

/**
 * Narrow a document's value to its rendered text.
 *
 * `collect()` returns `Json` because a root declaring `returns` completes with
 * a structured value. A text root completes with its rendering, so suites that
 * assert on text narrow here instead of at every assertion.
 */
export function asText(value: Json): string {
  if (typeof value !== "string") {
    throw new Error(`expected rendered text, got ${value === null ? "null" : typeof value}`);
  }
  return value;
}

/**
 * Run a document to completion and report the outcome rather than unwrapping
 * it, with the output stream drained the way a consumer drains it.
 *
 * `collect()` throws a failure, which suits a document the suite expects to
 * succeed. A document whose outcome *is* the subject needs the `Result`.
 */
export function completion(options: ExecuteOptions): Operation<Result<Json>> {
  return (function* () {
    const execution = yield* execute(options);
    yield* forEach(function* (_chunk: string) {}, execution.output);
    return yield* execution;
  })();
}

/** The message a failed completion reports, for assertions about it. */
export function failureMessage(result: Result<Json>): string {
  return result.ok ? "" : result.error.message;
}
