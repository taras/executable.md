import { createDurableOperation, ephemeral } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { unbox } from "@effectionx/scope-eval";
import type { Operation } from "effection";
import type { ModifierFactory } from "./modifiers.ts";
import { useCodeBlock } from "./modifiers.ts";
import { env, evalScope, persistent } from "./component-api.ts";
import { compileBlock } from "./eval-context.ts";
import { transformBlock, serializeExports } from "./eval-transform.ts";

// ---------------------------------------------------------------------------
// evalFactory — terminal modifier (spec §6.2)
// ---------------------------------------------------------------------------

export const evalFactory: ModifierFactory = (_params) => (_args, _next) =>
  (function* () {
    const ctx = yield* useCodeBlock();
    const evalEnv = yield* ephemeral(env());
    if (!evalEnv) {
      throw new Error(
        `eval block "${ctx.blockId}" requires a binding environment; none is in scope.`,
      );
    }
    const persist = yield* ephemeral(persistent());

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

        // Compile the eval block via data: URI module import.
        // compileBlock is async (returns Operation) — it generates a
        // TypeScript module and imports it via data: URI.
        const fn = yield* compileBlock(transformed.code, transformed.userImports ?? []);

        if (persist) {
          // Persist mode: run the compiled block inside the eval scope
          // so spawned resources are retained in the persistent EvalScope.
          const scope = yield* evalScope();
          if (!scope) {
            throw new Error(
              `persist eval block "${ctx.blockId}" requires a component eval scope; none is in scope.`,
            );
          }
          const blockResult = yield* scope.eval(
            () => fn(evalEnv.values) as unknown as Operation<unknown>,
          );
          const returnValue = unbox(blockResult);
          if (!outputRef.text && returnValue != null) {
            outputRef.text = String(returnValue);
          }
        } else {
          // Normal mode: run the compiled block in the current scope.
          // Resources are torn down when this operation completes.
          const returnValue = yield* fn(evalEnv.values) as unknown as Operation<unknown>;
          if (!outputRef.text && returnValue != null) {
            outputRef.text = String(returnValue);
          }
        }

        const exports = serializeExports(evalEnv.values, transformed.exports);

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
