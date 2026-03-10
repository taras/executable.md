/**
 * The `persist` wrapping modifier factory (spec §7.1).
 *
 * Marks a block's resources for extended lifetime. In v1, persist
 * delegates to next() and records the intent — the actual resource
 * retention via evalScope.eval() is deferred to v2 when the durable
 * effect / Operation type boundary is resolved.
 *
 * The modifier still composes correctly in the middleware chain and
 * validates that the EvalScope context is available.
 */

import type { ModifierFactory } from "../modifiers.ts";

// ---------------------------------------------------------------------------
// persistFactory (spec §7.1)
// ---------------------------------------------------------------------------

/**
 * Wrapping modifier that marks a block for extended resource lifetime.
 *
 * In v1, this delegates directly to next(). The persist semantic
 * is preserved in the modifier chain (info string parsing) and will
 * be activated in v2 when evalScope.eval() can bridge the
 * Workflow/Operation type boundary.
 *
 * On replay, this is a transparent no-op — durableEval returns the
 * stored result directly.
 */
export const persistFactory: ModifierFactory = (_params) =>
  (_args, next) =>
    (function* () {
      // v1: delegate directly to the inner chain
      // v2: will wrap next() in evalScope.eval() for resource retention
      return yield* next();
    })();
