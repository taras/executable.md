/**
 * The `timeout` wrapping modifier factory (spec §7.3).
 *
 * Constrains a code block's execution time using timebox() from
 * @effectionx/timebox. If the block does not complete within the
 * specified duration, the factory throws an error.
 *
 * timebox() returns a Timeboxed<T> discriminated union — not a thrown
 * error. The factory checks .timeout and raises explicitly.
 */

import { timebox } from "@effectionx/timebox";
import { ephemeral } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import type { ModifierFactory } from "../modifiers.ts";
import type { CodeBlockResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

/**
 * Parse a duration string into milliseconds.
 *
 * Supports:
 * - `500ms` → 500
 * - `30s`   → 30000
 * - `2m`    → 120000
 * - `500`   → 500 (raw number, treated as ms)
 */
export function parseDuration(s: string): number {
  if (s.endsWith("ms")) return parseInt(s, 10);
  if (s.endsWith("m")) return parseInt(s, 10) * 60_000;
  if (s.endsWith("s")) return parseInt(s, 10) * 1_000;
  return parseInt(s, 10);
}

// ---------------------------------------------------------------------------
// timeoutFactory (spec §7.3)
// ---------------------------------------------------------------------------

/**
 * Wrapping modifier that constrains block execution time.
 *
 * Usage: `timeout=30s eval` or `timeout=500ms eval`
 * Default: 30s if no params provided.
 *
 * The timebox() call is an Operation (yields Effect values), so it
 * must be bridged into the Workflow context via ephemeral(). The
 * inner next() call returns a CodeBlockWorkflow which is cast to
 * Operation for timebox compatibility.
 */
export const timeoutFactory: ModifierFactory = (params) => (_args, next) =>
  (function* () {
    const ms = parseDuration(params ?? "30s");
    const result = yield* ephemeral(
      timebox(ms, () => next() as unknown as Operation<CodeBlockResult>),
    );
    if (result.timeout) {
      throw new Error(`eval block timed out after ${params ?? "30s"}`);
    }
    return result.value;
  })();
