/**
 * EMA Output Api — Effection Api for streaming document output (spec §9).
 *
 * A single Api with one operation: `output`. The core handler is a no-op.
 * Behavior comes from middleware installed via `scope.around(EMA, ...)`
 * and channel delivery.
 *
 * Call sites use `EMA.operations.output(text)` inside `yield* ephemeral(...)`.
 */

import { createApi } from "effection/experimental";
import type { Operation } from "effection";

// ---------------------------------------------------------------------------
// EMA Api definition
// ---------------------------------------------------------------------------

export interface EMAApi {
  output(text: string): Operation<void>;
}

/**
 * The EMA Api instance.
 *
 * Usage in middleware:
 * ```js
 * scope.around(EMA, {
 *   *output([text], next) {
 *     const transformed = transform(text);
 *     yield* next(transformed);
 *   },
 * });
 * ```
 *
 * Usage in the emission loop:
 * ```js
 * yield* ephemeral(EMA.operations.output(text));
 * ```
 */
export const EMA = createApi<EMAApi>("EMA", {
  *output(_text: string): Operation<void> {},
});
