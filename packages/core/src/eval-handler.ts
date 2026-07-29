import { createDurableOperation, ephemeral } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { unbox } from "@effectionx/scope-eval";
import type { Operation } from "effection";
import type { ModifierFactory } from "./modifiers.ts";
import { useCodeBlock } from "./modifiers.ts";
import { env, evalScope, persistent } from "./component-api.ts";
import { AmbientErrorPolicy } from "./errors.ts";
import { evaluationEnv } from "./eval-env.ts";
import { compileBlock } from "./eval-context.ts";
import { transformBlock, serializeExports } from "./eval-transform.ts";

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
    // Captured here, on the expansion frame, where the block's documentation or
    // <Output> policy is ambient. A persist block runs on the invocation's
    // eval-scope loop task, which predates that policy and cannot inherit it.
    const policy = (yield* ephemeral(AmbientErrorPolicy.get())) ?? "collect";

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
        // One facade per evaluation over the shared bindings: the projecting
        // operations carry this block's policy, everything else — including
        // export write-back — reaches the same record.
        const blockEnv = evaluationEnv(evalEnv.values, policy);

        if (persist) {
          // Persist mode: run the compiled block inside the eval scope
          // so spawned resources are retained in the persistent EvalScope.
          const scope = yield* evalScope;
          if (!scope) {
            throw new Error(
              `persist eval block "${ctx.blockId}" requires a component eval scope; none is in scope.`,
            );
          }
          const blockResult = yield* scope.eval(() => fn(blockEnv));
          const returnValue = unbox(blockResult);
          if (!outputRef.text && returnValue != null) {
            outputRef.text = String(returnValue);
          }
        } else {
          // Normal mode: run the compiled block in the current scope.
          // Resources are torn down when this operation completes.
          const returnValue = yield* fn(blockEnv);
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
