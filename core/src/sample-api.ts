/**
 * The Sample Api — Effection Api for LLM inference (spec §3.4).
 *
 * The `sample` modifier delegates to this Api. Providers (like
 * LlamafileProvider) install middleware via `scope.around(Sample, ...)`
 * to route sample calls to their inference server.
 *
 * The core handler throws by default — middleware must be installed
 * before any `sample` block runs.
 */

import { createApi } from "effection/experimental";
import type { Operation } from "effection";
import type { SampleContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Sample Api definition
// ---------------------------------------------------------------------------

interface SampleApi {
  sample(context: SampleContext): Operation<string>;
}

/**
 * The Sample Api instance.
 *
 * Usage in provider components (eval blocks):
 * ```js
 * const scope = yield* useScope();
 * scope.around(Sample, {
 *   *sample([context], next) {
 *     if (context.model !== undefined && context.model !== model) {
 *       return yield* next(context);
 *     }
 *     return yield* callLlamafile(baseUrl, model, context);
 *   },
 * });
 * ```
 *
 * Usage in the sample modifier:
 * ```js
 * const result = yield* Sample.operations.sample(context);
 * ```
 */
export const Sample = createApi<SampleApi>("Sample", {
  // deno-lint-ignore require-yield
  *sample(_context: SampleContext): Operation<string> {
    throw new Error(
      "sample modifier requires Sample Api middleware — " +
        "install a provider (e.g., LlamafileProvider) or " +
        "scope.around(Sample, { *sample([ctx], next) { ... } }) " +
        "before using sample blocks",
    );
  },
});
