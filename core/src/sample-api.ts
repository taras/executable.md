/**
 * The Sample Api — Effection Api for LLM inference.
 *
 * Provider components (e.g., DeepInfraProvider, OllamaProvider) install
 * middleware via `scope.around(Sample, ...)` to route sample calls to
 * their inference server.
 *
 * The `<Sample>` component calls `Sample.operations.sample()` to send
 * content to the LLM.
 *
 * The core handler throws by default — middleware must be installed
 * before any `<Sample>` component runs.
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
 * scope.around(Sample, function* ([context], next) {
 *   if (context.model !== undefined && context.model !== model) {
 *     return yield* next(context);
 *   }
 *   // ... call inference API ...
 *   return result;
 * });
 * ```
 *
 * Usage in the Sample component:
 * ```js
 * const result = yield* Sample.operations.sample(context);
 * ```
 */
export const Sample = createApi<SampleApi>("Sample", {
  // deno-lint-ignore require-yield
  *sample(_context: SampleContext): Operation<string> {
    throw new Error(
      "Sample Api requires provider middleware — " +
        "install a provider (e.g., DeepInfraProvider, OllamaProvider) or " +
        "scope.around(Sample, function*([ctx], next) { ... }) " +
        "before using <Sample> components",
    );
  },
});
