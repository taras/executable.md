/**
 * Prepare a worktree for the verification battery.
 *
 * Usage:
 *   deno task setup
 *
 * The battery runs its checks concurrently in one worktree (AGENTS.md), so no
 * check may install, relink, patch, or clean anything they share. Setup is
 * where all of that happens, and it happens on its own.
 *
 * The order is load-bearing. `deno install` writes its own store and the links
 * that reach it; `pnpm install` adds a second store beside it without pruning
 * the first, so the tree that results resolves for Deno, for `tsc` and the Node
 * suite, for Bun, for oxlint, and for the site. Running them the other way
 * around leaves Deno's layout on top and the Node suite unable to resolve
 * `@effectionx/*`. Bun needs no install of its own: it resolves through the
 * same tree.
 *
 * The `sideEffects` fact is recorded after both installers have run, because
 * pnpm restores its own copy of that manifest from its store — and that copy is
 * the one the bundler resolves. The bundle is built last, because it reads what
 * both installers left and writes a generated module that `deno check`,
 * `deno test`, `deno publish --dry-run`, and `tsc` all read afterwards.
 */

import { main } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";

import { buildWebClient, OUTPUT_MODULE } from "./build-web-client.ts";
import { installDependencies, recordSideEffectFree } from "./deps.ts";
import { byteLength } from "./lib/web-client-module.ts";

const repoRoot = new URL("../", import.meta.url);

await main(function* () {
  console.log("▸ install dependencies");
  yield* installDependencies();

  console.log("\n▸ pnpm install");
  yield* exec("pnpm", { arguments: ["install"], cwd: fileURLToPath(repoRoot) }).expect();

  // pnpm restores its own copy of the manifest from its store, which drops the
  // fact recorded above — and that copy is the one the bundler resolves.
  yield* recordSideEffectFree();

  console.log("\n▸ build the browser bundle");
  const result = yield* buildWebClient();
  const output = new URL(OUTPUT_MODULE, repoRoot);
  yield* ensureDir(new URL(".", output));
  yield* writeTextFile(output, result.module);
  console.log(`generated ${OUTPUT_MODULE} (${byteLength(result.module)} bytes)`);

  console.log("\nready");
});
