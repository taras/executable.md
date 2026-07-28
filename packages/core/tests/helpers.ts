/**
 * Shared helpers for core test suites.
 */

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
