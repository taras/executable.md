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

import { scoped } from "effection";
import type { Operation } from "effection";
import { ephemeral } from "@executablemd/durable-streams";
import type { Workflow } from "@executablemd/durable-streams";
import type { Middleware } from "@effectionx/middleware";
import { combine } from "@effectionx/middleware";
import { Component, codeBlock } from "./component-api.ts";
import type { CodeBlockContext, CodeBlockResult, Modifier } from "./types.ts";

/**
 * Read the current code block context.
 *
 * Ergonomic alias for the Component `codeBlock()` operation, bridged via
 * `ephemeral` so it can be `yield*`'d inside modifier handlers that run
 * within durable workflows.
 */
export function useCodeBlock(): Workflow<CodeBlockContext> {
  return ephemeral(codeBlock());
}

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

export type ModifierRegistry = Map<string, ModifierFactory>;

/**
 * The exact middleware a bound `exec` may be composed from.
 *
 * A binding turns a command's status into data, so what stands between the
 * annotation and the process must not be able to change that outcome. Which
 * middleware that is cannot be read off the info string: a registered modifier
 * may carry any name, `timeout` included, and the registry answers the name the
 * document wrote with whatever was registered last. So authorization is by
 * factory identity — these exact objects, which only the execution that built
 * them can supply — and a replacement is refused however it is spelled.
 *
 * Naming stays the document's: an ordinary block reaches its registered
 * modifier by name exactly as before, this one included.
 */
export interface BoundExecChain {
  /** The built-in exec terminal this execution created. */
  exec: ModifierFactory;
  /** The built-in `timeout` middleware. */
  timeout: ModifierFactory;
}

/**
 * Create a new modifier registry, optionally inheriting from a parent.
 */
export function createModifierRegistry(parent?: ModifierRegistry): ModifierRegistry {
  const registry = new Map<string, ModifierFactory>();
  if (parent) {
    for (const [name, factory] of parent) {
      registry.set(name, factory);
    }
  }
  return registry;
}

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
 * The `context` parameter is made available to handlers via scope-local
 * `Component.operations.codeBlock()` middleware, installed for the
 * duration of the chain execution and removed when its scope exits.
 */
export function composeModifierChain(
  modifiers: Modifier[],
  context: CodeBlockContext,
  registry: ModifierRegistry,
  bound?: BoundExecChain,
): () => CodeBlockWorkflow {
  // deno-lint-ignore require-yield
  const terminal: () => CodeBlockWorkflow = function* () {
    throw new Error("No terminal modifier (exec/eval) in chain");
  };

  if (context.bound === true) {
    const refusal = refuseUnauthorizedBinding(modifiers, registry, bound);
    if (refusal !== undefined) {
      // deno-lint-ignore require-yield
      return function* () {
        throw new Error(refusal);
      };
    }
  }

  const terminalNames = new Set(["exec", "eval", "daemon", "service"]);
  const firstTerminal = modifiers.find((modifier) => terminalNames.has(modifier.name));
  if (
    modifiers.some((modifier) => modifier.name === "ephemeral") &&
    firstTerminal?.name !== "eval"
  ) {
    return function* () {
      throw new Error("ephemeral is valid only with the eval terminal modifier");
    };
  }
  const serviceIndex = modifiers.findIndex((modifier) => modifier.name === "service");
  if (serviceIndex > 0) {
    return function* () {
      throw new Error("service must be the outermost modifier");
    };
  }
  if (serviceIndex === 0 && !modifiers.some((modifier) => modifier.name === "exec")) {
    return function* () {
      throw new Error("service requires the exec detection modifier");
    };
  }

  // Build the middleware array — each factory is called with its params
  const middlewares: ModifierMiddleware[] = [];
  for (const mod of modifiers) {
    const factory = registry.get(mod.name);
    if (!factory) {
      const missingName = mod.name;
      // deno-lint-ignore require-yield
      return function* () {
        throw new Error(`Unknown modifier: ${missingName}`);
      };
    }
    middlewares.push(factory(mod.params));
  }

  // Combine all middlewares into a single middleware
  const composed = combine(middlewares);

  // Return a thunk that provides the code block contextually for the
  // duration of the chain, then runs the composed middleware.
  // The cast is safe because CodeBlockWorkflow yields DurableEffect
  // values which extend Effect — structurally compatible with Operation.
  return function* () {
    return yield* ephemeral(
      scoped(function* () {
        yield* Component.around(
          {
            // deno-lint-ignore require-yield
            *codeBlock(_args, _next) {
              return context;
            },
          },
          { at: "min" },
        );
        return yield* composed([], terminal) as unknown as Operation<CodeBlockResult>;
      }),
    );
  };
}

/**
 * Why a bound block's chain is not the one it is allowed to have.
 *
 * Every word is resolved through the registry the document will actually run,
 * and compared with the middleware this execution built. A registered
 * replacement is therefore refused whether it took the name of the terminal or
 * the name of the one wrapping modifier — and refused here, where nothing has
 * been composed, so neither it nor a process runs.
 */
function refuseUnauthorizedBinding(
  modifiers: Modifier[],
  registry: ModifierRegistry,
  bound: BoundExecChain | undefined,
): string | undefined {
  if (bound === undefined) {
    return '`as="name"` requires the built-in exec terminal, which this execution did not install.';
  }
  const terminal = modifiers.at(-1);
  if (terminal === undefined || registry.get(terminal.name) !== bound.exec) {
    return '`as="name"` is supported only with the `exec` terminal.';
  }
  const wrapping = modifiers
    .slice(0, -1)
    .find((modifier) => registry.get(modifier.name) !== bound.timeout);
  if (wrapping !== undefined) {
    return (
      `only the built-in \`timeout\` modifier may wrap a bound \`exec\`. ` +
      `Got: "${wrapping.name}".`
    );
  }
  return undefined;
}

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
