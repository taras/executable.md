/**
 * Build the @executablemd/web browser client.
 *
 * Usage:
 *   deno task build:web
 *
 * Bundles `packages/web/client/main.tsx` with Deno's browser bundler and writes
 * the result, together with the default shadcn stylesheet, into the generated
 * module `packages/web/generated/client-bundle.ts` — gitignored, not a
 * repository source file. A release builds it into the package immediately
 * before packaging (specs/release-process-spec.md); this task exists so the
 * server can serve those bytes and so the test suite can bundle and inspect
 * real output without a tracked artifact to keep in sync.
 *
 * Determinism: run under Deno 2.9.1 (CI pins it). Two clean runs produce
 * byte-identical output, which the test suite asserts.
 *
 * Bundling is Deno-only, but the shape of the generated module is not: it is
 * serialized by `scripts/lib/web-client-module.ts`, which every runtime's suite
 * exercises.
 *
 * The bundle carries no `new Function` and no eval path. RJSF's runtime Ajv
 * validator would introduce one, but the client never uses it: schemas are
 * precompiled server-side and the client builds its validator from the
 * precompiled functions through `createPrecompiledValidator`. The only path
 * that still pulls the runtime validator in is `@rjsf/core`'s test-only
 * `getTestRegistry`, reached transitively through the shadcn theme's barrel
 * import. `@rjsf/validator-ajv8` has no import-time side effects, so declaring
 * it side-effect-free lets the bundler tree-shake that dead path out. The
 * package ships without the declaration, so the build patches the resolved
 * `node_modules` copy with the true fact for the duration of the bundle step
 * and restores its exact original bytes afterward, on every exit path —
 * including a halt that lands mid-write, which is why the patch goes through
 * `scripts/lib/manifest-patch.ts` rather than a bare `ensure()`.
 */

import { ensure, main, scoped, until } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";

import { patchUntilExit } from "./lib/manifest-patch.ts";
import { byteLength, generatedModule } from "./lib/web-client-module.ts";

const repoRoot = new URL("../", import.meta.url);

const CLIENT_ENTRY = "packages/web/client/main.tsx";
const THEME_CSS = "node_modules/@rjsf/shadcn/dist/default.css";
const OUTPUT_MODULE = "packages/web/generated/client-bundle.ts";
const SIDE_EFFECT_FREE_NAME = "@rjsf/validator-ajv8";
const SIDE_EFFECT_FREE_VERSION = "6.7.1";

/** The manifest a build patches. A suite hands `markSideEffectFree` a copy of it. */
export const SIDE_EFFECT_FREE_MANIFEST = new URL(
  "node_modules/@rjsf/validator-ajv8/package.json",
  repoRoot,
);

function* run(command: string, args: string[]): Operation<void> {
  yield* exec(command, { arguments: args, cwd: new URL(repoRoot).pathname }).expect();
}

/**
 * Declare `path`'s package side-effect-free for the rest of the current scope.
 *
 * `patchUntilExit` owns restoring the original bytes, including on the halt
 * path where the patching write may still be in flight.
 */
export function* markSideEffectFree(path: URL): Operation<void> {
  const original = yield* readTextFile(path);
  const manifest = JSON.parse(original);
  if (manifest.name !== SIDE_EFFECT_FREE_NAME || manifest.version !== SIDE_EFFECT_FREE_VERSION) {
    throw new Error(
      `${path.pathname} resolved to ${manifest.name}@${manifest.version}, expected ` +
        `${SIDE_EFFECT_FREE_NAME}@${SIDE_EFFECT_FREE_VERSION}`,
    );
  }
  if ("sideEffects" in manifest) {
    throw new Error(
      `${path.pathname} already declares "sideEffects": ${JSON.stringify(manifest.sideEffects)} — ` +
        `refusing to overwrite existing package metadata`,
    );
  }
  const patched = `${JSON.stringify({ ...manifest, sideEffects: false }, null, 2)}\n`;
  yield* patchUntilExit(path, original, patched);
}

function* bundleClient(): Operation<string> {
  return yield* scoped(function* () {
    const output = yield* until(Deno.makeTempFile({ suffix: ".js" }));
    yield* ensure(() => rm(output));
    yield* run(Deno.execPath(), [
      "bundle",
      "--platform=browser",
      "--minify",
      "--packages=bundle",
      "--output",
      output,
      CLIENT_ENTRY,
    ]);
    return yield* readTextFile(output);
  });
}

export interface ClientBuildResult {
  clientJs: string;
  themeCss: string;
  module: string;
}

export function* buildWebClient(): Operation<ClientBuildResult> {
  yield* run(Deno.execPath(), ["install", "--frozen"]);
  return yield* scoped(function* () {
    yield* markSideEffectFree(SIDE_EFFECT_FREE_MANIFEST);
    const clientJs = yield* bundleClient();
    const themeCss = yield* readTextFile(new URL(THEME_CSS, repoRoot));
    return { clientJs, themeCss, module: generatedModule(clientJs, themeCss) };
  });
}

if (import.meta.main) {
  await main(function* () {
    const result = yield* buildWebClient();
    const output = new URL(OUTPUT_MODULE, repoRoot);
    yield* ensureDir(new URL(".", output));
    yield* writeTextFile(output, result.module);
    console.log(`generated ${OUTPUT_MODULE} (${byteLength(result.module)} bytes)`);
  });
}
