/**
 * Measure how long every applicable test file takes under every runtime, and
 * write the result to `test-weights.json`.
 *
 * Usage:
 *   deno task weights:measure
 *
 * This is the only command that writes those weights. It is meant to run on the
 * hosted runner the CI suites run on, through
 * `.github/workflows/measure-test-weights.yml`, because a weight measured
 * anywhere else describes a machine no CI job will ever use.
 *
 * Provenance is supplied, never inferred. A local run could read its own commit
 * from Git and its own versions from the executables on `PATH`, and would then
 * produce a file claiming to describe the runner while describing a laptop. So
 * every provenance value arrives in the environment, and a missing one is a
 * refusal.
 */

import { exit, main } from "effection";

import { measureTestWeights, writeTestWeights } from "./lib/measure-weights.ts";
import { weightsFile, weightSourceFrom } from "./lib/test-weights.ts";
import type { WeightSource } from "./lib/test-weights.ts";

const repoRoot = new URL("../", import.meta.url);

main(function* () {
  // Resolved before anything is spawned, so an incomplete environment costs a
  // message rather than an hour of measurement nothing can be written from.
  let source: WeightSource;
  try {
    source = weightSourceFrom((variable) => Deno.env.get(variable));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}`);
    yield* exit(1);
    return;
  }

  const target = weightsFile(repoRoot);
  const weights = yield* measureTestWeights(repoRoot, source);
  yield* writeTestWeights(target, weights);

  console.log(`wrote ${target.pathname} from ${source.runUrl} attempt ${source.attempt}`);
});
