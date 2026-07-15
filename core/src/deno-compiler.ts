/**
 * Deno-specific eval block compiler middleware.
 *
 * Compiles eval block source into generator functions via data: URIs.
 * Standard imports (Effection, executable.md APIs) are captured in the middleware
 * closure — they are not part of the Compiler API interface.
 *
 * Install via `yield* useDenoCompiler()` inside a document execution
 * scope before any eval blocks are processed.
 */

import { call } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";

/**
 * Standard import statements prepended to every generated eval module.
 * Captured in the middleware closure — not exposed on the public API.
 */
const STANDARD_IMPORTS = [
  'import { sleep, spawn, call, resource, useScope, createChannel, each, suspend, createSignal } from "effection";',
  'import { when } from "@effectionx/converge";',
  'import { fetch } from "@effectionx/fetch";',
  'import { useContent, Sample } from "@executablemd/core";',
  'import { findFreePort } from "@executablemd/runtime";',
];

/**
 * Install the Deno data: URI compiler as middleware on the current scope.
 *
 * Must be called inside an Effection scope (e.g., inside `runDocument`'s
 * spawned task) before any eval blocks execute.
 */
export function* useDenoCompiler(): Operation<void> {
  yield* API.Compiler.around({
    *compile([source, options], next) {
      void next; // terminal middleware — does not delegate

      const userImports = options?.imports ?? [];
      const allImports = [...STANDARD_IMPORTS, ...userImports];

      const importLines = allImports.join("\n");

      const moduleSource = [importLines, `export default function*(env) {`, source, `}`].join("\n");

      const dataUri = `data:application/typescript,${encodeURIComponent(moduleSource)}`;
      const mod: {
        default: (env: Record<string, unknown>) => Generator<unknown, unknown, unknown>;
      } = yield* call(() => import(dataUri));

      if (typeof mod.default !== "function") {
        throw new Error(
          `useDenoCompiler: expected default export to be a generator function, got ${typeof mod.default}`,
        );
      }

      return mod.default;
    },
  });
}
