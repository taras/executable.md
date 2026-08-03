/**
 * Install both dependency layouts, and record that it happened.
 *
 * Usage:
 *   deno task deps
 *
 * There are two layouts, not one. `node_modules/` is the obvious one; Deno's
 * global cache is the other, and a build that fetches into it has installed
 * something just as surely. This step owns both:
 *
 * 1. `deno install --frozen` — `node_modules/` and the npm half of the cache.
 * 2. `deno install --entrypoint --frozen` over the entry points a build and a
 *    compile walk, so their module graphs are cached and every later phase can
 *    run `--cached-only`.
 * 3. The `sideEffects` fact the bundle needs (`lib/side-effect-free.ts`).
 * 4. The record `lib/prepared.ts` describes — a copy of each input — so a build
 *    can tell a prepared tree from an unprepared one without resolving a single
 *    dependency.
 *
 * It is deliberately not part of any check, and no build runs it. The
 * verification battery runs its checks concurrently against one tree, and
 * `deno install` prunes the links pnpm placed there — which is what took
 * `@effectionx/*` and `tsx` out from under the Node suite while it was
 * running (#279).
 */

import { main } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { copyFile, ensureDir, rm } from "@effectionx/fs";
import { fileURLToPath } from "node:url";

import { PREPARED_INPUTS, PREPARED_MARKER, recordedCopy } from "./lib/prepared.ts";
import { normalizeEvery, sideEffectFreeManifests } from "./lib/side-effect-free.ts";

const repoRoot = new URL("../", import.meta.url);

/**
 * The graphs a build, a compile, and the clean-checkout harness walk. Caching
 * them here is what lets every one of them run `--cached-only` — none of them
 * is an installer.
 */
const ENTRYPOINTS = [
  "scripts/build-web-client.ts",
  "packages/web/client/main.tsx",
  "packages/cli/src/compiled.ts",
  "scripts/verify-clean.ts",
];

function* deno(args: string[]): Operation<void> {
  yield* exec(Deno.execPath(), {
    arguments: args,
    cwd: fileURLToPath(repoRoot),
  }).expect();
}

/**
 * Record the fact on every installed copy. Separate from the install because
 * `pnpm install` restores its own copy from the store, so setup runs this again
 * after it (`scripts/setup.ts`).
 */
export function* recordSideEffectFree(): Operation<void> {
  const written = yield* normalizeEvery(sideEffectFreeManifests(repoRoot));
  console.log(
    written > 0
      ? `recorded @rjsf/validator-ajv8 as side-effect-free (${written} copy/copies)`
      : "@rjsf/validator-ajv8 is already recorded as side-effect-free",
  );
}

/**
 * `--frozen` throughout: `deno.lock` is tracked, and preparation that quietly
 * rewrote it would leave a clean worktree dirty. A stale lock fails here with
 * Deno's own message, and `deno install` without the flag is how it is updated.
 */
export function* installDependencies(): Operation<void> {
  yield* deno(["install", "--frozen"]);
  yield* deno(["install", "--entrypoint", "--frozen", ...ENTRYPOINTS]);

  yield* recordSideEffectFree();

  // `rm` first: an earlier preparation left a file where this directory goes.
  yield* rm(new URL(PREPARED_MARKER, repoRoot), { recursive: true, force: true });
  yield* ensureDir(new URL(PREPARED_MARKER, repoRoot));
  for (const input of PREPARED_INPUTS) {
    yield* copyFile(new URL(input, repoRoot), new URL(recordedCopy(input), repoRoot));
  }
  console.log(`recorded ${PREPARED_MARKER}`);
}

if (import.meta.main) {
  main(installDependencies);
}
