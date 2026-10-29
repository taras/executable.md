/**
 * Weights are durable repository data that decides what every CI shard runs,
 * and they arrive from a hosted run nobody watches. So the parser validates the
 * file rather than trusting it, and measurement is held to running each file
 * once, alone, through the command a shard will use — and to writing nothing at
 * all when any of it fails.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { pathToFileURL } from "node:url";

import {
  formatRuntimeMeasurement,
  formatTestWeights,
  measurementFile,
  parseRuntimeMeasurement,
  parseTestWeights,
  parseWeightSource,
  PROVENANCE_VARIABLES,
  runIdentityFrom,
  TestWeightsError,
  weightsFile,
  weightSourceFrom,
} from "../lib/test-weights.ts";
import type {
  RunIdentity,
  RuntimeMeasurement,
  TestWeights,
  WeightSource,
} from "../lib/test-weights.ts";
import {
  assembleMeasurements,
  assembleTestWeights,
  measureRuntime,
  writeTestWeights,
} from "../lib/measure-weights.ts";
import { oneFileCommand, TestRuns } from "../lib/runtime-tests.ts";
import type { RunLaunch } from "../lib/runtime-tests.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

const SOURCE: WeightSource = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  runUrl: "https://github.com/taras/executable.md/actions/runs/32589205721",
  attempt: 1,
  runner: "ubuntu-latest",
  deno: "deno 2.9.5 (stable, release, x86_64-unknown-linux-gnu)",
  node: "v22.23.2",
  bun: "1.3.14",
};

const VALID: TestWeights = {
  version: 1,
  source: SOURCE,
  runtimes: {
    deno: { "packages/core/tests/a.test.ts": 1234 },
    node: { "packages/core/tests/a.test.ts": 2345 },
    bun: { "packages/core/tests/a.test.ts": 3456 },
  },
};

const ENVIRONMENT: Record<string, string> = {
  WEIGHTS_COMMIT: SOURCE.commit,
  WEIGHTS_RUN_URL: SOURCE.runUrl,
  WEIGHTS_ATTEMPT: "1",
  WEIGHTS_RUNNER: SOURCE.runner,
  WEIGHTS_DENO: SOURCE.deno,
  WEIGHTS_NODE: SOURCE.node,
  WEIGHTS_BUN: SOURCE.bun,
};

const IDENTITY: RunIdentity = {
  commit: SOURCE.commit,
  runUrl: SOURCE.runUrl,
  attempt: SOURCE.attempt,
  runner: SOURCE.runner,
};

const ALPHA = "packages/alpha/tests/one.test.ts";
const BETA = "packages/beta/tests/two.test.ts";
const GAMMA = "packages/gamma/tests/three.test.ts";

/** A two-member workspace, so measurement walks a real discovery result. */
function* workspace(): Operation<URL> {
  const base = yield* useTempDirectory("test-weights-");
  const root = pathToFileURL(`${base}/`);

  yield* writeTextFile(new URL("deno.json", root), JSON.stringify({ workspace: ["packages/*"] }));
  for (const file of [ALPHA, BETA]) {
    yield* ensureDir(new URL(file.replace(/\/[^/]+$/, "/"), root));
    yield* writeTextFile(new URL(file, root), "");
  }
  return root;
}

interface Recorder {
  launches: string[];
  run: RunLaunch;
}

/** Records every launch, and fails the one named by `failing`. */
function recorder(failing?: string): Recorder {
  const launches: string[] = [];
  return {
    launches,
    *run(launch) {
      const line = `${launch.command} ${launch.arguments.join(" ")}`;
      launches.push(line);
      // Long enough that a real elapsed measurement cannot round to zero, and
      // a hard-coded weight would not agree with it.
      yield* sleep(5);
      return failing !== undefined && line.endsWith(failing) ? 3 : 0;
    },
  };
}

function* stagedNames(root: URL): Operation<string[]> {
  return (yield* readdir(new URL(".", root))).filter((name) => name.endsWith(".staged"));
}

/** `VALID` with one provenance field replaced by something the parser must refuse. */
function source(overrides: Record<string, unknown>): unknown {
  return { ...VALID, source: { ...SOURCE, ...overrides } };
}

/** `VALID` with Deno's weights replaced by an entry the parser must refuse. */
function weighed(entries: Record<string, unknown>): unknown {
  return { ...VALID, runtimes: { ...VALID.runtimes, deno: entries } };
}

const withoutBun: Record<string, unknown> = {
  commit: SOURCE.commit,
  runUrl: SOURCE.runUrl,
  attempt: SOURCE.attempt,
  runner: SOURCE.runner,
  deno: SOURCE.deno,
  node: SOURCE.node,
};

function refuses(text: string): boolean {
  try {
    parseTestWeights(text);
    return false;
  } catch (error) {
    return error instanceof TestWeightsError;
  }
}

describe("the weights file", () => {
  it("round-trips through the parser", function* () {
    expect(parseTestWeights(formatTestWeights(VALID))).toEqual(VALID);
  });

  it("writes stable key order and one trailing newline", function* () {
    const unsorted: TestWeights = {
      ...VALID,
      runtimes: {
        deno: { "packages/z/tests/z.test.ts": 2, "packages/a/tests/a.test.ts": 1 },
        node: {},
        bun: {},
      },
    };
    const text = formatTestWeights(unsorted);

    expect(text.endsWith("}\n")).toBe(true);
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"source"'));
    expect(text.indexOf('"source"')).toBeLessThan(text.indexOf('"runtimes"'));
    expect(text.indexOf('"deno"')).toBeLessThan(text.indexOf('"node"'));
    expect(text.indexOf('"node"')).toBeLessThan(text.indexOf('"bun"'));
    expect(text.indexOf("packages/a/tests/a.test.ts")).toBeLessThan(
      text.indexOf("packages/z/tests/z.test.ts"),
    );
    expect(formatTestWeights(unsorted)).toEqual(text);
  });

  it("accepts the valid file", function* () {
    expect(parseTestWeights(JSON.stringify(VALID)).source).toEqual(SOURCE);
  });

  it("refuses every field class it cannot place", function* () {
    const rejected: Array<[string, unknown]> = [
      ["not JSON at all", "{"],
      ["a JSON array", "[]"],
      ["a JSON string", '"weights"'],
      ["another version", { ...VALID, version: 2 }],
      ["a missing version", { source: VALID.source, runtimes: VALID.runtimes }],
      ["a short commit", source({ commit: "0123456" })],
      ["an uppercase commit", source({ commit: SOURCE.commit.toUpperCase() })],
      ["a run URL from elsewhere", source({ runUrl: "https://example.com/actions/runs/1" })],
      [
        "an issue URL in the run field",
        source({ runUrl: "https://github.com/taras/executable.md/issues/280" }),
      ],
      ["a zero attempt", source({ attempt: 0 })],
      ["a fractional attempt", source({ attempt: 1.5 })],
      ["an attempt written as text", source({ attempt: "1" })],
      ["an empty runner", source({ runner: " " })],
      ["a missing bun version", { ...VALID, source: withoutBun }],
      ["a missing source", { version: 1, runtimes: VALID.runtimes }],
      ["an unknown runtime", { ...VALID, runtimes: { ...VALID.runtimes, deno22: {} } }],
      ["a missing runtime", { ...VALID, runtimes: { deno: {}, node: {} } }],
      ["a null weights map", { ...VALID, runtimes: { ...VALID.runtimes, deno: null } }],
      ["an absolute path", weighed({ "/etc/a.test.ts": 1 })],
      ["a traversing path", weighed({ "../x/tests/a.test.ts": 1 })],
      ["a path outside tests/", weighed({ "packages/core/src/a.test.ts": 1 })],
      ["a path that is not a test file", weighed({ "packages/core/tests/a.ts": 1 })],
      ["a Windows path", weighed({ "C:\\packages\\tests\\a.test.ts": 1 })],
      ["a zero weight", weighed({ "packages/core/tests/a.test.ts": 0 })],
      ["a negative weight", weighed({ "packages/core/tests/a.test.ts": -1 })],
      ["a fractional weight", weighed({ "packages/core/tests/a.test.ts": 12.5 })],
      ["a weight written as text", weighed({ "packages/core/tests/a.test.ts": "12" })],
      ["an overflowing weight", JSON.stringify(VALID).replace(":1234", ":1e400")],
    ];

    for (const [what, document] of rejected) {
      const text = typeof document === "string" ? document : JSON.stringify(document);
      expect({ what, refused: refuses(text) }).toEqual({ what, refused: true });
    }
  });
});

describe("provenance from the environment", () => {
  it("reads every variable the workflow supplies", function* () {
    expect(weightSourceFrom((variable) => ENVIRONMENT[variable])).toEqual(SOURCE);
  });

  it("names each missing variable rather than defaulting", function* () {
    for (const variable of Object.values(PROVENANCE_VARIABLES)) {
      const partial: Record<string, string> = { ...ENVIRONMENT, [variable]: "" };
      expect(() => weightSourceFrom((name) => partial[name])).toThrow(variable);
    }
    expect(() => weightSourceFrom(() => undefined)).toThrow(TestWeightsError);
  });

  it("refuses a value it cannot place", function* () {
    const wrong: Record<string, string> = { ...ENVIRONMENT, WEIGHTS_COMMIT: "not-a-commit" };
    expect(() => weightSourceFrom((name) => wrong[name])).toThrow(TestWeightsError);
  });

  it("reads a run's identity without its toolchain versions", function* () {
    const identity: Record<string, string> = {
      WEIGHTS_COMMIT: SOURCE.commit,
      WEIGHTS_RUN_URL: SOURCE.runUrl,
      WEIGHTS_ATTEMPT: "1",
      WEIGHTS_RUNNER: SOURCE.runner,
    };
    expect(runIdentityFrom((name) => identity[name])).toEqual(IDENTITY);
    for (const variable of Object.keys(identity)) {
      const partial: Record<string, string> = { ...identity, [variable]: "" };
      expect(() => runIdentityFrom((name) => partial[name])).toThrow(variable);
    }
  });

  it("parses provenance the same way wherever it came from", function* () {
    expect(parseWeightSource({ ...SOURCE })).toEqual(SOURCE);
    expect(() => parseWeightSource({ ...SOURCE, runUrl: "runs/1" })).toThrow(TestWeightsError);
  });
});

/** A complete record for `runtime` covering both workspace files, with `overrides` applied. */
function complete(
  runtime: Runtime,
  overrides: Partial<RuntimeMeasurement> = {},
): RuntimeMeasurement {
  return {
    runtime,
    status: "complete",
    source: SOURCE,
    applicable: [ALPHA, BETA],
    measured: [
      { file: ALPHA, ms: 10 },
      { file: BETA, ms: 20 },
    ],
    failure: null,
    ...overrides,
  };
}

const APPLICABLE: Record<Runtime, string[]> = {
  deno: [ALPHA, BETA],
  node: [ALPHA, BETA],
  bun: [ALPHA, BETA],
};

function allComplete(): Record<Runtime, RuntimeMeasurement> {
  return { deno: complete("deno"), node: complete("node"), bun: complete("bun") };
}

/** The text an assembly refuses with, or `undefined` when it assembles. */
function refusal(measurements: Partial<Record<Runtime, RuntimeMeasurement>>): string | undefined {
  try {
    assembleTestWeights(IDENTITY, APPLICABLE, measurements);
    return undefined;
  } catch (error) {
    if (!(error instanceof TestWeightsError)) {
      throw error;
    }
    return error.message;
  }
}

function* recorded(directory: URL, runtime: Runtime): Operation<RuntimeMeasurement> {
  return parseRuntimeMeasurement(yield* readTextFile(measurementFile(directory, runtime)));
}

describe("measuring one runtime", () => {
  it("runs every applicable file once, alone, under only the runtime it was given", function* () {
    for (const runtime of RUNTIMES) {
      const root = yield* workspace();
      const runs = recorder();

      const measurement = yield* TestRuns.with(runs.run, () =>
        measureRuntime(runtime, root, SOURCE, measurementFile(root, runtime)),
      );

      expect(runs.launches).toEqual(
        [ALPHA, BETA].map((file) => {
          const launch = oneFileCommand(runtime, file);
          return `${launch.command} ${launch.arguments.join(" ")}`;
        }),
      );
      expect(measurement.runtime).toEqual(runtime);
      expect(measurement.status).toEqual("complete");
      expect(measurement.applicable).toEqual([ALPHA, BETA]);
      expect(measurement.measured.map((entry) => entry.file)).toEqual([ALPHA, BETA]);
      expect(measurement.source).toEqual(SOURCE);
      expect(yield* recorded(root, runtime)).toEqual(measurement);
    }
  });

  it("records the child's own elapsed time", function* () {
    const root = yield* workspace();

    const measurement = yield* TestRuns.with(recorder().run, () =>
      measureRuntime("node", root, SOURCE, measurementFile(root, "node")),
    );

    for (const entry of measurement.measured) {
      expect(Number.isSafeInteger(entry.ms)).toBe(true);
      // The recorder sleeps 5ms per file; a constant or a zero would not.
      expect(entry.ms).toBeGreaterThanOrEqual(4);
    }
    expect(parseRuntimeMeasurement(formatRuntimeMeasurement(measurement))).toEqual(measurement);
  });

  it("keeps a partial record of every finished file while it runs", function* () {
    const root = yield* workspace();
    const runs = recorder();
    const seen: RuntimeMeasurement[] = [];

    yield* TestRuns.with(
      function* (launch) {
        seen.push(yield* recorded(root, "deno"));
        return yield* runs.run(launch);
      },
      () => measureRuntime("deno", root, SOURCE, measurementFile(root, "deno")),
    );

    expect(seen.map((record) => record.status)).toEqual(["partial", "partial"]);
    expect(seen.map((record) => record.measured.map((entry) => entry.file))).toEqual([[], [ALPHA]]);
    expect((yield* recorded(root, "deno")).status).toEqual("complete");
  });

  it("leaves a partial record of the finished files when it is halted", function* () {
    const root = yield* workspace();
    const started = withResolvers<void>();
    const runs = recorder();

    const task = yield* spawn(() =>
      TestRuns.with(
        function* (launch) {
          if (launch.arguments.includes(BETA)) {
            started.resolve();
            yield* suspend();
          }
          return yield* runs.run(launch);
        },
        () => measureRuntime("bun", root, SOURCE, measurementFile(root, "bun")),
      ),
    );
    yield* started.operation;
    yield* task.halt();

    const record = yield* recorded(root, "bun");
    expect(record.status).toEqual("partial");
    expect(record.measured.map((entry) => entry.file)).toEqual([ALPHA]);
    expect(record.failure).toBeNull();
    expect(yield* exists(weightsFile(root))).toBe(false);
    expect(yield* stagedNames(root)).toEqual([]);
  });

  it("records a failing file as failed, stops there, and writes no weights", function* () {
    const root = yield* workspace();
    const runs = recorder(ALPHA);
    let failure: unknown;

    yield* TestRuns.with(runs.run, function* () {
      try {
        yield* measureRuntime("deno", root, SOURCE, measurementFile(root, "deno"));
      } catch (error) {
        failure = error;
      }
    });

    expect(`${failure}`).toContain(ALPHA);
    expect(runs.launches).toHaveLength(1);
    const record = yield* recorded(root, "deno");
    expect(record.status).toEqual("failed");
    expect(record.failure).toEqual({ file: ALPHA, status: 3 });
    expect(record.measured).toEqual([]);
    expect(yield* exists(weightsFile(root))).toBe(false);
    expect(yield* stagedNames(root)).toEqual([]);
  });
});

describe("the runtime measurement record", () => {
  it("round-trips through the parser", function* () {
    const failed = complete("bun", {
      status: "failed",
      measured: [{ file: ALPHA, ms: 10 }],
      failure: { file: BETA, status: 1 },
    });
    for (const measurement of [complete("deno"), failed]) {
      expect(parseRuntimeMeasurement(formatRuntimeMeasurement(measurement))).toEqual(measurement);
    }
  });

  it("refuses every shape other than the current one", function* () {
    const valid = JSON.parse(formatRuntimeMeasurement(complete("deno")));
    const rejected: Array<[string, unknown]> = [
      ["not JSON at all", "{"],
      ["an extra field", { ...valid, weights: {} }],
      ["a missing failure", { ...valid, failure: undefined }],
      ["an unknown runtime", { ...valid, runtime: "deno22" }],
      ["an unknown status", { ...valid, status: "cancelled" }],
      ["a failed status without a failure", { ...valid, status: "failed" }],
      ["a failure on a complete record", { ...valid, failure: { file: BETA, status: 1 } }],
      ["an extra provenance field", { ...valid, source: { ...valid.source, host: "laptop" } }],
      ["a missing provenance field", { ...valid, source: withoutBun }],
      ["a path outside tests/", { ...valid, applicable: ["packages/core/src/a.test.ts"] }],
      ["a zero millisecond", { ...valid, measured: [{ file: ALPHA, ms: 0 }] }],
      ["an extra measured field", { ...valid, measured: [{ file: ALPHA, ms: 1, runs: 2 }] }],
      ["measurements as a map", { ...valid, measured: { [ALPHA]: 1 } }],
    ];

    for (const [what, document] of rejected) {
      const text = typeof document === "string" ? document : JSON.stringify(document);
      let refused = false;
      try {
        parseRuntimeMeasurement(text);
      } catch (error) {
        refused = error instanceof TestWeightsError;
      }
      expect({ what, refused }).toEqual({ what, refused: true });
    }
  });
});

describe("assembling the measurement", () => {
  it("assembles three complete records into the committed format", function* () {
    const weights = assembleTestWeights(IDENTITY, APPLICABLE, allComplete());

    expect(weights).toEqual({
      version: 1,
      source: SOURCE,
      runtimes: {
        deno: { [ALPHA]: 10, [BETA]: 20 },
        node: { [ALPHA]: 10, [BETA]: 20 },
        bun: { [ALPHA]: 10, [BETA]: 20 },
      },
    });
    expect(parseTestWeights(formatTestWeights(weights))).toEqual(weights);
  });

  it("refuses every set of records that does not prove the whole corpus in one run", function* () {
    const cases: Array<[string, Partial<Record<Runtime, RuntimeMeasurement>>, string]> = [
      ["a missing runtime", { deno: complete("deno"), node: complete("node") }, "for bun"],
      [
        "a runtime cut off partway",
        { ...allComplete(), deno: complete("deno", { status: "partial", measured: [] }) },
        "deno is partial: 0 of 2 files passed",
      ],
      [
        "a runtime stopped by a failing file",
        {
          ...allComplete(),
          node: complete("node", {
            status: "failed",
            measured: [{ file: ALPHA, ms: 10 }],
            failure: { file: BETA, status: 1 },
          }),
        },
        `node is failed: 1 of 2 files passed; ${BETA} exited 1`,
      ],
      [
        "another commit",
        {
          ...allComplete(),
          bun: complete("bun", { source: { ...SOURCE, commit: "f".repeat(40) } }),
        },
        `bun was measured with commit ${"f".repeat(40)}`,
      ],
      [
        "another run",
        {
          ...allComplete(),
          deno: complete("deno", {
            source: { ...SOURCE, runUrl: "https://github.com/taras/executable.md/actions/runs/2" },
          }),
        },
        "deno was measured with runUrl",
      ],
      [
        "another attempt",
        { ...allComplete(), node: complete("node", { source: { ...SOURCE, attempt: 2 } }) },
        "node was measured with attempt 2, not 1",
      ],
      [
        "another runner",
        {
          ...allComplete(),
          bun: complete("bun", { source: { ...SOURCE, runner: "ubuntu-24.04-arm" } }),
        },
        "bun was measured with runner ubuntu-24.04-arm",
      ],
      [
        "a different toolchain version",
        { ...allComplete(), bun: complete("bun", { source: { ...SOURCE, node: "v24.0.0" } }) },
        `bun was measured with node v24.0.0, but deno with ${SOURCE.node}`,
      ],
      [
        "a record filed under another runtime",
        { ...allComplete(), deno: complete("node") },
        "the deno record describes node",
      ],
      [
        "an applicable file that was never measured",
        { ...allComplete(), node: complete("node", { measured: [{ file: ALPHA, ms: 10 }] }) },
        `node has no measurement for 1 applicable files: ${BETA}`,
      ],
      [
        "a file this checkout does not apply",
        {
          ...allComplete(),
          bun: complete("bun", {
            measured: [...complete("bun").measured, { file: GAMMA, ms: 30 }],
          }),
        },
        `bun measured files this checkout does not apply: ${GAMMA}`,
      ],
      [
        "a file measured twice",
        {
          ...allComplete(),
          deno: complete("deno", {
            measured: [...complete("deno").measured, { file: BETA, ms: 21 }],
          }),
        },
        `deno measured more than once: ${BETA}`,
      ],
      [
        "a different applicable corpus",
        { ...allComplete(), node: complete("node", { applicable: [ALPHA] }) },
        "node was measured against a corpus of 1 files, but this checkout applies 2",
      ],
    ];

    for (const [what, measurements, reason] of cases) {
      const refused = refusal(measurements);
      expect({ what, named: refused?.includes(reason) ?? false, refused }).toEqual({
        what,
        named: true,
        refused,
      });
    }
  });

  it("assembles what the measuring jobs wrote, and refuses while one is absent", function* () {
    const root = yield* workspace();
    const output = new URL("measurements/", root);
    yield* ensureDir(output);

    for (const runtime of RUNTIMES) {
      const absent = yield* refusalOf(() => assembleMeasurements(root, output, IDENTITY));
      expect(absent).toContain(
        `no measurement was recorded for ${RUNTIMES.slice(RUNTIMES.indexOf(runtime)).join(", ")}`,
      );
      yield* TestRuns.with(recorder().run, () =>
        measureRuntime(runtime, root, SOURCE, measurementFile(output, runtime)),
      );
    }

    const weights = yield* assembleMeasurements(root, output, IDENTITY);
    yield* writeTestWeights(weightsFile(root), weights);

    expect(parseTestWeights(yield* readTextFile(weightsFile(root)))).toEqual(weights);
    for (const runtime of RUNTIMES) {
      expect(weights.runtimes[runtime]).toEqual(
        Object.fromEntries(
          (yield* recorded(output, runtime)).measured.map((entry) => [entry.file, entry.ms]),
        ),
      );
    }
    expect(yield* stagedNames(root)).toEqual([]);
  });

  it("publishes nothing from a failed runtime's record", function* () {
    const root = yield* workspace();
    const output = new URL("measurements/", root);
    yield* ensureDir(output);

    for (const runtime of RUNTIMES) {
      yield* TestRuns.with(recorder(runtime === "node" ? BETA : undefined).run, function* () {
        try {
          yield* measureRuntime(runtime, root, SOURCE, measurementFile(output, runtime));
        } catch {
          // The failure is the record's to report; assembly is what is under test.
        }
      });
    }

    const reason = yield* refusalOf(function* () {
      yield* writeTestWeights(
        weightsFile(root),
        yield* assembleMeasurements(root, output, IDENTITY),
      );
    });

    expect(reason).toContain(`node is failed: 1 of 2 files passed; ${BETA} exited 3`);
    expect(yield* exists(weightsFile(root))).toBe(false);
    expect(yield* stagedNames(root)).toEqual([]);
  });
});

/** The refusal `operation` fails with, or a failure of the test when it succeeds. */
function* refusalOf(operation: () => Operation<unknown>): Operation<string> {
  try {
    yield* operation();
  } catch (error) {
    if (error instanceof TestWeightsError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected a TestWeightsError");
}
