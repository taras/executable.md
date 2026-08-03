/**
 * Cache one release target's dependency graph.
 *
 * Usage:
 *   deno task deps:target <target>
 *
 * `deno task deps` prepares the host, which is what a developer needs and all
 * they should pay for. A release compiles five other platforms' worth of npm
 * packages, and `--cached-only` means each matrix job has to have its own
 * target's graph in the cache before it compiles — so this exists for those
 * jobs, and for `verify:clean`'s representative target.
 *
 * It adds to the Deno cache and nothing else: `--node-modules-dir=none` keeps
 * the host `node_modules` layout untouched, which `verify:clean` proves by
 * fingerprinting that tree either side of this step.
 */

import { exit, main } from "effection";
import { exec } from "@effectionx/process";
import { fileURLToPath } from "node:url";

import { preparationArguments, RELEASE_TARGETS } from "./lib/release-targets.ts";

const repoRoot = new URL("../", import.meta.url);

main(function* (args) {
  const [target] = args;
  if (!target) {
    console.error(`usage: deno task deps:target <${Object.keys(RELEASE_TARGETS).join("|")}>`);
    yield* exit(1);
    return;
  }

  // Resolved before anything is spawned, so an unknown target costs a message
  // rather than an install of the wrong platform.
  let argv: string[];
  try {
    argv = preparationArguments(target);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}`);
    yield* exit(1);
    return;
  }

  console.log(`▸ caching the ${target} dependency graph`);
  yield* exec(Deno.execPath(), { arguments: argv, cwd: fileURLToPath(repoRoot) }).expect();
});
