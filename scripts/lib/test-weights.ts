/**
 * How long each test file takes under each runtime, as versioned repository
 * data.
 *
 * A weight is only worth what its provenance says: a millisecond measured on
 * another machine, another runner image, or another commit describes a corpus
 * that no longer exists. So the file carries the commit, the run, the attempt,
 * the runner label, and all three runtime versions, and the parser refuses a
 * file missing any of them rather than partitioning against data nobody can
 * place.
 *
 * This module reads. Producing a measurement is `measure-weights.ts`, and the
 * separation is deliberate: a shard job parses this file on every runner, and
 * it should not have to load a runner table and a process seam to do it.
 */
import { parseRuntime, RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

/** Where the measurement came from, so a stale weight is visible rather than plausible. */
export interface WeightSource {
  commit: string;
  runUrl: string;
  attempt: number;
  runner: string;
  deno: string;
  node: string;
  bun: string;
}

export interface TestWeights {
  version: 1;
  source: WeightSource;
  runtimes: Record<Runtime, Record<string, number>>;
}

export class TestWeightsError extends Error {}

/** The one version this repository writes and reads. */
export const WEIGHTS_VERSION = 1;

const COMMIT = /^[0-9a-f]{40}$/;
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;

/**
 * The shape discovery produces: a repository-relative POSIX path under some
 * member's `tests/`. Anything else in a weights file is a path this repository
 * never measured, and treating it as one would silently widen what a partition
 * can name.
 */
const DISCOVERED_PATH = /^[\w.-]+(?:\/[\w.-]+)*\/tests\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TestWeightsError(`${label} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TestWeightsError(`${label} is not a non-empty string`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw new TestWeightsError(`${label} does not match ${pattern.source}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TestWeightsError(`${label} is not a positive integer`);
  }
  return value;
}

function discoveredPath(value: string, label: string): string {
  if (
    !DISCOVERED_PATH.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TestWeightsError(`${label} is not a repository-relative test path`);
  }
  return value;
}

/** `values` as provenance, whatever supplied it — a committed file or a workflow's environment. */
export function parseWeightSource(values: unknown, label = "source"): WeightSource {
  const source = record(values, label);
  return {
    commit: text(source.commit, `${label}.commit`, COMMIT),
    runUrl: text(source.runUrl, `${label}.runUrl`, RUN_URL),
    attempt: positiveInteger(source.attempt, `${label}.attempt`),
    runner: text(source.runner, `${label}.runner`),
    deno: text(source.deno, `${label}.deno`),
    node: text(source.node, `${label}.node`),
    bun: text(source.bun, `${label}.bun`),
  };
}

/**
 * The environment a hosted measurement supplies its provenance through.
 *
 * Naming the variables here rather than in the entrypoint is what lets the
 * workflow regression prove the dispatch hook sets every one of them.
 */
export const PROVENANCE_VARIABLES: Record<keyof WeightSource, string> = {
  commit: "WEIGHTS_COMMIT",
  runUrl: "WEIGHTS_RUN_URL",
  attempt: "WEIGHTS_ATTEMPT",
  runner: "WEIGHTS_RUNNER",
  deno: "WEIGHTS_DENO",
  node: "WEIGHTS_NODE",
  bun: "WEIGHTS_BUN",
};

/**
 * Provenance read from the environment, refusing rather than defaulting.
 *
 * A default here would be a measurement that describes a run it did not come
 * from, which is worse than no weights at all: the file would look placeable
 * and be wrong.
 */
export function weightSourceFrom(read: (variable: string) => string | undefined): WeightSource {
  const supplied = Object.entries(PROVENANCE_VARIABLES).map(([field, variable]) => ({
    field,
    variable,
    value: read(variable) ?? "",
  }));

  const missing = supplied.filter((entry) => entry.value.trim().length === 0);
  if (missing.length > 0) {
    throw new TestWeightsError(
      `provenance is missing from the environment: ${missing
        .map((entry) => entry.variable)
        .join(", ")}; expected ${Object.values(PROVENANCE_VARIABLES).join(", ")}`,
    );
  }

  return parseWeightSource({
    ...Object.fromEntries(supplied.map((entry) => [entry.field, entry.value])),
    attempt: Number(read(PROVENANCE_VARIABLES.attempt)),
  });
}

function parseRuntimeWeights(values: unknown, label: string): Record<string, number> {
  const entries = record(values, label);
  return Object.fromEntries(
    Object.entries(entries).map(([path, weight]) => [
      discoveredPath(path, `${label}["${path}"]`),
      positiveInteger(weight, `${label}["${path}"]`),
    ]),
  );
}

/** The committed weights file, validated rather than asserted. */
export function parseTestWeights(source: string): TestWeights {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new TestWeightsError(
      `weights are not JSON: ${error instanceof Error ? error.message : error}`,
    );
  }

  const parsed = record(document, "weights");
  if (parsed.version !== WEIGHTS_VERSION) {
    throw new TestWeightsError(`weights.version must be ${WEIGHTS_VERSION}`);
  }

  const runtimes = record(parsed.runtimes, "weights.runtimes");
  for (const name of Object.keys(runtimes)) {
    if (parseRuntime(name) === undefined) {
      throw new TestWeightsError(`weights.runtimes.${name} is not a supported runtime`);
    }
  }

  const measured: Record<Runtime, Record<string, number>> = { deno: {}, node: {}, bun: {} };
  for (const runtime of RUNTIMES) {
    if (!(runtime in runtimes)) {
      throw new TestWeightsError(`weights.runtimes.${runtime} is missing`);
    }
    measured[runtime] = parseRuntimeWeights(runtimes[runtime], `weights.runtimes.${runtime}`);
  }

  return {
    version: WEIGHTS_VERSION,
    source: parseWeightSource(parsed.source, "weights.source"),
    runtimes: measured,
  };
}

/** The committed weights, in the stable key order the file is written in. */
export function formatTestWeights(weights: TestWeights): string {
  const runtimes: Record<Runtime, Record<string, number>> = { deno: {}, node: {}, bun: {} };
  for (const runtime of RUNTIMES) {
    const measured = weights.runtimes[runtime];
    runtimes[runtime] = Object.fromEntries(
      Object.keys(measured)
        .sort()
        .map((path) => [path, measured[path]]),
    );
  }

  return `${JSON.stringify(
    {
      version: weights.version,
      source: {
        commit: weights.source.commit,
        runUrl: weights.source.runUrl,
        attempt: weights.source.attempt,
        runner: weights.source.runner,
        deno: weights.source.deno,
        node: weights.source.node,
        bun: weights.source.bun,
      },
      runtimes,
    },
    null,
    2,
  )}\n`;
}

/** Where the committed weights live, relative to the repository root. */
export function weightsFile(root: URL): URL {
  return new URL("test-weights.json", root);
}
