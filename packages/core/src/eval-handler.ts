/**
 * The `eval` terminal modifier factory (spec §4).
 *
 * A block's execution is durable: its exported values are journaled, and a
 * replay restores them without running the executor again. That is why the
 * compiled block runs with `retain()` rejected — see `withoutRetain`.
 */

import { createDurableOperation, ephemeral } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { unbox } from "@effectionx/scope-eval";
import { scoped } from "effection";
import type { Operation } from "effection";
import type { ModifierFactory } from "./modifiers.ts";
import { useCodeBlock } from "./modifiers.ts";
import { Component, env, evalScope, persistent } from "./component-api.ts";
import { ErrorMode } from "./errors.ts";
import { commitExports, evaluationEnv } from "./eval-env.ts";
import { compileBlock } from "./eval-context.ts";
import { transformBlock, serializeExports } from "./eval-transform.ts";
import {
  commitLiveExports,
  liveEnvironment,
  validateLiveExports,
  validateLiveOverlay,
} from "./live-env.ts";
import { EphemeralEval, EphemeralEvalOutputError } from "./modifiers/ephemeral.ts";
import type { CodeBlockContext, CodeBlockResult, EvalEnv } from "./types.ts";

function* runEphemeralEval(
  ctx: CodeBlockContext,
  evalEnv: EvalEnv,
  persist: boolean,
  mode: import("./errors.ts").ErrorMode,
): Operation<CodeBlockResult> {
  const live = liveEnvironment(evalEnv);
  validateLiveOverlay(evalEnv, live);
  let outputAttempted = false;
  const merged: Record<string, unknown> = { ...evalEnv.values, ...live.values };
  merged.output = (_value: unknown): never => {
    outputAttempted = true;
    throw new EphemeralEvalOutputError("ephemeral eval cannot produce document output");
  };

  const transformed = transformBlock(ctx.content, ctx.blockId, Object.keys(merged));
  validateLiveExports(transformed.exports, evalEnv);
  const fn = yield* compileBlock(transformed.code, transformed.userImports ?? []);
  const blockEnv = evaluationEnv(merged, mode);

  let returnValue: unknown;
  if (persist) {
    const scope = yield* evalScope;
    if (!scope) {
      throw new Error(
        `persist ephemeral eval block "${ctx.blockId}" requires a component eval scope; none is in scope.`,
      );
    }
    returnValue = unbox(yield* scope.eval(() => fn(blockEnv)));
  } else {
    returnValue = yield* scoped(() => fn(blockEnv));
  }

  if (outputAttempted) {
    throw new EphemeralEvalOutputError("ephemeral eval cannot produce document output");
  }
  if (returnValue !== undefined && returnValue !== null) {
    throw new EphemeralEvalOutputError("ephemeral eval cannot return document output");
  }

  commitLiveExports(live, blockEnv, transformed.exports);
  return { output: "", exitCode: 0, stderr: "" };
}

/**
 * Refuse `retain()` for the scope this is installed in.
 *
 * `retain()` gives a resource invocation-site lifetime, which only holds when
 * the code that asked for it runs on every execution. An eval block does not:
 * a replay restores its exports from the journal and never enters the
 * executor, so the restored value would name a resource nothing re-created.
 * Rejecting is the honest answer — a block that needs a resource to outlive it
 * belongs in a TypeScript component.
 */
function rejectRetain(blockId: string): Operation<void> {
  return Component.around(
    {
      // deno-lint-ignore require-yield
      *retain(_args, _next) {
        throw new Error(
          `eval block "${blockId}" cannot retain a resource at the invocation site. ` +
            "Eval execution is durable: a replay restores this block's values without " +
            "running it, leaving nothing to re-establish the resource. Acquire it in a " +
            "TypeScript component, which runs on every execution.",
        );
      },
    },
    { at: "min" },
  );
}

/**
 * Run a compiled block on the expansion frame with `retain()` refused.
 *
 * The refusal is scoped to the block: expansion continues on this frame
 * afterwards, and content projected later in the same invocation must still
 * reach the invocation's own provider.
 */
function runBlock<T>(blockId: string, block: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* rejectRetain(blockId);
    return yield* block();
  });
}

export const evalFactory: ModifierFactory = (_params) => (_args, _next) =>
  (function* () {
    const ctx = yield* useCodeBlock();
    const evalEnv = yield* ephemeral(env);
    if (!evalEnv) {
      throw new Error(
        `eval block "${ctx.blockId}" requires a binding environment; none is in scope.`,
      );
    }
    const persist = yield* ephemeral(persistent);
    const reconstruct = yield* ephemeral(EphemeralEval.get());
    // Captured here, on the expansion frame, where the block's documentation or
    // <Output> error mode is ambient. A persist block runs on the invocation's
    // eval-scope loop task, which predates that error mode and cannot inherit it.
    const mode = (yield* ephemeral(ErrorMode.get())) ?? "print";

    if (reconstruct) {
      return yield* ephemeral(runEphemeralEval(ctx, evalEnv, persist, mode));
    }

    // Inject output() function into env so eval blocks can produce
    // rendered output. The function is a plain synchronous call:
    //   output("some text")
    // The mutable ref is block-local; serializeExports silently
    // omits non-JSON values (functions), so output won't pollute
    // the journal. The output text itself is journaled alongside
    // exports as __output.
    const outputRef = { text: "" };
    evalEnv.values.output = (text: string) => {
      outputRef.text = String(text);
    };

    const transformed = transformBlock(ctx.content, ctx.blockId, Object.keys(evalEnv.values));

    const bindings = serializeExports(evalEnv.values, transformed.imports);
    const result = (yield createDurableOperation<Json>(
      {
        type: "eval",
        name: `eval:${ctx.blockId}`,
        ...(ctx.language ? { language: ctx.language } : {}),
      },
      function* (): Operation<Json> {
        // Merge incoming bindings snapshot into env before execution
        Object.assign(evalEnv.values, bindings);

        const fn = yield* compileBlock(transformed.code, transformed.userImports ?? []);
        // A snapshot of the bindings as they stand now, with this block's
        // error mode bound into its projection closures. The block writes its
        // exports here; they are published below once it succeeds.
        const blockEnv = evaluationEnv(evalEnv.values, mode);

        if (persist) {
          // Persist mode: run the compiled block inside the eval scope
          // so spawned resources are retained in the persistent EvalScope.
          const scope = yield* evalScope;
          if (!scope) {
            throw new Error(
              `persist eval block "${ctx.blockId}" requires a component eval scope; none is in scope.`,
            );
          }
          // Installed inside the eval, on the loop task the block runs on —
          // the expansion scope is not on its chain — and deliberately not in
          // a nested scope: a `persist` block's spawned work and installed
          // middleware belong to the loop task and must outlive the block.
          // Every task that anchors here is durable eval work, and the
          // invocation body's own provider is nested deeper, so it still wins
          // for the component itself.
          const blockResult = yield* scope.eval(function* () {
            yield* rejectRetain(ctx.blockId);
            return yield* fn(blockEnv);
          });
          const returnValue = unbox(blockResult);
          if (!outputRef.text && returnValue != null) {
            outputRef.text = String(returnValue);
          }
        } else {
          // Normal mode: run the compiled block in the current scope.
          // Resources are torn down when this operation completes.
          const returnValue = yield* runBlock(ctx.blockId, () => fn(blockEnv));
          if (!outputRef.text && returnValue != null) {
            outputRef.text = String(returnValue);
          }
        }

        // Publish first, so a later block — and any persistent work already
        // holding a reference — sees live values the journal cannot carry.
        commitExports(evalEnv.values, blockEnv, transformed.exports);

        const exports = serializeExports(blockEnv, transformed.exports);

        if (outputRef.text) {
          (exports as Record<string, unknown>).__output = outputRef.text;
        }

        return { value: exports as unknown as Json } as Json;
      },
    )) as unknown as { value: Json };

    if (result.value && typeof result.value === "object") {
      const restored = result.value as Record<string, unknown>;
      // Extract __output before merging into env
      if (typeof restored.__output === "string") {
        outputRef.text = restored.__output;
      }
      // Remove __output from exports before assigning to env
      const { __output: _, ...exports } = restored;
      Object.assign(evalEnv.values, exports);
    }

    return { output: outputRef.text, exitCode: 0, stderr: "" };
  })();
