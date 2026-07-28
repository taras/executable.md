/**
 * Eval block compilation (spec §5).
 */

import type { Operation } from "effection";
import { compile as runtimeCompile } from "@executablemd/runtime";
import type { EvalBlock } from "@executablemd/runtime";

/**
 * Compile transformed source code into a runnable eval block.
 *
 * Delegates to `@executablemd/runtime` so platform-specific
 * compilation can be provided via API.Env.compile middleware.
 */
export function compileBlock(
  transformedBodyCode: string,
  userImports: string[],
): Operation<EvalBlock> {
  return runtimeCompile(transformedBodyCode, { imports: userImports });
}
