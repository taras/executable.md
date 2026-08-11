/**
 * The run's three timeouts, read from the command line
 * (specs/acp-client-spec.md §Config).
 *
 * A pure function over argv: it reads no Context Apis and installs nothing, so
 * what each option means can be asserted on its own. The CLI installs the
 * values it returns through the Config Api, which is where every consumer
 * resolves them.
 *
 * The text is read from argv rather than from the parsed configuration because
 * the argument parser coerces and drops lexical forms — `1e3`, `0x10`, `.5`,
 * `+1` and `Infinity` all reach a typed field as something this grammar
 * rejects — and a duration nobody wrote must never bound a run.
 */

import { asDuration, durationError } from "@executablemd/runtime";

export interface RunTimeouts {
  /** Deadline for the whole run, in milliseconds; undefined for none. */
  timeout: number | undefined;
  /** Default for each exec block, in milliseconds; undefined for none. */
  timeoutExec: number | undefined;
  /** Default for each Fetch, in milliseconds; undefined for none. */
  timeoutFetch: number | undefined;
}

const OPTIONS: readonly (readonly [string, keyof RunTimeouts])[] = [
  ["--timeout", "timeout"],
  ["--timeout-exec", "timeoutExec"],
  ["--timeout-fetch", "timeoutFetch"],
];

/** The options that belong to `xmd run` alone. */
export const TIMEOUT_FLAGS: readonly string[] = OPTIONS.map(([flag]) => flag);

/** The text an option carried on the command line, or undefined when absent. */
export function findFlagText(args: string[], flag: string): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === flag) {
      return args[index + 1] ?? "";
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * What the command line asked for. An option nobody wrote stays undefined —
 * no timeout — and one written as anything but a duration fails the
 * invocation before it prepares a document.
 */
export function resolveRunTimeouts(args: string[]): RunTimeouts | { error: string } {
  const resolved: RunTimeouts = {
    timeout: undefined,
    timeoutExec: undefined,
    timeoutFetch: undefined,
  };
  for (const [flag, field] of OPTIONS) {
    const text = findFlagText(args, flag);
    if (text === undefined) {
      continue;
    }
    const ms = asDuration(text);
    if (ms === undefined) {
      return { error: durationError(flag, text).message };
    }
    resolved[field] = ms;
  }
  return resolved;
}
