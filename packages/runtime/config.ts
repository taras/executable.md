/**
 * Config Api — shared execution configuration with pluggable middleware.
 *
 * Three timeouts, three owners, no defaults:
 *
 * - `timeout` is the deadline for the whole run — preparation and execution
 *   together — and only the outer run boundary consumes it.
 * - `timeoutExec` is what each exec block gets, and only exec blocks and the
 *   built-in `timeout` modifier consume it.
 * - `timeoutFetch` is what each Fetch gets, and only Fetch consumes it.
 *
 * `undefined` means no timeout, and it is what every field starts as. An
 * operation nobody bounded runs until it finishes or the run's own deadline
 * cancels it; a general "shared timeout" that quietly bounded processes,
 * requests, prompts, and services alike is what this replaces. Override a
 * field for a scope with:
 *
 * ```typescript
 * yield* Config.around({ timeoutExec: () => 30_000 }, { at: "min" });
 * ```
 *
 * Installing at `min` is what lets a nested override win: a block's own
 * `timeout=` outranks the value the command line established for the run.
 * Omitting a field inherits the enclosing value rather than clearing it.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

export interface ConfigApi {
  /** Deadline for the entire run, in milliseconds; undefined for none. */
  timeout: number | undefined;
  /** Default timeout for each exec block, in milliseconds; undefined for none. */
  timeoutExec: number | undefined;
  /** Default timeout for each Fetch, in milliseconds; undefined for none. */
  timeoutFetch: number | undefined;
}

export const Config: Api<ConfigApi> = createApi<ConfigApi>("Config", {
  timeout: undefined,
  timeoutExec: undefined,
  timeoutFetch: undefined,
});

/**
 * A configured duration is milliseconds or nothing. Anything else fails here,
 * before the operation it was meant to bound starts, rather than disabling or
 * corrupting the bound downstream.
 */
function validate(name: keyof ConfigApi, value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Config ${name} must be a positive, finite number of milliseconds, got ${String(value)}`,
    );
  }
  return value;
}

function validated(
  name: keyof ConfigApi,
  source: Operation<number | undefined>,
): Operation<number | undefined> {
  return {
    *[Symbol.iterator]() {
      return validate(name, yield* source);
    },
  };
}

/** The validated run deadline. Read by the run boundary and nothing else. */
export const timeout: Operation<number | undefined> = validated(
  "timeout",
  Config.operations.timeout,
);

/** The validated default timeout for an exec block. */
export const timeoutExec: Operation<number | undefined> = validated(
  "timeoutExec",
  Config.operations.timeoutExec,
);

/** The validated default timeout for a Fetch. */
export const timeoutFetch: Operation<number | undefined> = validated(
  "timeoutFetch",
  Config.operations.timeoutFetch,
);
