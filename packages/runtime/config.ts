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
 *
 * `verbose` is the fourth field and is not a timeout. It says whether the
 * scope reading it renders verbose-only content, it is `false` until something
 * says otherwise, and it is installed and overridden exactly the way a timeout
 * is. It bounds nothing, opens nothing and decides nothing about authority: a
 * component reads it to choose between rendering its content and rendering
 * nothing, and the host's own presentation — the journal, the event echo, the
 * testing report — is decided by the command line rather than by this field.
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
  /** Whether this scope renders verbose-only content; false for none. */
  verbose: boolean;
}

export const Config: Api<ConfigApi> = createApi<ConfigApi>("Config", {
  timeout: undefined,
  timeoutExec: undefined,
  timeoutFetch: undefined,
  verbose: false,
});

/** The three fields a duration is configured for. `verbose` is not one. */
type TimeoutField = "timeout" | "timeoutExec" | "timeoutFetch";

/**
 * A configured duration is milliseconds or nothing. Anything else fails here,
 * before the operation it was meant to bound starts, rather than disabling or
 * corrupting the bound downstream.
 */
function validate(name: TimeoutField, value: number | undefined): number | undefined {
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
  name: TimeoutField,
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

/**
 * The validated verbosity of the reading scope.
 *
 * There is no "absent" verbosity the way there is an absent timeout: a scope
 * either renders verbose-only content or it does not. Anything that is not a
 * boolean — what an untyped JavaScript consumer can still install — fails
 * here, where the reader asked, rather than being read as truthiness by
 * whichever component asked first.
 */
export const verbose: Operation<boolean> = {
  *[Symbol.iterator]() {
    const configured = yield* Config.operations.verbose;
    if (typeof configured !== "boolean") {
      throw new Error(`Config verbose must be a boolean, got ${String(configured)}`);
    }
    return configured;
  },
};
