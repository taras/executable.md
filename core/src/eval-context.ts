/**
 * Eval block compilation (spec §5).
 */

import type { Operation } from "effection";
import { compile as runtimeCompile } from "@executablemd/runtime";

/**
 * Compile transformed source code into a generator function.
 *
 * Delegates to `@executablemd/runtime` so platform-specific
 * compilation can be provided via API.Compiler middleware.
 */
export function compileBlock(
  transformedBodyCode: string,
  userImports: string[],
): Operation<(env: Record<string, unknown>) => Generator<unknown, unknown, unknown>> {
  return runtimeCompile(transformedBodyCode, { imports: userImports });
}
