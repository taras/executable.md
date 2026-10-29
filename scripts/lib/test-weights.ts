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
 * This module reads, both the committed file and the per-runtime record one
 * measuring job leaves behind. Producing and assembling a measurement is
 * `measure-weights.ts`, and the separation is deliberate: a shard job parses
 * this file on every runner, and it should not have to load a runner table and
 * a process seam to do it.
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

/** The provenance fields that name a run, as opposed to the toolchain that ran in it. */
export type RunIdentity = Pick<WeightSource, "commit" | "runUrl" | "attempt" | "runner">;

const RUN_FIELDS: Array<keyof RunIdentity> = ["commit", "runUrl", "attempt", "runner"];

/** The named variables' values, or a refusal naming every one that is missing. */
function supplied(
  fields: Array<keyof WeightSource>,
  read: (variable: string) => string | undefined,
): Record<string, unknown> {
  const entries = fields.map((field) => ({
    field,
    variable: PROVENANCE_VARIABLES[field],
    value: read(PROVENANCE_VARIABLES[field]) ?? "",
  }));

  const missing = entries.filter((entry) => entry.value.trim().length === 0);
  if (missing.length > 0) {
    throw new TestWeightsError(
      `provenance is missing from the environment: ${missing
        .map((entry) => entry.variable)
        .join(", ")}; expected ${entries.map((entry) => entry.variable).join(", ")}`,
    );
  }

  return {
    ...Object.fromEntries(entries.map((entry) => [entry.field, entry.value])),
    attempt: Number(read(PROVENANCE_VARIABLES.attempt)),
  };
}

/**
 * Provenance read from the environment, refusing rather than defaulting.
 *
 * A default here would be a measurement that describes a run it did not come
 * from, which is worse than no weights at all: the file would look plausible
 * and be wrong.
 */
export function weightSourceFrom(read: (variable: string) => string | undefined): WeightSource {
  return parseWeightSource(supplied([...RUN_FIELDS, "deno", "node", "bun"], read));
}

/**
 * The run an assembly belongs to, read from the environment the same way.
 *
 * Assembly takes no toolchain versions of its own: the versions it publishes
 * are the ones the measuring jobs recorded, and it refuses when they disagree.
 */
export function runIdentityFrom(read: (variable: string) => string | undefined): RunIdentity {
  const source = supplied(RUN_FIELDS, read);
  return {
    commit: text(source.commit, "source.commit", COMMIT),
    runUrl: text(source.runUrl, "source.runUrl", RUN_URL),
    attempt: positiveInteger(source.attempt, "source.attempt"),
    runner: text(source.runner, "source.runner"),
  };
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

/**
 * Where one measuring job stands. `partial` is what a job writes before its
 * first file and after every file that passes, so a job that is cut off —
 * timed out, cancelled, killed — still leaves a record that says it did not
 * finish. `failed` names the file that stopped it, and `complete` means every
 * applicable file passed.
 */
export type MeasurementStatus = "partial" | "failed" | "complete";

const STATUSES: MeasurementStatus[] = ["partial", "failed", "complete"];

/** One file that passed, and how long its process took. */
export interface MeasuredFile {
  file: string;
  ms: number;
}

/** What one runtime's measuring job recorded, under the provenance it ran with. */
export interface RuntimeMeasurement {
  runtime: Runtime;
  status: MeasurementStatus;
  source: WeightSource;
  /** The applicable corpus the job derived for its runtime, sorted. */
  applicable: string[];
  /** Every file that passed, in the order it ran. */
  measured: MeasuredFile[];
  failure: { file: string; status: number } | null;
}

function exactly(value: Record<string, unknown>, fields: string[], label: string): void {
  const extra = Object.keys(value).filter((field) => !fields.includes(field));
  if (extra.length > 0) {
    throw new TestWeightsError(
      `${label} has fields this format does not declare: ${extra.join(", ")}`,
    );
  }
  const missing = fields.filter((field) => !(field in value));
  if (missing.length > 0) {
    throw new TestWeightsError(`${label} is missing ${missing.join(", ")}`);
  }
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TestWeightsError(`${label} is not an array`);
  }
  return value;
}

/** One runtime's measurement record, validated against its one current shape. */
export function parseRuntimeMeasurement(source: string, label = "measurement"): RuntimeMeasurement {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new TestWeightsError(
      `${label} is not JSON: ${error instanceof Error ? error.message : error}`,
    );
  }

  const parsed = record(document, label);
  exactly(parsed, ["runtime", "status", "source", "applicable", "measured", "failure"], label);

  const runtime = parseRuntime(text(parsed.runtime, `${label}.runtime`));
  if (runtime === undefined) {
    throw new TestWeightsError(`${label}.runtime is not a supported runtime`);
  }

  const status = STATUSES.find((candidate) => candidate === parsed.status);
  if (status === undefined) {
    throw new TestWeightsError(`${label}.status is not one of ${STATUSES.join(", ")}`);
  }

  const provenance = record(parsed.source, `${label}.source`);
  exactly(provenance, Object.keys(PROVENANCE_VARIABLES), `${label}.source`);

  const applicable = list(parsed.applicable, `${label}.applicable`).map((path, index) =>
    discoveredPath(text(path, `${label}.applicable[${index}]`), `${label}.applicable[${index}]`),
  );

  const measured = list(parsed.measured, `${label}.measured`).map((entry, index) => {
    const at = `${label}.measured[${index}]`;
    const fields = record(entry, at);
    exactly(fields, ["file", "ms"], at);
    return {
      file: discoveredPath(text(fields.file, `${at}.file`), `${at}.file`),
      ms: positiveInteger(fields.ms, `${at}.ms`),
    };
  });

  let failure: RuntimeMeasurement["failure"] = null;
  if (parsed.failure !== null) {
    const fields = record(parsed.failure, `${label}.failure`);
    exactly(fields, ["file", "status"], `${label}.failure`);
    failure = {
      file: discoveredPath(text(fields.file, `${label}.failure.file`), `${label}.failure.file`),
      status: positiveInteger(fields.status, `${label}.failure.status`),
    };
  }
  if ((status === "failed") !== (failure !== null)) {
    throw new TestWeightsError(`${label}.failure must name a file exactly when status is failed`);
  }

  return {
    runtime,
    status,
    source: parseWeightSource(provenance, `${label}.source`),
    applicable,
    measured,
    failure,
  };
}

/** One runtime's measurement record, in the key order it is written in. */
export function formatRuntimeMeasurement(measurement: RuntimeMeasurement): string {
  return `${JSON.stringify(
    {
      runtime: measurement.runtime,
      status: measurement.status,
      source: {
        commit: measurement.source.commit,
        runUrl: measurement.source.runUrl,
        attempt: measurement.source.attempt,
        runner: measurement.source.runner,
        deno: measurement.source.deno,
        node: measurement.source.node,
        bun: measurement.source.bun,
      },
      applicable: measurement.applicable,
      measured: measurement.measured.map((entry) => ({ file: entry.file, ms: entry.ms })),
      failure:
        measurement.failure === null
          ? null
          : { file: measurement.failure.file, status: measurement.failure.status },
    },
    null,
    2,
  )}\n`;
}

/** Where one runtime's measuring job writes its record, inside `directory`. */
export function measurementFile(directory: URL, runtime: Runtime): URL {
  return new URL(`test-weights-${runtime}.json`, directory);
}

/** Where the committed weights live, relative to the repository root. */
export function weightsFile(root: URL): URL {
  return new URL("test-weights.json", root);
}
