/**
 * The `persist` wrapping modifier factory (spec §7.1).
 *
 * Extends resource lifetime from block scope to the component's eval-scope.
 * By default, resources spawned inside a block's operation are scoped to
 * that block's execution — they are torn down when the block's generator
 * returns. With `persist`, the eval handler runs the compiled block inside
 * evalScope.eval(), which retains spawned resources in the persistent
 * EvalScope until the component finishes expanding.
 *
 * Implementation: persist sets a context flag (PersistFlagCtx) that the
 * eval handler reads. The eval handler then runs fn(env) inside
 * evalScope.eval() instead of directly. This avoids wrapping the entire
 * modifier chain (which includes durable effects that can't cross the
 * evalScope channel boundary).
 */

import { ephemeral } from "@executablemd/durable-streams";
import type { ModifierFactory } from "../modifiers.ts";
import { PersistFlagCtx } from "../eval-env.ts";

// ---------------------------------------------------------------------------
// persistFactory (spec §7.1)
// ---------------------------------------------------------------------------

/**
 * Wrapping modifier that marks a block for persistent resource lifetime.
 *
 * Sets PersistFlagCtx=true on the scope for the duration of the inner
 * chain. The eval handler reads this flag and routes the compiled block
 * execution through evalScope.eval() for resource retention.
 */
export const persistFactory: ModifierFactory = (_params) => (_args, next) =>
  (function* () {
    // Set the persist flag on the scope, then delegate to the inner chain.
    // evalFactory will read this flag and route execution through
    // evalScope.eval() for resource retention.
    return yield* ephemeral(
      PersistFlagCtx.with(true, function* () {
        return yield* next() as unknown as import("effection").Operation<
          import("../types.ts").CodeBlockResult
        >;
      }),
    );
  })();
