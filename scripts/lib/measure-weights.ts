/**
 * Produce a measurement: run every applicable test file alone, under each
 * runtime's own runner, and record what each one took.
 *
 * Kept apart from `test-weights.ts` on purpose. Reading a weight is what every
 * shard job does, on every runner; measuring one spawns hundreds of processes
 * and belongs to a single dispatched workflow.
 */
import type { Operation } from "effection";

import { replaceThroughStaging } from "./staged-write.ts";
import { applicableTestFiles } from "./test-files.ts";
import { runOneFile } from "./runtime-tests.ts";
import { formatTestWeights, WEIGHTS_VERSION } from "./test-weights.ts";
import type { TestWeights, WeightSource } from "./test-weights.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

/**
 * Time every applicable file under every runtime, one file per process.
 *
 * The result is held in memory and returned; nothing is written here. A failure
 * anywhere aborts the whole measurement, because a corpus that cannot pass is a
 * corpus whose timings describe an error path rather than a test run.
 */
export function* measureTestWeights(root: URL, source: WeightSource): Operation<TestWeights> {
  const runtimes: Record<Runtime, Record<string, number>> = { deno: {}, node: {}, bun: {} };

  for (const runtime of RUNTIMES) {
    const files = yield* applicableTestFiles(runtime, root);
    console.error(`measuring ${files.length} test files under ${runtime}`);

    for (const file of files) {
      const started = performance.now();
      const code = yield* runOneFile(runtime, file, root);
      // The schema admits positive integers only, and a file that finishes in
      // under half a millisecond would otherwise round to a weight of zero.
      const elapsed = Math.max(1, Math.round(performance.now() - started));

      if (code !== 0) {
        throw new Error(
          `${runtime} exited ${code} on ${file}; measurement stopped and no weights were written`,
        );
      }

      runtimes[runtime][file] = elapsed;
      console.error(`  ${file} ${elapsed}ms`);
    }
  }

  return { version: WEIGHTS_VERSION, source, runtimes };
}

/** Replace the committed weights atomically, staging beside them first. */
export function writeTestWeights(path: URL, weights: TestWeights): Operation<void> {
  return replaceThroughStaging(path, formatTestWeights(weights));
}
