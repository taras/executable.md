/**
 * Shared durable sample helper.
 *
 * Journals a Sample Api call via createDurableOperation so that
 * replays return the stored LLM response without re-calling the
 * inference server.
 *
 * Used by both the `sample` modifier (code block level) and the
 * `Sample` component (component level).
 */

import {
  createDurableOperation,
  type Json,
  type Workflow,
} from "@effectionx/durable-streams";
import { unbox } from "@effectionx/scope-eval";
import type { Operation } from "effection";
import { EvalScopeCtx } from "../eval-env.ts";
import { Sample } from "../sample-api.ts";
import type { SampleContext } from "../types.ts";

/**
 * Journal a Sample Api call and route through the EvalScope middleware.
 *
 * Returns a Workflow (not an Operation) because it yields DurableEffects
 * via createDurableOperation. This makes it composable with the modifier
 * chain which also yields DurableEffects.
 *
 * On live execution: routes through evalScope.eval() so middleware
 * installed by persist-eval blocks (e.g., LlamafileProvider) is visible.
 * The LLM response is journaled via createDurableOperation.
 *
 * On replay: returns the stored response without re-calling the
 * inference server.
 *
 * @param context - SampleContext describing the content to sample
 * @param name - Journal entry name (e.g., "sample:Sample" or "sample:echo hello")
 */
export function* durableSample(
  context: SampleContext,
  name: string,
): Workflow<string> {
  const sampledOutput = (yield createDurableOperation<Json>(
    { type: "sample", name },
    function* (): Operation<Json> {
      // Route through the EvalScope so middleware installed by
      // persist-eval blocks (e.g., LlamafileProvider) is visible.
      // evalScope.eval() runs the operation in the same spawned task
      // where Sample.around() installed middleware — GetScope returns
      // that scope, so the middleware chain is found.
      const evalScope = yield* EvalScopeCtx.expect();
      const boxedResult = yield* evalScope.eval(
        () => Sample.operations.sample(context),
      );
      return unbox(boxedResult) as unknown as Json;
    },
  )) as unknown as string;
  return sampledOutput;
}
