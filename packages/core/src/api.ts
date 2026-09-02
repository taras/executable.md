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
  /**
   * @param exact Whether this text is exact bytes rather than prose. The
   * presentation middleware — whitespace normalization and terminal
   * formatting — passes exact bytes through untouched, because their
   * whitespace is part of what the run produced rather than a way of writing
   * it. Absent means prose, which is what every ordinary emission is.
   */
  output(text: string, exact?: boolean): Operation<void>;
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
    *output(_text: string, _exact?: boolean): Operation<void> {},
  },
);
