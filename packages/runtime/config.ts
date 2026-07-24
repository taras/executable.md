/**
 * Config Api — shared execution configuration with pluggable middleware.
 *
 * Supplies the contextual timeout in milliseconds. Process, Fetch, and
 * Agent operations read it when a call does not provide an explicit
 * timeout. Override it for a scope with:
 *
 * ```typescript
 * yield* Config.around({ timeout: () => 30_000 }, { at: "min" });
 * ```
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

export interface ConfigApi {
  /** Shared timeout in milliseconds. */
  timeout: number;
}

export const Config: Api<ConfigApi> = createApi<ConfigApi>("Config", {
  timeout: 120_000,
});

/**
 * The validated contextual timeout. Always a positive, finite number of
 * milliseconds — a middleware-supplied value that is not fails loudly
 * here rather than silently disabling or corrupting timeouts downstream.
 */
export const timeout: Operation<number> = {
  *[Symbol.iterator]() {
    const value = yield* Config.operations.timeout;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Config timeout must be a positive, finite number of milliseconds, got ${String(value)}`,
      );
    }
    return value;
  },
};
