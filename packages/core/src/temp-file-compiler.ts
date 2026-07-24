/**
 * Temp-file eval block compiler middleware for Node and Bun.
 *
 * Compiles eval block source into generator functions by writing
 * temporary .ts files to `.xmd-eval/` and dynamically importing them.
 * Bun handles .ts natively; Node requires tsx.
 *
 * Standard imports (Effection, executable.md APIs) are captured in the middleware
 * closure — they are not part of the Compiler API interface.
 *
 * Installed automatically by `execute` when running on Node or Bun.
 */

import { call } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
// STANDARD_IMPORTS below resolve at runtime from generated eval modules;
// without these static anchors, `deno compile --exclude-unused-npm` prunes
// the packages from the binary and every eval block using them fails.
import "@effectionx/converge";
import "@effectionx/fetch";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Standard import statements prepended to every generated eval module.
 * Captured in the middleware closure — not exposed on the public API.
 */
const STANDARD_IMPORTS = [
  'import { sleep, spawn, call, resource, useScope, createChannel, each, suspend, createSignal } from "effection";',
  'import { when } from "@effectionx/converge";',
  'import { fetch } from "@effectionx/fetch";',
  'import { useContent, Sample, Agent, Config } from "@executablemd/core";',
  'import { findFreePort } from "@executablemd/runtime";',
];

const EVAL_DIR = ".xmd-eval";

/**
 * Install the temp-file compiler as middleware on the current scope.
 *
 * Works on Node (via tsx) and Bun (native .ts support).
 * Writes each compiled module to `.xmd-eval/<uuid>.ts`, imports it,
 * captures the default export, and deletes the file.
 */
export function* useTempFileCompiler(): Operation<void> {
  // Ensure the eval directory exists
  yield* call(() => mkdir(EVAL_DIR, { recursive: true }));

  yield* API.Compiler.around({
    *compile([source, options], next) {
      void next; // terminal middleware — does not delegate

      const userImports = options?.imports ?? [];
      const allImports = [...STANDARD_IMPORTS, ...userImports];

      const importLines = allImports.join("\n");

      const moduleSource = [importLines, `export default function*(env) {`, source, `}`].join("\n");

      const tmpPath = resolve(EVAL_DIR, `${randomUUID()}.ts`);

      yield* call(() => writeFile(tmpPath, moduleSource, "utf-8"));
      try {
        const fileUrl = new URL(`file://${tmpPath}`).href;
        const mod: {
          default: (env: Record<string, unknown>) => Generator<unknown, unknown, unknown>;
        } = yield* call(() => import(fileUrl));

        if (typeof mod.default !== "function") {
          throw new Error(
            `useTempFileCompiler: expected default export to be a generator function, got ${typeof mod.default}`,
          );
        }

        return mod.default;
      } finally {
        // Clean up temp file — don't await, fire and forget
        unlink(tmpPath).catch(() => {});
      }
    },
  });
}
