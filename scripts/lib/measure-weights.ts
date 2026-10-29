/**
 * Produce a measurement: run every applicable test file of one runtime alone,
 * under that runtime's own runner, and record what each one took — then, once
 * every runtime has a complete record from the same run, assemble the three
 * into the committed weights.
 *
 * Kept apart from `test-weights.ts` on purpose. Reading a weight is what every
 * shard job does, on every runner; measuring one spawns hundreds of processes
 * and belongs to a single dispatched workflow.
 */
import type { Operation } from "effection";
import { exists, readTextFile } from "@effectionx/fs";

import { replaceThroughStaging } from "./staged-write.ts";
import { applicableTestFiles } from "./test-files.ts";
import { runOneFile } from "./runtime-tests.ts";
import {
  formatRuntimeMeasurement,
  formatTestWeights,
  measurementFile,
  parseRuntimeMeasurement,
  TestWeightsError,
  WEIGHTS_VERSION,
} from "./test-weights.ts";
import type {
  MeasuredFile,
  RunIdentity,
  RuntimeMeasurement,
  TestWeights,
  WeightSource,
} from "./test-weights.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

function writeMeasurement(target: URL, measurement: RuntimeMeasurement): Operation<void> {
  return replaceThroughStaging(target, formatRuntimeMeasurement(measurement));
}

/**
 * Time every applicable file under `runtime`, one file per process, and keep
 * `target` current as it goes.
 *
 * The record is rewritten before the first file and after every one, so a job
 * that is cut off leaves a `partial` record holding every file that finished.
 * A failing file stops the measurement and is recorded as `failed`, because a
 * corpus that cannot pass is a corpus whose timings describe an error path
 * rather than a test run. Only `complete` is ever assembled into weights.
 */
export function* measureRuntime(
  runtime: Runtime,
  root: URL,
  source: WeightSource,
  target: URL,
): Operation<RuntimeMeasurement> {
  const applicable = yield* applicableTestFiles(runtime, root);
  const measured: MeasuredFile[] = [];
  const recorded = (
    status: RuntimeMeasurement["status"],
    failure: RuntimeMeasurement["failure"] = null,
  ): RuntimeMeasurement => ({
    runtime,
    status,
    source,
    applicable,
    measured: [...measured],
    failure,
  });

  yield* writeMeasurement(target, recorded("partial"));
  console.error(`measuring ${applicable.length} test files under ${runtime}`);

  for (const file of applicable) {
    const started = performance.now();
    const code = yield* runOneFile(runtime, file, root);
    // The schema admits positive integers only, and a file that finishes in
    // under half a millisecond would otherwise round to a weight of zero.
    const ms = Math.max(1, Math.round(performance.now() - started));

    if (code !== 0) {
      yield* writeMeasurement(target, recorded("failed", { file, status: code }));
      throw new Error(
        `${runtime} exited ${code} on ${file}; measurement stopped after ${measured.length} of ${applicable.length} files and recorded it as failed`,
      );
    }

    measured.push({ file, ms });
    yield* writeMeasurement(target, recorded("partial"));
    console.error(`  ${file} ${ms}ms`);
  }

  const complete = recorded("complete");
  yield* writeMeasurement(target, complete);
  return complete;
}

function described(paths: string[]): string {
  return paths.length <= 5
    ? paths.join(", ")
    : `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more`;
}

const RUN_FIELDS: Array<keyof RunIdentity> = ["commit", "runUrl", "attempt", "runner"];

function provenanceProblems(
  runtime: Runtime,
  source: WeightSource,
  identity: RunIdentity,
  reference: RuntimeMeasurement,
): string[] {
  const problems: string[] = [];
  for (const field of RUN_FIELDS) {
    if (source[field] !== identity[field]) {
      problems.push(
        `${runtime} was measured with ${field} ${source[field]}, not ${identity[field]}`,
      );
    }
  }
  for (const field of RUNTIMES) {
    if (source[field] !== reference.source[field]) {
      problems.push(
        `${runtime} was measured with ${field} ${source[field]}, but ${reference.runtime} with ${reference.source[field]}`,
      );
    }
  }
  return problems;
}

function coverageProblems(
  runtime: Runtime,
  measurement: RuntimeMeasurement,
  applicable: string[],
): string[] {
  const problems: string[] = [];
  const expected = new Set(applicable);

  if (measurement.applicable.join("\n") !== applicable.join("\n")) {
    problems.push(
      `${runtime} was measured against a corpus of ${measurement.applicable.length} files, but this checkout applies ${applicable.length}`,
    );
  }

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const { file } of measurement.measured) {
    if (seen.has(file)) {
      duplicated.add(file);
    }
    seen.add(file);
  }
  const missing = applicable.filter((file) => !seen.has(file));
  const unexpected = [...seen].filter((file) => !expected.has(file));

  if (duplicated.size > 0) {
    problems.push(`${runtime} measured more than once: ${described([...duplicated])}`);
  }
  if (missing.length > 0) {
    problems.push(
      `${runtime} has no measurement for ${missing.length} applicable files: ${described(missing)}`,
    );
  }
  if (unexpected.length > 0) {
    problems.push(
      `${runtime} measured files this checkout does not apply: ${described(unexpected)}`,
    );
  }
  return problems;
}

/**
 * The committed weights, from one complete record per runtime.
 *
 * Every runtime must have finished, in the run `identity` names, under the same
 * toolchain versions as the others, and covering exactly the corpus this
 * checkout applies — each file once. Anything else is refused with every
 * problem named, because weights stitched from different runs, or missing a
 * file, would carry a provenance no single measurement supports.
 */
export function assembleTestWeights(
  identity: RunIdentity,
  applicable: Record<Runtime, string[]>,
  measurements: Partial<Record<Runtime, RuntimeMeasurement>>,
): TestWeights {
  const problems: string[] = [];
  const absent = RUNTIMES.filter((runtime) => measurements[runtime] === undefined);
  if (absent.length > 0) {
    problems.push(`no measurement was recorded for ${absent.join(", ")}`);
  }

  const reference = RUNTIMES.map((runtime) => measurements[runtime]).find(
    (measurement) => measurement !== undefined,
  );
  const runtimes: Record<Runtime, Record<string, number>> = { deno: {}, node: {}, bun: {} };

  for (const runtime of RUNTIMES) {
    const measurement = measurements[runtime];
    if (measurement === undefined || reference === undefined) {
      continue;
    }
    if (measurement.runtime !== runtime) {
      problems.push(`the ${runtime} record describes ${measurement.runtime}`);
      continue;
    }
    problems.push(...provenanceProblems(runtime, measurement.source, identity, reference));
    if (measurement.status !== "complete") {
      const stopped =
        measurement.failure === null
          ? ""
          : `; ${measurement.failure.file} exited ${measurement.failure.status}`;
      problems.push(
        `${runtime} is ${measurement.status}: ${measurement.measured.length} of ${measurement.applicable.length} files passed${stopped}`,
      );
      continue;
    }
    problems.push(...coverageProblems(runtime, measurement, applicable[runtime]));

    runtimes[runtime] = Object.fromEntries(
      measurement.measured.map((entry) => [entry.file, entry.ms]),
    );
  }

  if (problems.length > 0 || reference === undefined) {
    throw new TestWeightsError(
      `the measurement cannot be assembled:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
    );
  }

  return {
    version: WEIGHTS_VERSION,
    source: {
      ...identity,
      deno: reference.source.deno,
      node: reference.source.node,
      bun: reference.source.bun,
    },
    runtimes,
  };
}

/**
 * Read each runtime's record from `directory` and assemble them against the
 * corpus the checkout at `root` applies. A record that is absent is reported
 * with the others rather than on its own.
 */
export function* assembleMeasurements(
  root: URL,
  directory: URL,
  identity: RunIdentity,
): Operation<TestWeights> {
  const applicable: Record<Runtime, string[]> = { deno: [], node: [], bun: [] };
  const measurements: Partial<Record<Runtime, RuntimeMeasurement>> = {};

  for (const runtime of RUNTIMES) {
    applicable[runtime] = yield* applicableTestFiles(runtime, root);
    const path = measurementFile(directory, runtime);
    if (yield* exists(path)) {
      measurements[runtime] = parseRuntimeMeasurement(
        yield* readTextFile(path),
        `test-weights-${runtime}.json`,
      );
    }
  }

  return assembleTestWeights(identity, applicable, measurements);
}

/** Replace the committed weights atomically, staging beside them first. */
export function writeTestWeights(path: URL, weights: TestWeights): Operation<void> {
  return replaceThroughStaging(path, formatTestWeights(weights));
}
