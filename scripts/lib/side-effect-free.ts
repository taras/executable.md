/**
 * The `sideEffects: false` fact `@rjsf/validator-ajv8` ships without.
 *
 * The browser bundle must carry no `new Function`: the form page is served
 * under a fixed policy that admits no `unsafe-eval`. RJSF's runtime Ajv
 * validator is the only thing that would introduce one, and the client never
 * calls it — schemas are precompiled server-side. It survives bundling only
 * through a dead path inside `@rjsf/shadcn`'s own module graph, which the
 * bundler drops once it knows the package has no import-time side effects. The
 * package ships without that declaration, so the installed copy carries it.
 *
 * Recording it belongs to setup, not to a build. A build that patched the
 * manifest and restored it afterwards would be rewriting a file `tsc`, Bun, and
 * the Node suite resolve through, and no amount of careful restoration makes
 * that safe while another check is reading — which is why the verification
 * battery could not be run concurrently (#279). Setup writes the fact once,
 * atomically, and every build only reads it.
 */
import type { Operation } from "effection";
import { exists, readTextFile } from "@effectionx/fs";

import { replaceThroughStaging } from "./staged-write.ts";

export const SIDE_EFFECT_FREE_NAME = "@rjsf/validator-ajv8";
export const SIDE_EFFECT_FREE_VERSION = "6.7.1";

const SETUP = "deno task setup";

/**
 * Every installed copy of the manifest the bundler could resolve.
 *
 * There are two, because the tree is a union of two stores: Deno's, linked at
 * the repository root, and pnpm's, linked into `packages/web` because that
 * member declares the dependency. Which one the bundler reads depends on how
 * it resolves — measured, and not a detail:
 *
 * - `--node-modules-dir=auto` resolves through Deno's own store: 606 KB,
 *   tree-shaken.
 * - `--node-modules-dir=manual` resolves the way Node does, walking up from
 *   the client entry, and finds `packages/web/node_modules` first: 734 KB,
 *   carrying the runtime validator and its `new Function`.
 *
 * So the fact belongs on every copy, and a build asserts every copy. The order
 * matters too: `pnpm install` restores its own copy from the store, so setup
 * records the fact again afterwards.
 */
export function sideEffectFreeManifests(repoRoot: URL): URL[] {
  return [
    new URL("packages/web/node_modules/@rjsf/validator-ajv8/package.json", repoRoot),
    new URL("node_modules/@rjsf/validator-ajv8/package.json", repoRoot),
  ];
}

interface Manifest {
  name?: string;
  version?: string;
  sideEffects?: unknown;
}

function* readManifest(path: URL): Operation<Manifest> {
  const manifest = JSON.parse(yield* readTextFile(path));
  if (manifest.name !== SIDE_EFFECT_FREE_NAME || manifest.version !== SIDE_EFFECT_FREE_VERSION) {
    throw new Error(
      `${path.pathname} resolved to ${manifest.name}@${manifest.version}, expected ` +
        `${SIDE_EFFECT_FREE_NAME}@${SIDE_EFFECT_FREE_VERSION}`,
    );
  }
  return manifest;
}

/**
 * Record the fact in the installed manifest, and report whether it had to be
 * written. Running it again on a manifest that already carries it writes
 * nothing.
 */
export function* normalizeSideEffects(path: URL): Operation<boolean> {
  const manifest = yield* readManifest(path);
  if (manifest.sideEffects === false) {
    return false;
  }
  if ("sideEffects" in manifest) {
    throw new Error(
      `${path.pathname} already declares "sideEffects": ${JSON.stringify(manifest.sideEffects)} — ` +
        `refusing to overwrite existing package metadata`,
    );
  }
  yield* replaceThroughStaging(
    path,
    `${JSON.stringify({ ...manifest, sideEffects: false }, null, 2)}\n`,
  );
  return true;
}

/**
 * Fail a build whose dependencies were never normalized, rather than
 * normalizing them.
 *
 * Every copy that exists must carry the fact, because which one the bundler
 * reaches depends on its resolution mode. At least one must exist: none at all
 * means nothing is installed.
 */
export function* assertSideEffectFree(paths: URL[]): Operation<void> {
  let installed = 0;
  for (const path of paths) {
    if (!(yield* exists(path))) {
      continue;
    }
    installed++;
    const manifest = yield* readManifest(path);
    if (manifest.sideEffects !== false) {
      throw new Error(
        `${path.pathname} does not declare "sideEffects": false — the bundle would carry ` +
          `${SIDE_EFFECT_FREE_NAME}'s runtime validator and its \`new Function\`. Run \`${SETUP}\`.`,
      );
    }
  }
  if (installed === 0) {
    throw new Error(
      `${SIDE_EFFECT_FREE_NAME} is not installed — the browser bundle's dependencies are ` +
        `missing. Run \`${SETUP}\`.`,
    );
  }
}

/** Record the fact on every copy that exists, and report how many were written. */
export function* normalizeEvery(paths: URL[]): Operation<number> {
  let written = 0;
  for (const path of paths) {
    if (yield* exists(path)) {
      written += (yield* normalizeSideEffects(path)) ? 1 : 0;
    }
  }
  return written;
}
