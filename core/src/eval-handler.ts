/**
 * The `eval` terminal modifier factory (spec §6).
 *
 * Evaluates code blocks in-process as Effection generator operations.
 * Uses durableEval from @effectionx/durable-effects for journaling.
 *
 * Unlike `exec` (subprocess), `eval` executes code in the same Effection
 * process, enabling direct access to live in-memory objects, native
 * yield* of Effection operations, and shared state across blocks.
 */

import { ephemeral } from "@effectionx/durable-streams";
import type { Json } from "@effectionx/durable-streams";
import { durableEval } from "@effectionx/durable-effects";
import { unbox } from "@effectionx/scope-eval";
import type { Operation } from "effection";
import type { ModifierFactory } from "./modifiers.ts";
import { useCodeBlock } from "./modifiers.ts";
import { EvalEnvCtx, EvalScopeCtx, PersistFlagCtx } from "./eval-env.ts";
import { compileBlock } from "./eval-context.ts";
import { transformBlock, serializeExports } from "./eval-transform.ts";

// ---------------------------------------------------------------------------
// evalFactory — terminal modifier (spec §6.2)
// ---------------------------------------------------------------------------

/**
 * Terminal modifier factory for in-process code evaluation.
 *
 * Ignores `next` — this is the terminal handler (like `exec`).
 * Reads code block metadata via useCodeBlock(), the binding environment
 * via EvalEnvCtx, and the shared VM context via EvalCtxKey.
 *
 * The block's source code is transformed to export top-level declarations
 * to the shared env, then compiled and executed inside durableEval for
 * journaling support.
 *
 * When PersistFlagCtx is true (set by the persist modifier), the compiled
 * block executes inside evalScope.eval() — resources spawned during
 * execution are retained in the persistent EvalScope until the component
 * finishes expanding.
 *
 * Eval blocks produce no rendered output — they exist for bindings
 * and side effects.
 */
export const evalFactory: ModifierFactory = (_params) =>
  (_args, _next) =>
    (function* () {
      const ctx = yield* useCodeBlock();
      const env = yield* ephemeral(EvalEnvCtx.expect());
      const persist = yield* ephemeral(PersistFlagCtx.get()) ?? false;

      // Inject output() function into env so eval blocks can produce
      // rendered output. The function is a plain synchronous call:
      //   output("some text")
      // The mutable ref is block-local; serializeExports silently
      // omits non-JSON values (functions), so output won't pollute
      // the journal. The output text itself is journaled alongside
      // exports as __output.
      const outputRef = { text: "" };
      env.values.output = (text: string) => { outputRef.text = String(text); };

      const transformed = transformBlock(
        ctx.content,
        ctx.blockId,
        Object.keys(env.values),
      );

      const result = yield* durableEval(
        `eval:${ctx.blockId}`,
        function* (
          source: string,
          bindings: Record<string, Json>,
        ): Operation<Json> {
          // Merge incoming bindings snapshot into env before execution
          Object.assign(env.values, bindings);

          // Compile the eval block via data: URI module import.
          // compileBlock is async (returns Operation) — it generates a
          // TypeScript module and imports it via data: URI.
          const fn = yield* compileBlock(
            source,
            transformed.userImports ?? [],
          );

          if (persist) {
            // Persist mode: run the compiled block inside evalScope.eval()
            // so spawned resources are retained in the persistent EvalScope.
            const evalScope = yield* EvalScopeCtx.expect();
            const blockResult = yield* evalScope.eval(
              () => fn(env.values) as unknown as Operation<void>,
            );
            unbox(blockResult);
          } else {
            // Normal mode: run the compiled block in the current scope.
            // Resources are torn down when this operation completes.
            yield* fn(env.values) as unknown as Operation<void>;
          }

          const exports = serializeExports(
            env.values,
            transformed.exports,
          );

          // Journal output text alongside exports so replay restores it
          if (outputRef.text) {
            (exports as Record<string, unknown>).__output = outputRef.text;
          }

          return exports as unknown as Json;
        },
        {
          source: transformed.code,
          language: ctx.language,
          bindings: serializeExports(env.values, transformed.imports),
        },
      );

      // On replay, restore serializable exports from the journal
      if (result.value && typeof result.value === "object") {
        const restored = result.value as Record<string, unknown>;
        // Extract __output before merging into env
        if (typeof restored.__output === "string") {
          outputRef.text = restored.__output;
        }
        // Remove __output from exports before assigning to env
        const { __output: _, ...exports } = restored;
        Object.assign(env.values, exports);
      }

      return { output: outputRef.text, exitCode: 0, stderr: "" };
    })();
