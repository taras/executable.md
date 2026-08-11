/**
 * The `timeout` wrapping modifier factory (spec §3.3).
 *
 * `timeout=<duration>` is what one block asks for: it boxes the block and, for
 * as long as it is delegating to the rest of the chain, it is also the exec
 * default that chain observes. Bare `timeout` asks for the run's exec default
 * instead and declares nothing of its own; with no default configured it has
 * named no duration at all, so it refuses rather than run unbounded under a
 * word that promised a bound.
 *
 * `timeout=` is neither: an explicit empty duration is a malformed one.
 *
 * The override lives in this middleware's own scope, so it exists only while
 * this middleware is on the stack. Middleware outside it observes the
 * enclosing default; the chain inside it, down to the exec terminal, observes
 * this one. Nothing else in the modifier system knows this modifier by name —
 * replacing the registry entry replaces all of it.
 */

import { timebox } from "@effectionx/timebox";
import { ephemeral } from "@executablemd/durable-streams";
import { Config, parseDuration, timeoutExec } from "@executablemd/runtime";
import { scoped } from "effection";
import type { Operation } from "effection";
import type { ModifierFactory } from "../modifiers.ts";
import type { CodeBlockResult } from "../types.ts";

/** What a bare `timeout` says when the run configured no exec default. */
export const NO_EXEC_DEFAULT =
  "`timeout` names no duration and the run configured none — write `timeout=<duration>` " +
  "on the block, or start the run with --timeout-exec=<duration>";

/**
 * What this block is bounded by, and whether it declares that for the chain.
 *
 * A declared duration is an override the inner chain must see. An inherited
 * one is already what the chain would resolve, so it installs nothing.
 */
function* effective(params: string | undefined): Operation<{
  ms: number;
  declared: boolean;
  label: string;
}> {
  if (params === undefined) {
    const inherited = yield* timeoutExec;
    if (inherited === undefined) {
      throw new Error(NO_EXEC_DEFAULT);
    }
    return { ms: inherited, declared: false, label: `${inherited}ms` };
  }
  return { ms: parseDuration(params, "timeout"), declared: true, label: params };
}

export const timeoutFactory: ModifierFactory = (params) => (_args, next) =>
  (function* () {
    const { ms, declared, label } = yield* ephemeral(effective(params));
    const result = yield* ephemeral(
      scoped(function* () {
        if (declared) {
          yield* Config.around({ timeoutExec: () => ms }, { at: "min" });
        }
        return yield* timebox(ms, () => next() as unknown as Operation<CodeBlockResult>);
      }),
    );
    if (result.timeout) {
      throw new Error(`eval block timed out after ${label}`);
    }
    return result.value;
  })();
