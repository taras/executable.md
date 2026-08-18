/**
 * Temp-file eval block compiler.
 *
 * Compiles eval block source into generator functions by writing
 * temporary .ts files to `.xmd-eval/` and dynamically importing them.
 * Bun handles .ts natively; Node requires tsx.
 *
 * Standard imports (Effection, executable.md APIs) are captured in the
 * closure — they are not part of the `API.Env.compile` interface.
 *
 * Nothing installs this implicitly: `execute` installs no compiler. The Node
 * entrypoint calls `compileTempFile` from its own `API.Env.compile` provider,
 * and a programmatic caller that wants only a compiler installs
 * `useTempFileCompiler()`.
 */

import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import type { EvalBlock } from "@executablemd/runtime";
import { API } from "@executablemd/runtime";
// STANDARD_IMPORTS below resolve at runtime from generated eval modules;
// without these static anchors, `deno compile --exclude-unused-npm` prunes
// the packages from the binary and every eval block using them fails.
import "@effectionx/converge";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Standard import statements prepended to every generated eval module.
 * Captured in the middleware closure — not exposed on the public API.
 */
const STANDARD_IMPORTS = [
  'import { sleep, spawn, call, resource, useScope, createChannel, each, suspend, createSignal } from "effection";',
  'import { when } from "@effectionx/converge";',
  'import { fetch } from "@executablemd/runtime";',
  'import { Sample, Elicitation } from "@executablemd/core";',
];

const EVAL_DIR = ".xmd-eval";

/**
 * Compile one eval block by writing `.xmd-eval/<uuid>.ts` and importing it.
 *
 * Every host can load a file, which is what makes this the portable one;
 * Node's tsx loader in particular rejects the data: URI alternative.
 *
 * The generated file belongs to one private scope. Its removal is registered
 * against the path before anything can create it, so the file is gone before
 * this operation returns a block, throws, or finishes halting — and a removal
 * that fails for any reason other than the file already being absent leaves
 * that scope rather than being discarded.
 */
export function compileTempFile(
  source: string,
  options?: { imports: string[] },
): Operation<EvalBlock> {
  return scoped(function* () {
    yield* ensureDir(EVAL_DIR);

    const userImports = options?.imports ?? [];
    const allImports = [...STANDARD_IMPORTS, ...userImports];

    const importLines = allImports.join("\n");

    const moduleSource = [importLines, `export default function*(env) {`, source, `}`].join("\n");

    const tmpPath = resolve(EVAL_DIR, `${randomUUID()}.ts`);
    yield* ensure(() => rm(tmpPath, { force: true }));

    yield* writeTextFile(tmpPath, moduleSource);

    const fileUrl = new URL(`file://${tmpPath}`).href;
    const mod: { default: EvalBlock } = yield* until(import(fileUrl));

    if (typeof mod.default !== "function") {
      throw new Error(
        `compileTempFile: expected default export to be a generator function, got ${typeof mod.default}`,
      );
    }

    return mod.default;
  });
}

/**
 * Install the temp-file compiler as the base provider on the current scope.
 *
 * `at: "min"` puts it beneath ordinary middleware, so middleware installed
 * later can inspect a block and delegate here.
 */
export function* useTempFileCompiler(): Operation<void> {
  yield* API.Env.around(
    {
      compile([source, options]) {
        return compileTempFile(source, options);
      },
    },
    { at: "min" },
  );
}
