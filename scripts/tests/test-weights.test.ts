/**
 * Weights are durable repository data that decides what every CI shard runs,
 * and they arrive from a hosted run nobody watches. So the parser validates the
 * file rather than trusting it, and measurement is held to running each file
 * once, alone, through the command a shard will use — and to writing nothing at
 * all when any of it fails.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readdir, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { pathToFileURL } from "node:url";

import {
  formatTestWeights,
  measureTestWeights,
  parseTestWeights,
  parseWeightSource,
  PROVENANCE_VARIABLES,
  TestRuns,
  TestWeightsError,
  weightsFile,
  weightSourceFrom,
  writeTestWeights,
} from "../lib/test-weights.ts";
import type { RunLaunch, TestWeights, WeightSource } from "../lib/test-weights.ts";
import { oneFileCommand } from "../lib/runtime-tests.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";

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

const ALPHA = "packages/alpha/tests/one.test.ts";
const BETA = "packages/beta/tests/two.test.ts";

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

  it("parses provenance the same way wherever it came from", function* () {
    expect(parseWeightSource({ ...SOURCE })).toEqual(SOURCE);
    expect(() => parseWeightSource({ ...SOURCE, runUrl: "runs/1" })).toThrow(TestWeightsError);
  });
});

describe("measuring the corpus", () => {
  it("runs every applicable file once, alone, under every runtime", function* () {
    const root = yield* workspace();
    const runs = recorder();

    const weights = yield* TestRuns.with(runs.run, () => measureTestWeights(root, SOURCE));

    expect(runs.launches).toEqual(
      RUNTIMES.flatMap((runtime) =>
        [ALPHA, BETA].map((file) => {
          const launch = oneFileCommand(runtime, file);
          return `${launch.command} ${launch.arguments.join(" ")}`;
        }),
      ),
    );
    expect(Object.keys(weights.runtimes.deno)).toEqual([ALPHA, BETA]);
    expect(weights.source).toEqual(SOURCE);
    expect(weights.version).toEqual(1);
  });

  it("records the child's own elapsed time", function* () {
    const root = yield* workspace();

    const weights = yield* TestRuns.with(recorder().run, () => measureTestWeights(root, SOURCE));

    for (const runtime of RUNTIMES) {
      for (const file of [ALPHA, BETA]) {
        const weight = weights.runtimes[runtime][file];
        expect(Number.isSafeInteger(weight)).toBe(true);
        // The recorder sleeps 5ms per file; a constant or a zero would not.
        expect(weight).toBeGreaterThanOrEqual(4);
      }
    }
    // What was measured is what the file will say.
    expect(parseTestWeights(formatTestWeights(weights))).toEqual(weights);
  });

  it("writes nothing when one measured file fails", function* () {
    const root = yield* workspace();
    const runs = recorder(BETA);
    const target = weightsFile(root);
    let failure: unknown;

    yield* TestRuns.with(runs.run, function* () {
      try {
        yield* writeTestWeights(target, yield* measureTestWeights(root, SOURCE));
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(Error);
    expect(`${failure}`).toContain(BETA);
    expect(yield* exists(target)).toBe(false);
    expect(yield* stagedNames(root)).toEqual([]);
    // It stopped at the failure rather than measuring the remaining runtimes.
    expect(runs.launches.length).toEqual(2);
  });

  it("replaces the file only after every measurement passed", function* () {
    const root = yield* workspace();
    const target = weightsFile(root);

    yield* TestRuns.with(recorder().run, function* () {
      yield* writeTestWeights(target, yield* measureTestWeights(root, SOURCE));
    });

    expect(yield* exists(target)).toBe(true);
    expect(yield* stagedNames(root)).toEqual([]);
  });
});
