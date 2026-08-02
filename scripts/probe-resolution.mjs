/**
 * Prove that both dependency stores still resolve, from Node.
 *
 * Usage:
 *   node scripts/probe-resolution.mjs
 *
 * `node_modules/` is a union: `deno install` writes its store and the links
 * that reach it, `pnpm install` adds a second store beside it without pruning
 * the first. Every check depends on that union surviving — and the failure it
 * produces when it does not is a module-not-found deep inside an unrelated
 * suite (#279). This resolves one package from each store instead, so a pruned
 * tree fails here, in one line, naming the store that lost.
 *
 * It runs under Node deliberately: Node's resolution is the one the `tsc`
 * typecheck, the Node suite, and every `tsx` child depend on.
 */

import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/probe.mjs`);

/**
 * One specifier per store, resolved as a package entry rather than as
 * `<pkg>/package.json` — several of these packages do not expose that subpath
 * through their `exports`, and a probe that failed on the exports map rather
 * than on the tree would report the wrong thing.
 */
const STORES = {
  pnpm: "tsx",
  deno: "@rjsf/shadcn",
  workspace: "@executablemd/core",
};

let failed = false;
for (const [store, specifier] of Object.entries(STORES)) {
  try {
    console.log(`${store}: ${require.resolve(specifier)}`);
  } catch (error) {
    console.error(`${store}: ${specifier} does not resolve — ${error.message}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
