/**
 * The measurement command and the dispatch hook that runs it.
 *
 * Weights are only worth what their provenance says, and provenance is the one
 * thing a measurement cannot discover for itself — so the command refuses an
 * incomplete environment, and refuses it before it has spent an hour running
 * tests it could never write the result of. The hook is held to supplying every
 * value, to preparing the checkout the way the suites are prepared, and to
 * being read-only: it hands a human an artifact to commit rather than
 * committing one.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import matter from "gray-matter";
import type { Operation } from "effection";
import { exists, readTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { fileURLToPath } from "node:url";

import { PROVENANCE_VARIABLES, weightsFile } from "../lib/test-weights.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";

const ROOT = new URL("../../", import.meta.url);
const WORKFLOW = new URL(".github/workflows/measure-test-weights.yml", ROOT);
const CI_WORKFLOW = new URL(".github/workflows/ci.yml", ROOT);

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  timeout?: number;
  env: Record<string, string>;
  with: Record<string, string>;
}

interface Job {
  steps: Step[];
  permissions?: Record<string, string>;
  timeout?: number;
  needs?: unknown;
  if?: unknown;
  strategy: Record<string, unknown>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown, label: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value, label)).map(([key, entry]) => [key, `${entry}`]),
  );
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function steps(value: unknown, label: string): Step[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value.map((entry, index) => {
    const step = object(entry, `${label}[${index}]`);
    return {
      name: optionalString(step, "name"),
      uses: optionalString(step, "uses"),
      run: optionalString(step, "run"),
      if: optionalString(step, "if"),
      timeout: optionalNumber(step, "timeout-minutes"),
      env: "env" in step ? strings(step.env, `${label}[${index}].env`) : {},
      with: "with" in step ? strings(step.with, `${label}[${index}].with`) : {},
    };
  });
}

function* document(path: URL): Operation<Record<string, unknown>> {
  return object(matter(`---\n${yield* readTextFile(path)}\n---`).data, "workflow");
}

function parseJob(id: string, value: unknown): Job {
  const job = object(value, `workflow.jobs.${id}`);
  return {
    steps: steps(job.steps, `workflow.jobs.${id}.steps`),
    permissions:
      "permissions" in job
        ? strings(job.permissions, `workflow.jobs.${id}.permissions`)
        : undefined,
    timeout: optionalNumber(job, "timeout-minutes"),
    needs: job.needs,
    if: job.if,
    strategy: "strategy" in job ? object(job.strategy, `workflow.jobs.${id}.strategy`) : {},
  };
}

/** The workflow, and its first job: the one that measures. */
function* measurement(): Operation<{ workflow: Record<string, unknown>; job: Job }> {
  const workflow = yield* document(WORKFLOW);
  const jobs = object(workflow.jobs, "workflow.jobs");
  const entry = Object.entries(jobs)[0];
  if (entry === undefined) {
    throw new Error("the measurement workflow defines no job");
  }
  return { workflow, job: parseJob(entry[0], entry[1]) };
}

/** Every job the workflow defines, by ID. */
function* workflowJobs(): Operation<Record<string, Job>> {
  const workflow = yield* document(WORKFLOW);
  return Object.fromEntries(
    Object.entries(object(workflow.jobs, "workflow.jobs")).map(([id, job]) => [
      id,
      parseJob(id, job),
    ]),
  );
}

function stepRunning(job: Job, command: string): Step {
  const step = job.steps.find((candidate) => (candidate.run ?? "").includes(command));
  if (step === undefined) {
    throw new Error(`no step runs ${command}`);
  }
  return step;
}

function uploads(job: Job): Step[] {
  return job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact"));
}

/**
 * The slowest complete runtime run 40829223380 observed, in minutes: Deno's
 * whole corpus. A runtime's allowance that does not clear it with room to grow
 * would time out on the corpus as it already is.
 */
const LONGEST_OBSERVED_RUNTIME_MINUTES = 105.2;

/** `deno task weights:measure` with an environment and arguments of the test's choosing. */
function* measure(
  provenance: Record<string, string>,
  args: string[] = [],
): Operation<{ code?: number; stderr: string }> {
  const result = yield* exec(Deno.execPath(), {
    arguments: ["task", "weights:measure", ...args],
    cwd: fileURLToPath(ROOT),
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      ...provenance,
    },
  }).join();
  return { code: result.code, stderr: result.stderr };
}

const COMPLETE: Record<string, string> = {
  WEIGHTS_COMMIT: "0123456789abcdef0123456789abcdef01234567",
  WEIGHTS_RUN_URL: "https://github.com/taras/executable.md/actions/runs/1",
  WEIGHTS_ATTEMPT: "1",
  WEIGHTS_RUNNER: "ubuntu-latest",
  WEIGHTS_DENO: "deno 2.9.5",
  WEIGHTS_NODE: "v22.23.2",
  WEIGHTS_BUN: "1.3.14",
};

/** What measurement prints before it launches its first test process. */
const FIRST_LAUNCH = "measuring ";

/**
 * The committed weights exactly as they are, or `undefined` when there are
 * none.
 *
 * A refusal must leave them alone, and until the repository committed a
 * measurement that was provable by the file's absence. It is not any more: the
 * file exists now, so what is asserted is that the bytes did not move.
 */
function* committedWeights(): Operation<string | undefined> {
  const path = weightsFile(ROOT);
  return (yield* exists(path)) ? yield* readTextFile(path) : undefined;
}

describe("the measurement command", () => {
  it("refuses an empty environment before running a single test", function* () {
    const before = yield* committedWeights();

    const { code, stderr } = yield* measure({});

    expect(code).toEqual(1);
    for (const variable of Object.values(PROVENANCE_VARIABLES)) {
      expect(stderr).toContain(variable);
    }
    expect(stderr).not.toContain(FIRST_LAUNCH);
    expect(yield* committedWeights()).toEqual(before);
  });

  it("names the one value it is missing", function* () {
    const before = yield* committedWeights();

    const { code, stderr } = yield* measure({ ...COMPLETE, WEIGHTS_BUN: "" });

    expect(code).toEqual(1);
    expect(stderr).toContain("WEIGHTS_BUN");
    expect(stderr).not.toContain(FIRST_LAUNCH);
    expect(yield* committedWeights()).toEqual(before);
  });

  it("refuses a runtime it does not know before running a single test", function* () {
    const output = yield* useTempDirectory("measure-weights-");

    const { code, stderr } = yield* measure(COMPLETE, ["python", output]);

    expect(code).toEqual(1);
    expect(stderr).toContain("usage:");
    expect(stderr).not.toContain(FIRST_LAUNCH);
  });

  it("refuses to assemble without the run's identity", function* () {
    const before = yield* committedWeights();
    const output = yield* useTempDirectory("measure-weights-");

    const { code, stderr } = yield* measure({}, ["assemble", output]);

    expect(code).toEqual(1);
    for (const variable of [
      "WEIGHTS_COMMIT",
      "WEIGHTS_RUN_URL",
      "WEIGHTS_ATTEMPT",
      "WEIGHTS_RUNNER",
    ]) {
      expect(stderr).toContain(variable);
    }
    expect(yield* committedWeights()).toEqual(before);
  });

  it("assembles nothing from a run that left no records, and leaves the weights alone", function* () {
    const before = yield* committedWeights();
    const output = yield* useTempDirectory("measure-weights-");

    const { code, stderr } = yield* measure(COMPLETE, ["assemble", output]);

    expect(code).toEqual(1);
    expect(stderr).toContain(`no measurement was recorded for ${RUNTIMES.join(", ")}`);
    expect(yield* committedWeights()).toEqual(before);
  });

  it("is the only task that writes the weights", function* () {
    const manifest = object(
      JSON.parse(yield* readTextFile(new URL("deno.json", ROOT))),
      "deno.json",
    );
    const tasks = strings(manifest.tasks, "deno.json.tasks");

    const writers = Object.entries(tasks).filter(([, command]) =>
      command.includes("measure-test-weights.ts"),
    );
    expect(writers.map(([name]) => name)).toEqual(["weights:measure"]);

    // And no ordinary check reaches it: a weights refresh inside
    // `deno task verify` would rewrite tracked data on every verification.
    // #546 replaced that battery with a fixed topology whose commands are
    // built in the adapter, so the whole adapter is what gets read — a
    // narrower assertion could miss a command added beside the ones it knew.
    expect(yield* readTextFile(new URL("scripts/verify.ts", ROOT))).not.toContain("weights");
    expect(yield* readTextFile(new URL("scripts/lib/verify.ts", ROOT))).not.toContain("weights");
  });
});

describe("the measurement workflow", () => {
  it("runs only when someone dispatches it", function* () {
    const { workflow } = yield* measurement();

    expect(Object.keys(object(workflow.on, "workflow.on"))).toEqual(["workflow_dispatch"]);
  });

  it("holds read-only permission and neither commits nor pushes", function* () {
    const { workflow, job } = yield* measurement();

    expect(job.permissions ?? strings(workflow.permissions, "workflow.permissions")).toEqual({
      contents: "read",
    });
    for (const step of job.steps) {
      expect(step.run ?? "").not.toContain("git commit");
      expect(step.run ?? "").not.toContain("git push");
    }
  });

  it("prepares the checkout before it measures anything", function* () {
    const { job } = yield* measurement();
    const commands = job.steps.map((step) => step.run ?? "");

    const prepares = commands.findIndex((run) => run.includes("deno task setup"));
    const measures = commands.findIndex((run) => run.includes("weights:measure"));

    expect(prepares).toBeGreaterThanOrEqual(0);
    expect(measures).toBeGreaterThan(prepares);
  });

  it("supplies every provenance value the command demands", function* () {
    const { job } = yield* measurement();
    const measures = job.steps.find((step) => (step.run ?? "").includes("weights:measure"));
    if (measures === undefined) {
      throw new Error("no step runs weights:measure");
    }

    for (const variable of Object.values(PROVENANCE_VARIABLES)) {
      expect({
        variable,
        supplied: variable in measures.env || (measures.run ?? "").includes(variable),
      }).toEqual({ variable, supplied: true });
    }
    // The commit and the run are the workflow's own, not a value someone typed.
    expect(measures.env.WEIGHTS_COMMIT).toContain("github.sha");
    expect(measures.env.WEIGHTS_RUN_URL).toContain("github.run_id");
    expect(measures.env.WEIGHTS_ATTEMPT).toContain("github.run_attempt");
  });

  it("installs the same toolchain the suites are measured under", function* () {
    const { job } = yield* measurement();
    const ci = yield* readTextFile(CI_WORKFLOW);

    const actions = job.steps.filter((step) => step.uses !== undefined);
    expect(actions.length).toBeGreaterThan(0);

    for (const step of actions) {
      if (step.uses?.startsWith("actions/upload-artifact")) {
        continue;
      }
      expect({ uses: step.uses, pinned: ci.includes(step.uses ?? "") }).toEqual({
        uses: step.uses,
        pinned: true,
      });
      for (const [key, value] of Object.entries(step.with)) {
        expect({
          key,
          value,
          agrees: ci.includes(`${key}: ${value}`) || ci.includes(`${key}: "${value}"`),
        }).toEqual({ key, value, agrees: true });
      }
    }
  });

  it("uploads the file it produced", function* () {
    const { assemble } = yield* workflowJobs();
    const [upload] = uploads(assemble);
    if (upload === undefined) {
      throw new Error("no step uploads the measurement");
    }

    expect(upload.with.name).toEqual("test-weights");
    expect(upload.with.path).toEqual("test-weights.json");
    expect(upload.with["if-no-files-found"]).toEqual("error");
  });

  it("measures each runtime in a job of its own", function* () {
    const { measure: measuring } = yield* workflowJobs();
    const matrix = object(measuring.strategy.matrix, "measuring.strategy.matrix");

    expect(matrix.runtime).toEqual([...RUNTIMES]);
    expect(measuring.strategy["fail-fast"]).toBe(false);
    expect(stepRunning(measuring, "weights:measure").run).toContain(
      'deno task weights:measure ${{ matrix.runtime }} "$RUNNER_TEMP/measurements"',
    );
  });

  it("finishes inside its execution budget", function* () {
    const { measure: measuring, assemble } = yield* workflowJobs();
    const step = stepRunning(measuring, "weights:measure");
    if (measuring.timeout === undefined || assemble.timeout === undefined) {
      throw new Error("every job carries its own timeout");
    }
    if (step.timeout === undefined) {
      throw new Error("the measuring step carries its own timeout");
    }

    // Measuring jobs run side by side, so the run's wall clock is the slowest
    // one plus assembly, and both must fit under the three hours the job had.
    expect(measuring.timeout + assemble.timeout).toBeLessThan(180);
    // Inside the job's, so an overrun still reaches the upload after it.
    expect(step.timeout).toBeLessThan(measuring.timeout);
    expect(step.timeout).toBeGreaterThanOrEqual(LONGEST_OBSERVED_RUNTIME_MINUTES * 1.25);
  });

  it("keeps each runtime's record however its job ended", function* () {
    const { measure: measuring } = yield* workflowJobs();
    const [upload] = uploads(measuring);
    if (upload === undefined) {
      throw new Error("no step uploads a runtime's measurement");
    }

    expect(upload.if).toEqual("always()");
    expect(upload.with.name).toEqual(
      "test-weights-${{ matrix.runtime }}-attempt-${{ github.run_attempt }}",
    );
    expect(upload.with.path).toEqual(
      "${{ runner.temp }}/measurements/test-weights-${{ matrix.runtime }}.json",
    );
  });

  it("assembles only after every runtime's job succeeded", function* () {
    const { measure: measuring, assemble } = yield* workflowJobs();

    // No `if` anywhere: GitHub then skips the job when any measuring job
    // failed, was cancelled or timed out, and no step can opt back in.
    expect(assemble.needs).toEqual("measure");
    expect(assemble.if).toBeUndefined();
    for (const step of assemble.steps) {
      expect({ step: step.name ?? step.uses, if: step.if }).toEqual({
        step: step.name ?? step.uses,
        if: undefined,
      });
    }

    const download = assemble.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact"),
    );
    expect(download?.with.pattern).toEqual("test-weights-*-attempt-${{ github.run_attempt }}");
    expect(download?.with.path).toEqual("${{ runner.temp }}/measurements");

    const assembles = stepRunning(assemble, "weights:measure assemble");
    expect(assembles.run).toContain('"$RUNNER_TEMP/measurements"');
    expect(assembles.env.WEIGHTS_COMMIT).toContain("github.sha");
    expect(assembles.env.WEIGHTS_RUN_URL).toContain("github.run_id");
    expect(assembles.env.WEIGHTS_ATTEMPT).toContain("github.run_attempt");
    expect(assembles.env.WEIGHTS_RUNNER).toEqual(
      stepRunning(measuring, "weights:measure").env.WEIGHTS_RUNNER,
    );
  });
});
