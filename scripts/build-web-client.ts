/**
 * Build the @executablemd/web browser client.
 *
 * Usage:
 *   deno task build:web
 *
 * Bundles `packages/web/client/main.tsx` with Deno's browser bundler and writes
 * the result, together with the themed stylesheet, into the generated module
 * `packages/web/generated/client-bundle.ts` — gitignored, not a repository
 * source file. A release builds it into the package immediately before
 * packaging (specs/release-process-spec.md); this task exists so the server can
 * serve those bytes and so the test suite can bundle and inspect real output
 * without a tracked artifact to keep in sync.
 *
 * The stylesheet is three parts joined in a fixed order: the shadcn theme's
 * compiled `default.css` verbatim, then the `@font-face` rules this script
 * generates, then `packages/web/client/theme/mx-brutalist.css`. The override
 * wins because the vendored palette blocks are unlayered and near the end of
 * `default.css`, so an unlayered `:root` after them wins on source order.
 *
 * Fonts are embedded rather than linked: their faces are read from pinned
 * `@fontsource` packages and inlined as `data:` URIs, so the page still makes
 * no request off the machine. That is what `font-src data:` in the page's
 * fixed policy admits, and the only thing it admits.
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
import { encodeBase64 } from "@std/encoding/base64";

import { patchUntilExit } from "./lib/manifest-patch.ts";
import { byteLength, generatedModule } from "./lib/web-client-module.ts";

const repoRoot = new URL("../", import.meta.url);

const CLIENT_ENTRY = "packages/web/client/main.tsx";
const THEME_CSS = "node_modules/@rjsf/shadcn/dist/default.css";
const OVERRIDE_CSS = "packages/web/client/theme/mx-brutalist.css";
const OUTPUT_MODULE = "packages/web/generated/client-bundle.ts";
const SIDE_EFFECT_FREE_NAME = "@rjsf/validator-ajv8";
const SIDE_EFFECT_FREE_VERSION = "6.7.1";

const FONT_SCOPE = "@fontsource/";

/** The font packages a build reads bytes out of, pinned the way the theme is. */
const FONT_PACKAGES: Record<string, string> = {
  "@fontsource/montserrat": "5.3.0",
  "@fontsource/space-mono": "5.3.0",
};

interface FontFace {
  package: string;
  family: string;
  weight: number;
}

/**
 * The faces the compiled stylesheet can actually reach: 400 from preflight, 500
 * and 600 from `--font-weight-medium` and `--font-weight-semibold`, 700 from
 * `b,strong{font-weight:bolder}`. Space Mono publishes only 400 and 700. Lora
 * is named by `--font-serif` and read by no rule, so it ships no bytes.
 */
const FONT_FACES: FontFace[] = [
  { package: "@fontsource/montserrat", family: "Montserrat", weight: 400 },
  { package: "@fontsource/montserrat", family: "Montserrat", weight: 500 },
  { package: "@fontsource/montserrat", family: "Montserrat", weight: 600 },
  { package: "@fontsource/montserrat", family: "Montserrat", weight: 700 },
  { package: "@fontsource/space-mono", family: "Space Mono", weight: 400 },
  { package: "@fontsource/space-mono", family: "Space Mono", weight: 700 },
];

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

/**
 * Guard the bytes about to be inlined the way `markSideEffectFree` guards the
 * manifest it patches: a resolved package that is not the pinned one would be
 * embedded silently, and the stylesheet has no version to check afterwards.
 */
function* verifyFontPackage(name: string, version: string): Operation<void> {
  const manifest = JSON.parse(
    yield* readTextFile(new URL(`node_modules/${name}/package.json`, repoRoot)),
  );
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(
      `node_modules/${name} resolved to ${manifest.name}@${manifest.version}, expected ` +
        `${name}@${version}`,
    );
  }
}

/** `@effectionx/fs` reads text only, and a woff2 file is not text. */
function* fontFace(face: FontFace): Operation<string> {
  const slug = face.package.slice(FONT_SCOPE.length);
  const bytes = yield* until(
    Deno.readFile(
      new URL(
        `node_modules/${face.package}/files/${slug}-latin-${face.weight}-normal.woff2`,
        repoRoot,
      ),
    ),
  );
  return [
    "@font-face {",
    `  font-family: "${face.family}";`,
    "  font-style: normal;",
    "  font-display: swap;",
    `  font-weight: ${face.weight};`,
    `  src: url(data:font/woff2;base64,${encodeBase64(bytes)}) format("woff2");`,
    "}",
  ].join("\n");
}

function* fontFaces(): Operation<string> {
  for (const [name, version] of Object.entries(FONT_PACKAGES)) {
    yield* verifyFontPackage(name, version);
  }
  const blocks: string[] = [];
  for (const face of FONT_FACES) {
    blocks.push(yield* fontFace(face));
  }
  return blocks.join("\n\n");
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
    const themeCss = [
      yield* readTextFile(new URL(THEME_CSS, repoRoot)),
      yield* fontFaces(),
      yield* readTextFile(new URL(OVERRIDE_CSS, repoRoot)),
    ].join("\n");
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
