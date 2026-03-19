/**
 * Eval block compilation context (spec §5).
 */

import { createContext as createEffectionContext } from "effection";
import type { Operation } from "effection";
import { compileBlock as runtimeCompileBlock } from "@executablemd/runtime";

// ---------------------------------------------------------------------------
// EvalContext — lightweight context for the eval system
// ---------------------------------------------------------------------------

/**
 * Eval context for document runs.
 *
 * In the Deno model, there is no VM context — eval blocks are compiled
 * into data: URI modules that import their dependencies. The EvalContext
 * exists as a marker that the eval system has been initialized.
 */
export interface EvalContext {
  /** Placeholder for future per-document eval configuration. */
  initialized: true;
}

/**
 * Effection context key for the eval context.
 */
export const EvalCtxKey = createEffectionContext<EvalContext>("evalContext");

/**
 * Create an eval context for a document run.
 *
 * In the Deno model, this is lightweight — no VM sandbox creation.
 * The eval context is set on the Effection scope so eval blocks
 * can verify the eval system is initialized.
 */
export function createEvalContext(
  _globals: Record<string, unknown> = {},
): EvalContext {
  return { initialized: true };
}

/**
 * Compile transformed source code into a generator function.
 *
 * Delegates to `@executablemd/runtime` so platform-specific eval
 * compilation can be provided via runtime API middleware.
 */
export function* compileBlock(
  transformedBodyCode: string,
  userImports: string[],
): Operation<(env: Record<string, unknown>) => Generator<unknown, unknown, unknown>> {
  return yield* runtimeCompileBlock(transformedBodyCode, userImports);
}
