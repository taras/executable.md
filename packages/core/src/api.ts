/**
 * Document Output Api — Effection Api for streaming document output (spec §9).
 *
 * A single Api with one operation: `output`. The core handler is a no-op.
 * Behavior comes from middleware installed via `yield* DocumentOutput.around(...)`
 * and channel delivery.
 *
 * Call sites use `DocumentOutput.operations.output(text)` inside `yield* ephemeral(...)`.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

export interface DocumentOutputApi {
  output(text: string): Operation<void>;
}

/**
 * The Document Output Api instance.
 *
 * Usage in middleware:
 * ```js
 * yield* DocumentOutput.around({
 *   *output([text], next) {
 *     const transformed = transform(text);
 *     yield* next(transformed);
 *   },
 * });
 * ```
 *
 * Usage in the emission loop:
 * ```js
 * yield* ephemeral(DocumentOutput.operations.output(text));
 * ```
 */
export const DocumentOutput: Api<DocumentOutputApi> = createApi<DocumentOutputApi>(
  "DocumentOutput",
  {
    *output(_text: string): Operation<void> {},
  },
);
