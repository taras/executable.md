/**
 * Run the composability chain against a clean checkout.
 *
 * Usage:
 *   deno task verify:clean
 *
 * The chain is the claim this repository makes about preparation and builds:
 *
 *     deno task setup → deno task build → resolution probe → tsc
 *
 * A build that installed anything breaks the third step, and that is the
 * regression it exists for: `deno task build` reinstalling and pruning pnpm's
 * links out from under `pnpm exec tsc` is the failure this chain reproduces
 * (#279).
 *
 * It runs in a clone of `HEAD` rather than in the worktree it was started from.
 * The chain installs twice and compiles a binary, and a check that mutated the
 * tree it was asserting about would be worthless. CI runs the same chain on its
 * own clean checkout, without the clone.
 *
 * The clone shares the origin repository's object store, so it costs a checkout
 * rather than a copy of history. The installs it performs are the real cost,
 * and they are the point.
 */

import { ensure, exit, main, scoped } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { rm } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const root = fileURLToPath(repoRoot);

export interface Step {
  label: string;
  command: string;
  arguments: string[];
}

/** The chain, in order. `deno` is the binary running this harness, so the pinned one. */
export function chain(deno: string): Step[] {
  return [
    { label: "setup", command: deno, arguments: ["task", "setup"] },
    { label: "build", command: deno, arguments: ["task", "build"] },
    { label: "resolution probe", command: "node", arguments: ["scripts/probe-resolution.mjs"] },
    {
      label: "tsc",
      command: "pnpm",
      arguments: ["exec", "tsc", "--project", "tsconfig.node.json", "--noEmit"],
    },
  ];
}

function* clone(): Operation<string> {
  // @effectionx/fs has no mkdtemp.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "xmd-verify-clean-"));
  yield* ensure(() => rm(target, { recursive: true, force: true }));

  yield* exec("git", {
    arguments: ["clone", "--shared", "--quiet", root, target],
    cwd: root,
  }).expect();
  return target;
}

await main(function* () {
  const failed = yield* scoped(function* () {
    const target = yield* clone();
    console.log(`clean checkout: ${target}\n`);

    for (const step of chain(Deno.execPath())) {
      const started = performance.now();
      const status = yield* exec(step.command, { arguments: step.arguments, cwd: target }).join();
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      if (status.code !== 0) {
        console.error(`\n✗ ${step.label} (${seconds}s)`);
        return true;
      }
      console.log(`✓ ${step.label} (${seconds}s)`);
    }
    return false;
  });

  if (failed) {
    yield* exit(1);
  }
  console.log("\nthe chain holds: preparation installs, and nothing else does");
});
