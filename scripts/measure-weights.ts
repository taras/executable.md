/**
 * Measure what every test file costs, under every runtime that runs it.
 *
 * Usage:
 *   deno task weights:measure                 # writes test-weights.json
 *   deno task weights:measure --label local   # records where it was measured
 *
 * Shards are balanced by weight rather than by file count, so the weights have
 * to come from somewhere honest. Each file is timed **alone**, in its own
 * process, because that is the only measurement that composes: a runner that
 * parallelises across files (Node's does) reports a wall time that says nothing
 * about any single file, and a shard is assembled from single files.
 *
 * Isolated timing charges every file one runner start-up. That constant is
 * uniform enough to leave in — it moves every weight the same way and the
 * balance is what matters — and pretending to subtract it would invent
 * precision the measurement does not have.
 *
 * Verification never runs this. Weights are data recorded on purpose, on the
 * machine CI actually uses (`.github/workflows/measure-weights.yml`), so an
 * ordinary check can neither rewrite them nor be blamed for them going stale.
 */

import { exit, main } from "effection";
import type { Operation } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";

import { captured } from "./lib/captured.ts";
import { listTestFiles } from "./lib/test-files.ts";
import { RUNNERS } from "./lib/runtime-tests.ts";
import { exclusions } from "./runtime-test-exclusions.ts";
import type { Weights } from "./lib/shard.ts";

const repoRoot = new URL("../", import.meta.url);
const root = fileURLToPath(repoRoot);

const OUTPUT = "test-weights.json";

export interface WeightsFile {
  version: 1;
  /** Where these numbers came from; balance is only as good as its provenance. */
  measuredOn: string;
  runtimes: Record<string, Weights>;
}

function environment(): Record<string, string> {
  const path = Deno.env.get("PATH") ?? "";
  return { ...Deno.env.toObject(), PATH: `${root}node_modules/.bin:${path}` };
}

function commandFor(runtime: string, file: string): string[] {
  if (runtime === "deno") {
    return [Deno.execPath(), "test", "--allow-all", "--frozen", file];
  }
  const runner = RUNNERS[runtime]!;
  return [runner.command, ...runner.prefix, file];
}

function* time(runtime: string, file: string): Operation<number> {
  const [program, ...args] = commandFor(runtime, file);
  const started = performance.now();
  yield* captured(program!, { arguments: args, cwd: root, env: environment() });
  return Math.round(performance.now() - started);
}

export function* measureWeights(args: string[]): Operation<void> {
  const label = args[args.indexOf("--label") + 1];
  if (args.includes("--label") && label === undefined) {
    console.error("--label needs a value");
    yield* exit(1);
    return;
  }

  const corpus = yield* listTestFiles(repoRoot);
  const runtimes: Record<string, Weights> = {};

  for (const runtime of ["deno", ...Object.keys(RUNNERS)]) {
    const skip = new Set((exclusions[runtime] ?? []).map((entry) => entry.path));
    const measured: Record<string, number> = {};
    for (const file of corpus.filter((candidate) => !skip.has(candidate))) {
      measured[file] = yield* time(runtime, file);
    }
    runtimes[runtime] = measured;
    console.error(`measured ${Object.keys(measured).length} files under ${runtime}`);
  }

  const contents: WeightsFile = {
    version: 1,
    measuredOn: label ?? "unlabelled",
    runtimes,
  };
  yield* writeTextFile(new URL(OUTPUT, repoRoot), `${JSON.stringify(contents, null, 2)}\n`);
  console.error(`wrote ${OUTPUT}`);
}

if (import.meta.main) {
  await main((args) => measureWeights(args));
}
