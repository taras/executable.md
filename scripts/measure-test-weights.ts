/**
 * Measure how long every applicable test file takes under one runtime, or
 * assemble three such measurements into `test-weights.json`.
 *
 * Usage:
 *   deno task weights:measure <deno|node|bun> <directory>
 *   deno task weights:measure assemble <directory>
 *
 * The first form writes `<directory>/test-weights-<runtime>.json` and keeps it
 * current file by file, so a job that is cut off still leaves the files it
 * finished. The second reads all three records from `<directory>` and writes
 * `test-weights.json` only when every runtime completed in the same run under
 * the same toolchain and covered exactly the corpus this checkout applies.
 * This is the only command that writes those weights. It is meant to run on the
 * hosted runner the CI suites run on, through
 * `.github/workflows/measure-test-weights.yml`, because a weight measured
 * anywhere else describes a machine no CI job will ever use.
 *
 * Provenance is supplied, never inferred. A local run could read its own commit
 * from Git and its own versions from the executables on `PATH`, and would then
 * produce a file reporting provenance for the runner while describing a laptop. So
 * every provenance value arrives in the environment, and a missing one is a
 * refusal.
 */

import { exit, main } from "effection";
import type { Operation } from "effection";
import { ensureDir } from "@effectionx/fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assembleMeasurements, measureRuntime, writeTestWeights } from "./lib/measure-weights.ts";
import {
  measurementFile,
  runIdentityFrom,
  TestWeightsError,
  weightsFile,
  weightSourceFrom,
} from "./lib/test-weights.ts";
import type { RunIdentity, WeightSource } from "./lib/test-weights.ts";
import { parseRuntime, RUNTIMES } from "./runtime-test-exclusions.ts";

const repoRoot = new URL("../", import.meta.url);

const USAGE = [
  `usage: measure-test-weights.ts <${RUNTIMES.join("|")}> <directory>`,
  "       measure-test-weights.ts assemble <directory>",
].join("\n");

function* refuse(message: unknown): Operation<void> {
  console.error(`${message instanceof Error ? message.message : message}`);
  yield* exit(1);
}

function directoryUrl(path: string): URL {
  return pathToFileURL(`${resolve(path)}/`);
}

function* assemble(directory: string | undefined): Operation<void> {
  let identity: RunIdentity;
  try {
    identity = runIdentityFrom((variable) => Deno.env.get(variable));
  } catch (error) {
    yield* refuse(error);
    return;
  }
  if (directory === undefined) {
    yield* refuse(USAGE);
    return;
  }

  const target = weightsFile(repoRoot);
  try {
    yield* writeTestWeights(
      target,
      yield* assembleMeasurements(repoRoot, directoryUrl(directory), identity),
    );
  } catch (error) {
    if (error instanceof TestWeightsError) {
      yield* refuse(error);
      return;
    }
    throw error;
  }

  console.log(`wrote ${target.pathname} from ${identity.runUrl} attempt ${identity.attempt}`);
}

main(function* () {
  const [command, directory, ...extra] = Deno.args;
  if (command === "assemble" && extra.length === 0) {
    yield* assemble(directory);
    return;
  }

  // Resolved before anything is spawned, so an incomplete environment costs a
  // message rather than an hour of measurement nothing can be written from.
  let source: WeightSource;
  try {
    source = weightSourceFrom((variable) => Deno.env.get(variable));
  } catch (error) {
    yield* refuse(error);
    return;
  }

  const runtime = parseRuntime(command ?? "");
  if (runtime === undefined || directory === undefined || extra.length > 0) {
    yield* refuse(USAGE);
    return;
  }

  const output = directoryUrl(directory);
  yield* ensureDir(output);
  const target = measurementFile(output, runtime);
  yield* measureRuntime(runtime, repoRoot, source, target);

  console.log(`wrote ${target.pathname} from ${source.runUrl} attempt ${source.attempt}`);
});
