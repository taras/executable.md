/**
 * Modifier system — middleware chain for code block execution (spec §3.3).
 *
 * Each modifier in the info string is a middleware handler that wraps the next
 * handler in the chain. The rightmost modifier (exec/eval) is the terminal.
 */

import type {
  CodeBlockContext,
  CodeBlockResult,
  Modifier,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

/**
 * Modifier handler — same shape as Effection middleware.
 *
 * - `context`: the code block being processed
 * - `params`: modifier params (e.g. "brief" from sample=brief), or undefined
 * - `next`: calls the next handler in the chain (the inner modifier)
 *
 * Terminal handlers (exec, eval) ignore `next`.
 * Wrapping handlers (silent, sample) call `next()` and transform the result.
 */
export type ModifierHandler = (
  context: CodeBlockContext,
  params: string | undefined,
  next: () => Generator<unknown, CodeBlockResult, unknown>,
) => Generator<unknown, CodeBlockResult, unknown>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ModifierRegistry = Map<string, ModifierHandler>;

/**
 * Create a new modifier registry, optionally inheriting from a parent.
 */
export function createModifierRegistry(
  parent?: ModifierRegistry,
): ModifierRegistry {
  const registry = new Map<string, ModifierHandler>();
  if (parent) {
    for (const [name, handler] of parent) {
      registry.set(name, handler);
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Chain composition (spec §3.3)
// ---------------------------------------------------------------------------

/**
 * Compose a modifier chain from the info string, right-to-left (innermost first).
 */
export function composeModifierChain(
  modifiers: Modifier[],
  context: CodeBlockContext,
  registry: ModifierRegistry,
): () => Generator<unknown, CodeBlockResult, unknown> {
  let chain: () => Generator<unknown, CodeBlockResult, unknown> =
    function* () {
      throw new Error("No terminal modifier (exec/eval) in chain");
    };

  // Build right-to-left: rightmost modifier is innermost
  for (let i = modifiers.length - 1; i >= 0; i--) {
    const mod = modifiers[i]!;
    const handler = registry.get(mod.name);
    if (!handler) {
      const missingName = mod.name;
      const outerChain = chain;
      chain = function* () {
        throw new Error(`Unknown modifier: ${missingName}`);
      };
      continue;
    }
    const inner = chain;
    const params = mod.params;
    chain = function* () {
      return yield* handler(context, params, inner);
    };
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Command construction (spec §3.6)
// ---------------------------------------------------------------------------

/**
 * Build the command array for executing a code block.
 */
export function buildCommand(language: string, content: string): string[] {
  switch (language.toLowerCase()) {
    case "bash":
    case "sh":
      return ["bash", "-c", content];
    case "python":
    case "py":
      return ["python", "-c", content];
    case "node":
    case "javascript":
    case "js":
      return ["node", "-e", content];
    default:
      return [language, "-c", content];
  }
}
