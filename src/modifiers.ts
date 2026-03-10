/**
 * Modifier system — middleware chain for code block execution (spec §3.3).
 *
 * Each modifier in the info string is a middleware that wraps the next
 * handler in the chain. The rightmost modifier (exec/eval) is the terminal.
 *
 * Aligns with Effection v4.1's Middleware<TArgs, TReturn> pattern:
 * - CodeBlockContext is delivered via Effection Context (scope-inherited)
 * - Each modifier's params are captured in a factory closure
 * - The middleware signature is Middleware<[], CodeBlockWorkflow>
 */

import { createContext } from "effection";
import type { Operation } from "effection";
import { ephemeral } from "@effectionx/durable-streams";
import type { Workflow } from "@effectionx/durable-streams";
import type { Middleware } from "./middleware.ts";
import { combine } from "./middleware.ts";
import type {
  CodeBlockContext,
  CodeBlockResult,
  Modifier,
} from "./types.ts";

// ---------------------------------------------------------------------------
// CodeBlock context — Effection scope-inherited value
// ---------------------------------------------------------------------------

/**
 * Effection Context holding the current code block's metadata.
 *
 * Set on the scope via `CodeBlockCtx.with()` before the modifier chain
 * runs. Handlers that need the code block info (language, content,
 * componentName) read it via `useCodeBlock()` instead of receiving it
 * as a parameter.
 */
export const CodeBlockCtx = createContext<CodeBlockContext>("codeBlock");

/**
 * Read the current code block context from the Effection scope.
 *
 * Returns a Workflow-compatible generator (bridged via `ephemeral`)
 * so it can be `yield*`'d inside modifier handlers that run within
 * durable workflows.
 *
 * @example
 * ```typescript
 * const myFactory: ModifierFactory = (_params) =>
 *   (_args, next) => function* () {
 *     const ctx = yield* useCodeBlock();
 *     console.log(ctx.language);
 *     return yield* next();
 *   }();
 * ```
 */
export function useCodeBlock(): Workflow<CodeBlockContext> {
  return ephemeral(CodeBlockCtx.expect());
}

// ---------------------------------------------------------------------------
// Modifier middleware types
// ---------------------------------------------------------------------------

/**
 * The generator type returned by modifier middleware — a workflow that
 * yields durable effects and returns a CodeBlockResult.
 */
export type CodeBlockWorkflow = Workflow<CodeBlockResult>;

/**
 * A modifier middleware — conforms to Middleware<[], CodeBlockWorkflow>.
 *
 * Takes no arguments (context is on the scope, params are in the factory
 * closure) and delegates to `next()` which runs the rest of the chain.
 */
export type ModifierMiddleware = Middleware<[], CodeBlockWorkflow>;

/**
 * A modifier factory — takes per-modifier params and returns a middleware.
 *
 * Each modifier registered in the registry is a factory. When the chain
 * is composed, the factory is called with the parsed params from the info
 * string (e.g., "brief" from `sample=brief`), and the returned middleware
 * is combined into the chain.
 *
 * @example
 * ```typescript
 * const timeoutFactory: ModifierFactory = (params) =>
 *   (_args, next) => function* () {
 *     const ms = parseInt(params ?? "30000", 10);
 *     // ... timeout logic
 *     return yield* next();
 *   }();
 * ```
 */
export type ModifierFactory = (params: string | undefined) => ModifierMiddleware;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ModifierRegistry = Map<string, ModifierFactory>;

/**
 * Create a new modifier registry, optionally inheriting from a parent.
 */
export function createModifierRegistry(
  parent?: ModifierRegistry,
): ModifierRegistry {
  const registry = new Map<string, ModifierFactory>();
  if (parent) {
    for (const [name, factory] of parent) {
      registry.set(name, factory);
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Chain composition (spec §3.3)
// ---------------------------------------------------------------------------

/**
 * Compose a modifier chain from the info string.
 *
 * Uses the reusable `combine()` primitive from `./middleware.ts` to
 * build the chain. Each modifier's factory is called with its parsed
 * params to produce a middleware, then all middlewares are combined.
 *
 * The chain is composed **left-to-right for wrapping order**: the
 * leftmost modifier is the outermost wrapper. `combine` handles the
 * right-to-left reduction internally.
 *
 * The `context` parameter is made available to handlers via Effection's
 * `CodeBlockCtx.with()`, which sets the context on the scope for the
 * duration of the chain execution and restores it afterward.
 */
export function composeModifierChain(
  modifiers: Modifier[],
  context: CodeBlockContext,
  registry: ModifierRegistry,
): () => CodeBlockWorkflow {
  const terminal: () => CodeBlockWorkflow = function* () {
    throw new Error("No terminal modifier (exec/eval) in chain");
  };

  // Build the middleware array — each factory is called with its params
  const middlewares: ModifierMiddleware[] = [];
  for (const mod of modifiers) {
    const factory = registry.get(mod.name);
    if (!factory) {
      const missingName = mod.name;
      return function* () {
        throw new Error(`Unknown modifier: ${missingName}`);
      };
    }
    middlewares.push(factory(mod.params));
  }

  // Combine all middlewares into a single middleware
  const composed = combine(middlewares);

  // Return a thunk that sets CodeBlockCtx for the duration of the
  // chain via Context.with(), then runs the composed middleware.
  // The cast is safe because CodeBlockWorkflow yields DurableEffect
  // values which extend Effect — structurally compatible with Operation.
  return function* () {
    return yield* ephemeral(
      CodeBlockCtx.with(context, function* () {
        return yield* composed([], terminal) as unknown as Operation<CodeBlockResult>;
      }),
    );
  };
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
