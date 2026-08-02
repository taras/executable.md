/**
 * Build the @executablemd/web browser client.
 *
 * Usage:
 *   deno task build:web [--out <path>]
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
 * A build reads the installed dependencies and writes nothing but its own
 * scratch file and the module it was asked for. Installing them, and recording
 * the one dependency fact the bundle needs, belongs to `deno task deps` — every
 * check in the verification battery reads the same `node_modules` concurrently,
 * so a build that installed or patched anything there would break whichever
 * check happened to be reading (#279).
 *
 * That is enforced by the modes the phases run under, not by anything in this
 * file: automatic node-module management creates `node_modules/.deno` before
 * application code runs, so an assertion here would be too late. The task runs
 * this script with `--node-modules-dir=none --cached-only --frozen`, and the
 * bundler below with `--node-modules-dir=manual --no-remote --frozen` —
 * `manual` being the mode documented as "use the existing local node_modules
 * directory, do not modify it", which is what lets the bundler read the
 * recorded `sideEffects` fact without a build ever writing there. Deno 2.9.1's
 * `deno bundle` has no `--cached-only`; `--no-remote` and `manual` together are
 * what keep it off the network, which the offline probe in the suite measures
 * rather than assumes.
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
 * import. Tree-shaking it out needs one fact the package ships without, which
 * `scripts/lib/side-effect-free.ts` records at setup; a build asserts it and
 * refuses to run without it.
 */

import { ensure, main, scoped, until } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { encodeBase64 } from "@std/encoding/base64";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertSideEffectFree, sideEffectFreeManifests } from "./lib/side-effect-free.ts";
import { byteLength, generatedModule } from "./lib/web-client-module.ts";

const repoRoot = new URL("../", import.meta.url);

const CLIENT_ENTRY = "packages/web/client/main.tsx";
const THEME_CSS = "node_modules/@rjsf/shadcn/dist/default.css";
const OVERRIDE_CSS = "packages/web/client/theme/mx-brutalist.css";

/** Where a build writes when it is not told otherwise. Gitignored, never tracked. */
export const OUTPUT_MODULE = "packages/web/generated/client-bundle.ts";

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

/** The manifests carrying the fact a build reads — one per installed copy. */
export const SIDE_EFFECT_FREE_MANIFESTS: URL[] = sideEffectFreeManifests(repoRoot);

function* run(command: string, args: string[]): Operation<void> {
  yield* exec(command, { arguments: args, cwd: new URL(repoRoot).pathname }).expect();
}

function* bundleClient(scratch?: string): Operation<string> {
  return yield* scoped(function* () {
    const output = yield* until(Deno.makeTempFile({ dir: scratch, suffix: ".js" }));
    yield* ensure(() => rm(output));
    yield* run(Deno.execPath(), [
      "bundle",
      "--platform=browser",
      "--minify",
      "--packages=bundle",
      "--node-modules-dir=manual",
      "--no-remote",
      "--frozen",
      "--output",
      output,
      CLIENT_ENTRY,
    ]);
    return yield* readTextFile(output);
  });
}

/**
 * Guard the bytes about to be inlined the way the manifest check guards the
 * bundle: a resolved package that is not the pinned one would be embedded
 * silently, and the stylesheet has no version to check afterwards.
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

export interface BuildOptions {
  /**
   * The directory the bundler's scratch file is created in; the system temp
   * directory by default. A test owns a directory of its own so it can show
   * that an interrupted build leaves nothing behind in it.
   */
  scratch?: string;
}

export function* buildWebClient(options: BuildOptions = {}): Operation<ClientBuildResult> {
  yield* assertSideEffectFree(SIDE_EFFECT_FREE_MANIFESTS);
  const clientJs = yield* bundleClient(options.scratch);
  const themeCss = [
    yield* readTextFile(new URL(THEME_CSS, repoRoot)),
    yield* fontFaces(),
    yield* readTextFile(new URL(OVERRIDE_CSS, repoRoot)),
  ].join("\n");
  return { clientJs, themeCss, module: generatedModule(clientJs, themeCss) };
}

/**
 * Where this invocation writes: `--out <path>`, relative to the working
 * directory, or the generated module the repository serves from.
 *
 * Every check in the battery reads the default path, so a test that needs the
 * script to write asks for a path of its own instead of taking a turn at that
 * one.
 */
export function outputModule(args: string[], root: URL): URL {
  const flag = args.indexOf("--out");
  if (flag === -1) {
    return new URL(OUTPUT_MODULE, root);
  }
  const path = args[flag + 1];
  if (!path) {
    throw new Error("--out requires a path");
  }
  return pathToFileURL(resolve(path));
}

if (import.meta.main) {
  await main(function* (args) {
    const output = outputModule(args, repoRoot);
    const result = yield* buildWebClient();
    yield* ensureDir(new URL(".", output));
    yield* writeTextFile(output, result.module);
    console.log(`generated ${output.pathname} (${byteLength(result.module)} bytes)`);
  });
}
