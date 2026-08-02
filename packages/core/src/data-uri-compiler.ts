/**
 * data: URI eval block compiler middleware.
 *
 * Compiles eval block source into generator functions by importing a data:
 * URI, which leaves nothing on disk. Deno and Bun load one; Node's tsx loader
 * rejects it, so the Node entrypoint installs the temp-file compiler instead.
 * Standard imports (Effection, executable.md APIs) are captured in the middleware
 * closure — they are not part of the `API.Env.compile` interface.
 *
 * Install via `yield* useDataUriCompiler()` inside a document execution
 * scope before any eval blocks are processed.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
import type { EvalBlock } from "@executablemd/runtime";
// STANDARD_IMPORTS below resolve at runtime from generated eval modules;
// without these static anchors, `deno compile --exclude-unused-npm` prunes
// the packages from the binary and every eval block using them fails.
import "@effectionx/converge";
import "@effectionx/fetch";

/**
 * Standard import statements prepended to every generated eval module.
 * Captured in the middleware closure — not exposed on the public API.
 */
const STANDARD_IMPORTS = [
  'import { sleep, spawn, call, resource, useScope, createChannel, each, suspend, createSignal } from "effection";',
  'import { when } from "@effectionx/converge";',
  'import { fetch } from "@effectionx/fetch";',
  'import { Sample, Elicitation } from "@executablemd/core";',
  'import { findFreePort } from "@executablemd/runtime";',
];

/** Compile one eval block by importing it as a data: URI. */
export function* compileDataUri(
  source: string,
  options?: { imports: string[] },
): Operation<EvalBlock> {
  const userImports = options?.imports ?? [];
  const allImports = [...STANDARD_IMPORTS, ...userImports];

  const importLines = allImports.join("\n");

  const moduleSource = [importLines, `export default function*(env) {`, source, `}`].join("\n");

  const dataUri = `data:application/typescript,${encodeURIComponent(moduleSource)}`;
  const mod: { default: EvalBlock } = yield* until(import(dataUri));

  if (typeof mod.default !== "function") {
    throw new Error(
      `compileDataUri: expected default export to be a generator function, got ${typeof mod.default}`,
    );
  }

  return mod.default;
}

/**
 * Install the data: URI compiler as the base provider on the current scope.
 *
 * `at: "min"` puts it beneath ordinary middleware, so a policy installed
 * later — the behavior-document restriction, an instrumenting wrapper — can
 * inspect a block and delegate here.
 */
export function* useDataUriCompiler(): Operation<void> {
  yield* API.Env.around(
    {
      *compile([source, options]) {
        return yield* compileDataUri(source, options);
      },
    },
    { at: "min" },
  );
}
