import matter from "gray-matter";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";

import { applicableTestFiles } from "../lib/test-files.ts";
import { partitionTests } from "../lib/test-shards.ts";
import { parseTestWeights, weightsFile } from "../lib/test-weights.ts";
import { RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

const ROOT = new URL("../../", import.meta.url);
const CI_WORKFLOW = new URL("../../.github/workflows/ci.yml", import.meta.url);

interface Step {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
}

interface Strategy {
  failFast: unknown;
  shards: unknown;
}

interface Job {
  if?: string;
  name?: string;
  needs?: string[];
  steps: Step[];
  strategy?: Strategy;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = object(value, label);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, string(entry, `${label}.${key}`)]),
  );
}

function steps(value: unknown, label: string): Step[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value.map((entry, index) => {
    const step = object(entry, `${label}[${index}]`);
    return {
      env: "env" in step ? stringRecord(step.env, `${label}[${index}].env`) : undefined,
      name: "name" in step ? string(step.name, `${label}[${index}].name`) : undefined,
      run: "run" in step ? string(step.run, `${label}[${index}].run`) : undefined,
      uses: "uses" in step ? string(step.uses, `${label}[${index}].uses`) : undefined,
    };
  });
}

function strategy(value: unknown, label: string): Strategy {
  const record = object(value, label);
  const matrix = object(record.matrix, `${label}.matrix`);
  return { failFast: record["fail-fast"], shards: matrix.shard };
}

function job(value: unknown, label: string): Job {
  const record = object(value, label);
  return {
    if: "if" in record ? string(record.if, `${label}.if`) : undefined,
    name: "name" in record ? string(record.name, `${label}.name`) : undefined,
    needs: "needs" in record ? strings(record.needs, `${label}.needs`) : undefined,
    steps: steps(record.steps, `${label}.steps`),
    strategy: "strategy" in record ? strategy(record.strategy, `${label}.strategy`) : undefined,
  };
}

/** The three sharded runtime jobs, by job ID. */
const RUNTIME_JOBS: Record<string, Runtime> = {
  "test-deno": "deno",
  "test-node": "node",
  "test-bun": "bun",
};

function matrixJob(workflow: Record<string, Job>, id: string): Job {
  const found = workflow[id];
  if (found === undefined) {
    throw new Error(`workflow.jobs.${id} is missing`);
  }
  return found;
}

/** Every index a matrix declares, as declared. */
function shardIndices(job: Job, id: string): number[] {
  const shards = job.strategy?.shards;
  if (!Array.isArray(shards)) {
    throw new Error(`workflow.jobs.${id}.strategy.matrix.shard is not an array`);
  }
  return shards.map((entry, index) => {
    if (typeof entry !== "number") {
      throw new Error(`workflow.jobs.${id}.strategy.matrix.shard[${index}] is not a number`);
    }
    return entry;
  });
}

/** The step that runs the tests, which is the only one a shard argument reaches. */
function testStep(job: Job, id: string): Step {
  const found = job.steps.find((step) => step.name === "Test");
  if (found?.run === undefined) {
    throw new Error(`workflow.jobs.${id} has no Test step`);
  }
  return found;
}

function* workflow(): Operation<Record<string, Job>> {
  const source = yield* readTextFile(CI_WORKFLOW);
  const document = object(matter(`---\n${source}\n---`).data, "workflow");
  const jobs = object(document.jobs, "workflow.jobs");
  return Object.fromEntries(
    Object.entries(jobs).map(([id, value]) => [id, job(value, `workflow.jobs.${id}`)]),
  );
}

function green(workflow: Record<string, Job>): Job {
  const job = workflow.green;
  if (job === undefined) {
    throw new Error("workflow.jobs.green is missing");
  }
  return job;
}

function command(job: Job): string {
  if (job.steps.length !== 1) {
    throw new Error("green must have exactly one step");
  }
  const step = job.steps[0];
  if (step === undefined || step.run === undefined) {
    throw new Error("green must have a run step");
  }
  return step.run;
}

function allDependencies(workflow: Record<string, Job>): string[] {
  return Object.keys(workflow)
    .filter((id) => id !== "green")
    .sort();
}

function needsOf(job: Job): string[] {
  if (job.needs === undefined) {
    throw new Error("green.needs is missing");
  }
  return [...job.needs].sort();
}

function results(workflow: Record<string, Job>, result: string): Record<string, string> {
  return Object.fromEntries(allDependencies(workflow).map((dependency) => [dependency, result]));
}

/** The three shapes GitHub delivers this workflow in. */
type Occasion = "push" | "pull-request" | "repair";

/** Every occasion, named once, drawn from the union rather than asserted into it. */
const OCCASIONS: Occasion[] = ["push", "pull-request", "repair"];

const EVENTS: Record<Occasion, { EVENT: string; REPAIR: string }> = {
  push: { EVENT: "push", REPAIR: "false" },
  "pull-request": { EVENT: "pull_request", REPAIR: "false" },
  repair: { EVENT: "pull_request", REPAIR: "true" },
};

function* runGreen(
  commandText: string,
  values: Record<string, string>,
  occasion: Occasion,
): Operation<number | undefined> {
  const result = yield* exec("/bin/bash", {
    arguments: ["-c", commandText],
    env: {
      PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      ...EVENTS[occasion],
      RESULTS: JSON.stringify(
        Object.fromEntries(Object.entries(values).map(([key, result]) => [key, { result }])),
      ),
    },
  }).join();
  return result.code;
}

/**
 * Every job at the result the occasion requires: the two conditional jobs run
 * where they are meant to and are skipped where they are meant to be.
 */
function required(workflow: Record<string, Job>, occasion: Occasion): Record<string, string> {
  const values = results(workflow, "success");
  if (occasion === "push") {
    values["main-green"] = "skipped";
  }
  if (occasion === "pull-request") {
    values.composability = "skipped";
  }
  return values;
}

describe("the CI smoke job", () => {
  /**
   * The smoke job builds its binary by running the README's own Build target,
   * which is the point: a documented build that stopped working stops a
   * required check.
   *
   * Preparing the checkout is the installation owner's job. Under the root
   * `nodeModulesDir: "auto"`, the *first* `deno task xmd` to run initializes
   * `node_modules` itself — before any README block executes — so a job that
   * reached a source-CLI invocation first would install as a side effect of
   * running documentation, and would credit the README with work already done
   * for it. Hence the ordering, and hence "the first one": a later `xmd` step
   * added above the build would reintroduce exactly that.
   */
  it("prepares the checkout before its first source-CLI invocation", function* () {
    const smoke = (yield* workflow()).smoke;
    if (smoke === undefined) {
      throw new Error("workflow.jobs.smoke is missing");
    }

    const commands = smoke.steps.map((step) => step.run ?? "");
    const prepares = commands.findIndex((run) => run.includes("deno task setup"));
    const sourceCli = commands.findIndex((run) => run.includes("deno task xmd"));

    expect(prepares).toBeGreaterThanOrEqual(0);
    expect(sourceCli).toBeGreaterThanOrEqual(0);
    expect(prepares).toBeLessThan(sourceCli);
    // And that first source-CLI invocation is the documented build.
    expect(commands[sourceCli]).toContain("README.md#Build");
  });

  /**
   * Each of these proves something about the compiled binary that no source
   * run can: a claim that only holds if `deno compile` kept what the claim is
   * about. A script removed from the job is a proof silently withdrawn, so the
   * job is held to naming them.
   */
  it("runs every compiled-binary smoke script", function* () {
    const smoke = (yield* workflow()).smoke;
    if (smoke === undefined) {
      throw new Error("workflow.jobs.smoke is missing");
    }

    const commands = smoke.steps.map((step) => step.run ?? "").join("\n");
    for (const script of [
      "scripts/smoke-foreground.ts",
      "scripts/smoke-loaded-copy.ts",
      "scripts/smoke-fetch.ts",
    ]) {
      expect(commands).toContain(script);
    }
  });
});

describe("the sharded runtime jobs", () => {
  /**
   * The job IDs are unchanged on purpose. GitHub waits for a whole matrix
   * behind one ID, so `green.needs` keeps working without learning what a shard
   * is — and a shard that failed, was cancelled, or unexpectedly skipped still
   * makes that one dependency non-success.
   */
  it("keeps the three job IDs and makes each a fail-fast: false matrix", function* () {
    const parsed = yield* workflow();

    for (const id of Object.keys(RUNTIME_JOBS)) {
      const job = matrixJob(parsed, id);
      expect({ id, failFast: job.strategy?.failFast }).toEqual({ id, failFast: false });
      expect({ id, indices: shardIndices(job, id).length }).not.toEqual({ id, indices: 0 });
    }
  });

  it("declares each index once, and every index in one through the count", function* () {
    const parsed = yield* workflow();

    for (const id of Object.keys(RUNTIME_JOBS)) {
      const indices = shardIndices(matrixJob(parsed, id), id);

      expect({ id, indices }).toEqual({
        id,
        indices: Array.from({ length: indices.length }, (_, offset) => offset + 1),
      });
      expect({ id, distinct: new Set(indices).size }).toEqual({ id, distinct: indices.length });
    }
  });

  it("shows and invokes the same index out of the same count", function* () {
    const parsed = yield* workflow();

    for (const [id, runtime] of Object.entries(RUNTIME_JOBS)) {
      const job = matrixJob(parsed, id);
      const count = shardIndices(job, id).length;
      const selection = "${{ matrix.shard }}/" + count;

      expect({ id, name: job.name }).toEqual({ id, name: `${id} (${selection})` });
      const run = testStep(job, id).run ?? "";
      expect({ id, invokes: run.includes(selection) }).toEqual({ id, invokes: true });
      expect({ id, names: run.includes(runtime) }).toEqual({ id, names: true });
    }
  });

  /** A shard argument anywhere else would make a preparation step shard-specific. */
  it("gives the shard to the Test step and to nothing else", function* () {
    const parsed = yield* workflow();

    for (const id of Object.keys(RUNTIME_JOBS)) {
      const job = matrixJob(parsed, id);
      for (const step of job.steps) {
        expect({ id, step: step.name, sharded: (step.run ?? "").includes("matrix.shard") }).toEqual(
          { id, step: step.name, sharded: step.name === "Test" },
        );
      }
    }
  });

  /**
   * Every step above `Test` is what makes the runtime able to run at all. A
   * matrix that dropped one would still report six green shards.
   */
  it("keeps each runtime's own preparation, in order", function* () {
    const parsed = yield* workflow();
    const required: Record<string, string[]> = {
      "test-deno": [
        "deno task check",
        "deno task gen:publish-workflow",
        "deno task deps",
        "deno task build:web",
      ],
      "test-node": [
        "deno task deps",
        "deno task build:web",
        "pnpm install",
        "pnpm exec tsc --project tsconfig.node.json",
      ],
      "test-bun": ["bun install"],
    };

    for (const [id, commands] of Object.entries(required)) {
      const job = matrixJob(parsed, id);
      const runs = job.steps.map((step) => step.run ?? "");
      const test = runs.findIndex((run) => run.includes("matrix.shard"));

      let previous = -1;
      for (const command of commands) {
        const at = runs.findIndex((run) => run.includes(command));
        expect({ id, command, found: at >= 0 }).toEqual({ id, command, found: true });
        expect({ id, command, afterPrevious: at > previous }).toEqual({
          id,
          command,
          afterPrevious: true,
        });
        expect({ id, command, beforeTest: at < test }).toEqual({ id, command, beforeTest: true });
        previous = at;
      }
    }
  });

  it("keeps the Bun entrypoint smoke beside the Bun shards", function* () {
    const bun = matrixJob(yield* workflow(), "test-bun");
    const commands = bun.steps.map((step) => step.run ?? "").join("\n");

    expect(commands).toContain(
      "bun run packages/cli/src/bun.ts test smoke-test/test-agent/README.md",
    );
  });

  /** No escape hatch: a red shard has to be able to redden the job. */
  it("gives no shard a way to continue on error", function* () {
    const source = yield* readTextFile(CI_WORKFLOW);

    expect(source).not.toContain("continue-on-error");
  });
});

describe("the actual partition the workflow installs", () => {
  /**
   * Not synthetic data: the committed corpus, the committed exclusions, the
   * committed weights, and the counts `ci.yml` declares. This is the only place
   * that proves the numbers in the workflow describe a real, complete,
   * non-overlapping split of what CI is meant to run.
   */
  it("covers each runtime's applicable corpus exactly once", function* () {
    const parsed = yield* workflow();
    const weights = parseTestWeights(yield* readTextFile(weightsFile(ROOT)));

    for (const [id, runtime] of Object.entries(RUNTIME_JOBS)) {
      const count = shardIndices(matrixJob(parsed, id), id).length;
      const applicable = yield* applicableTestFiles(runtime, ROOT);
      const shards = partitionTests(applicable, weights.runtimes[runtime], count);
      const assigned = shards.flatMap((shard) => shard.files);

      expect({ id, shards: shards.length }).toEqual({ id, shards: count });
      expect({ id, assigned: [...assigned].sort() }).toEqual({
        id,
        assigned: [...applicable].sort(),
      });
      expect({ id, distinct: new Set(assigned).size }).toEqual({ id, distinct: applicable.length });
      for (const shard of shards) {
        expect({ id, index: shard.index, empty: shard.files.length === 0 }).toEqual({
          id,
          index: shard.index,
          empty: false,
        });
      }
    }
  });

  it("assigns the same files every time it is asked", function* () {
    const parsed = yield* workflow();
    const weights = parseTestWeights(yield* readTextFile(weightsFile(ROOT)));

    for (const [id, runtime] of Object.entries(RUNTIME_JOBS)) {
      const count = shardIndices(matrixJob(parsed, id), id).length;
      const applicable = yield* applicableTestFiles(runtime, ROOT);
      const recorded = weights.runtimes[runtime];

      expect(partitionTests(applicable, recorded, count)).toEqual(
        partitionTests(applicable, recorded, count),
      );
    }
  });

  it("weighs the corpus it is about to run", function* () {
    const weights = parseTestWeights(yield* readTextFile(weightsFile(ROOT)));

    for (const runtime of RUNTIMES) {
      const applicable = new Set(yield* applicableTestFiles(runtime, ROOT));
      const unmeasured = [...applicable].filter((file) => !(file in weights.runtimes[runtime]));

      // A file may be newer than the measurement — it runs at the fallback. The
      // measurement is stale in a way worth seeing when most of it is.
      expect({ runtime, share: unmeasured.length < applicable.size / 2 }).toEqual({
        runtime,
        share: true,
      });
    }
  });
});

describe("the conditional CI jobs", () => {
  function conditional(workflow: Record<string, Job>, id: string): string {
    const found = workflow[id];
    if (found === undefined) {
      throw new Error(`workflow.jobs.${id} is missing`);
    }
    if (found.if === undefined) {
      throw new Error(`workflow.jobs.${id}.if is missing`);
    }
    return found.if;
  }

  it("runs main-green on a pull request and on nothing else", function* () {
    expect(conditional(yield* workflow(), "main-green")).toEqual(
      "github.event_name == 'pull_request'",
    );
  });

  /**
   * The repair path is two halves: the gate excuses itself, and this job runs in
   * its place. `green` requires this job to succeed on a labelled pull request,
   * so a condition that stopped matching the label would not make the repair
   * path lax — it would make it unsatisfiable.
   */
  it("runs composability for a main push and for a repair pull request", function* () {
    const condition = conditional(yield* workflow(), "composability");

    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain(
      "contains(github.event.pull_request.labels.*.name, 'ci-main-red-fix')",
    );
  });

  /** An ordinary pull request keeps paying for neither of them. */
  it("gives an ordinary pull request no path to composability", function* () {
    const condition = conditional(yield* workflow(), "composability");

    expect(condition).not.toContain("github.event_name == 'pull_request'");
    expect(condition).not.toContain("always()");
  });
});

describe("the CI workflow aggregate", () => {
  it("defines green", function* () {
    expect(green(yield* workflow())).toBeDefined();
  });

  it("requires every other job and no future job can be omitted", function* () {
    const parsed = yield* workflow();
    expect(needsOf(green(parsed))).toEqual(allDependencies(parsed));
  });

  /**
   * Derived coverage cannot notice a job that left the workflow entirely — the
   * expectation shrinks with it. So the set is also named. A job added later
   * belongs in `green.needs` too, and the derived check above is what enforces
   * that half.
   */
  it("still requires every job that existed before the gate", function* () {
    const needs = needsOf(green(yield* workflow()));

    for (const job of [
      "lint",
      "test-deno",
      "jsr",
      "smoke",
      "filesystem-contract",
      "composability",
      "site",
      "test-node",
      "test-bun",
      "main-green",
    ]) {
      expect(needs).toContain(job);
    }
  });

  it("does not depend on itself", function* () {
    const parsed = yield* workflow();
    expect(needsOf(green(parsed))).not.toContain("green");
  });

  it("runs after failed dependencies", function* () {
    expect(green(yield* workflow()).if).toEqual("always()");
  });

  it("uses green as its check-run name", function* () {
    const aggregate = green(yield* workflow());
    expect(aggregate.name ?? "green").toEqual("green");
  });

  it("consumes the complete needs result object", function* () {
    const parsed = yield* workflow();
    const aggregate = green(parsed);
    const step = aggregate.steps[0];
    const commandText = command(aggregate);

    expect(step?.env?.RESULTS).toEqual("${{ toJSON(needs) }}");
    expect(commandText).toContain("to_entries[]");
    expect(commandText).not.toContain("${{ needs.");
  });

  it("prints every result before deciding", function* () {
    const commandText = command(green(yield* workflow()));
    const printed = commandText.indexOf('"\\(.value.result)\\t\\(.key)"');
    const decision = commandText.indexOf("unproven=");

    expect(printed).toBeGreaterThan(-1);
    expect(decision).toBeGreaterThan(printed);
  });

  it("accepts the result every job is required to produce, on each occasion", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));

    for (const occasion of ["push", "pull-request", "repair"] as const) {
      expect(yield* runGreen(commandText, required(parsed, occasion), occasion)).toEqual(0);
    }
  });

  /**
   * A skip used to be accepted from every job, which made "this job never ran"
   * indistinguishable from "this job passed". Two jobs are conditional now, so
   * the accepted result is per job and per event instead.
   */
  it("rejects an unexpected skip from a job that always runs", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));
    const unconditional = ["lint", "test-deno", "jsr", "smoke", "site", "test-node", "test-bun"];

    for (const occasion of ["push", "pull-request", "repair"] as const) {
      for (const job of unconditional) {
        const values = required(parsed, occasion);
        values[job] = "skipped";
        expect({ occasion, job, code: yield* runGreen(commandText, values, occasion) }).not.toEqual(
          {
            occasion,
            job,
            code: 0,
          },
        );
      }
    }
  });

  it("rejects failure and cancellation from every job, on every occasion", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));
    const rejected = ["failure", "cancelled", "timed_out", "neutral", "action_required"];

    for (const occasion of ["push", "pull-request", "repair"] as const) {
      for (const result of rejected) {
        expect(yield* runGreen(commandText, results(parsed, result), occasion)).not.toEqual(0);
      }
    }
  });

  /**
   * The matrix IDs by name. GitHub collapses a whole matrix into one result
   * behind the job ID, so this is what proves a red shard reaches `green` —
   * the derived checks above cannot tell a matrix from an ordinary job.
   */
  it("rejects any non-success from each runtime matrix, on every occasion", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));

    for (const occasion of OCCASIONS) {
      for (const job of ["test-deno", "test-node", "test-bun"]) {
        for (const result of ["failure", "cancelled", "skipped", "timed_out", "action_required"]) {
          const values = required(parsed, occasion);
          values[job] = result;
          expect({
            occasion,
            job,
            result,
            code: yield* runGreen(commandText, values, occasion),
          }).not.toEqual({ occasion, job, result, code: 0 });
        }
      }
    }
  });

  /** MG9: the gate is what an ordinary pull request offers in composability's place. */
  it("requires main-green to succeed on an ordinary pull request", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));

    for (const result of ["skipped", "failure", "cancelled"]) {
      const values = required(parsed, "pull-request");
      values["main-green"] = result;
      expect(yield* runGreen(commandText, values, "pull-request")).not.toEqual(0);
    }
  });

  /** MG10 and MG11: the repair path buys the lookup, never composability. */
  it("requires both main-green and composability on a repair pull request", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));

    for (const job of ["main-green", "composability"]) {
      for (const result of ["skipped", "failure", "cancelled"]) {
        const values = required(parsed, "repair");
        values[job] = result;
        expect({ job, result, code: yield* runGreen(commandText, values, "repair") }).not.toEqual({
          job,
          result,
          code: 0,
        });
      }
    }
  });

  /**
   * MG12: removing the label recomputes this check as an ordinary pull request,
   * where the same results no longer satisfy it — the repair path cannot survive
   * its own label.
   */
  it("stops accepting the repair shape once the label is gone", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));

    // A repair run that passed: composability ran, main-green was excused.
    const repaired = required(parsed, "repair");
    expect(yield* runGreen(commandText, repaired, "repair")).toEqual(0);

    // The same jobs, re-decided without the label, where composability being
    // skipped is now permitted and the gate's own result is not.
    const ordinary = required(parsed, "pull-request");
    ordinary["main-green"] = "skipped";
    expect(yield* runGreen(commandText, ordinary, "pull-request")).not.toEqual(0);
  });

  /** MG13: a push proves the base itself, so composability is not optional there. */
  it("requires composability on a main push and excuses main-green", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));

    for (const result of ["skipped", "failure", "cancelled"]) {
      const values = required(parsed, "push");
      values.composability = result;
      expect(yield* runGreen(commandText, values, "push")).not.toEqual(0);
    }

    const excused = required(parsed, "push");
    expect(yield* runGreen(commandText, excused, "push")).toEqual(0);
    // "May be skipped" is permission, not a requirement.
    excused["main-green"] = "success";
    expect(yield* runGreen(commandText, excused, "push")).toEqual(0);
  });

  it("decides from the event and the labels rather than from a job name alone", function* () {
    const step = green(yield* workflow()).steps[0];

    expect(step?.env?.EVENT).toEqual("${{ github.event_name }}");
    expect(step?.env?.REPAIR).toEqual(
      "${{ contains(github.event.pull_request.labels.*.name, 'ci-main-red-fix') }}",
    );
  });

  it("does not install dependencies", function* () {
    const aggregate = green(yield* workflow());
    const commandText = command(aggregate);

    expect(aggregate.steps.every((step) => step.uses === undefined)).toBe(true);
    expect(commandText).not.toContain("install");
  });
});

/**
 * CP12 — where correctness lives, now that composability no longer duplicates
 * it.
 *
 * The narrowed probe is only safe because every suite it stopped running still
 * runs somewhere that `green` requires. These read the workflow rather than
 * trusting the change that moved them.
 */
describe("the correctness jobs composability no longer duplicates", () => {
  /**
   * How each runtime's exhaustive corpus is invoked, as of #558's sharding.
   *
   * These are matched literally against the workflow and against
   * composability's own commands, so they have to be the real invocations: a
   * stale string here would make the negative assertions below pass by never
   * matching anything.
   */
  const RUNTIME_SUITES: Record<string, string> = {
    "test-deno": "scripts/runtime-tests.ts deno ${{ matrix.shard }}",
    "test-node": "pnpm test:node ${{ matrix.shard }}",
    "test-bun": "bun run test:bun ${{ matrix.shard }}",
  };

  function runs(job: Job): string {
    return job.steps.map((step) => step.run ?? "").join("\n");
  }

  it("still runs each complete runtime corpus once, in a job of its own", function* () {
    const jobs = yield* workflow();

    for (const [id, invocation] of Object.entries(RUNTIME_SUITES)) {
      const found = jobs[id];
      expect({ id, present: found !== undefined }).toEqual({ id, present: true });
      expect(runs(found!)).toContain(invocation);
      // Unconditional: a suite that can skip is a suite `green` cannot require.
      expect({ id, condition: found!.if }).toEqual({ id, condition: undefined });
    }
  });

  it("still requires every one of them, and composability, through green", function* () {
    const jobs = yield* workflow();
    const needs = green(jobs).needs ?? [];

    for (const id of [...Object.keys(RUNTIME_SUITES), "composability", "lint", "site"]) {
      expect(needs).toContain(id);
    }
  });

  it("keeps the site check and build in the site job and nowhere else", function* () {
    const jobs = yield* workflow();
    const site = jobs.site;

    expect(site).toBeDefined();
    expect(runs(site!)).toContain("deno task check");
    expect(runs(site!)).toContain("deno task build");
  });

  /**
   * The whole point of #546: composability runs one command, and that command
   * is not a battery. A runtime suite reappearing here is the regression.
   */
  it("runs one command in composability, and no suite among it", function* () {
    const jobs = yield* workflow();
    const composability = jobs.composability;

    expect(composability).toBeDefined();
    expect(runs(composability!)).toContain("deno task verify:clean");
    // Sharded or not, no runtime corpus may be invoked here by any spelling.
    for (const forbidden of Object.values(RUNTIME_SUITES)) {
      expect(runs(composability!)).not.toContain(forbidden);
    }
    for (const forbidden of [
      "runtime-tests.ts",
      "deno task test",
      "pnpm test:node",
      "bun run test:bun",
      "check:jsr",
      "xmd test",
      "working-directory: site",
    ]) {
      expect(runs(composability!)).not.toContain(forbidden);
    }
  });

  /** All three runtimes are installed because the probe consumes all three. */
  it("installs Deno, Node, pnpm and Bun for the probe", function* () {
    const jobs = yield* workflow();
    const uses = (jobs.composability?.steps ?? []).map((step) => step.uses ?? "").join("\n");

    for (const tool of ["setup-deno", "setup-node", "pnpm/action-setup", "setup-bun"]) {
      expect(uses).toContain(tool);
    }
  });
});

/**
 * CP1/CP13 — what `deno task verify` is, read from the task that defines it.
 *
 * The battery's site applicability and its per-suite deadlines were the two
 * things a caller could still reach for after the coordinator stopped having
 * them, so their absence is asserted where a caller would look.
 */
describe("the verify tasks", () => {
  function* tasks(): Operation<Record<string, string>> {
    const config = JSON.parse(yield* readTextFile(new URL("../../deno.json", import.meta.url)));
    return stringRecord(config.tasks, "deno.json tasks");
  }

  it("runs the probe through the preflight, offline and frozen", function* () {
    const verify = (yield* tasks()).verify ?? "";

    expect(verify).toContain("scripts/preflight.ts scripts/verify.ts");
    expect(verify).toContain("--cached-only");
    expect(verify).toContain("--frozen");
  });

  it("has no --no-site flag left to pass", function* () {
    const config = yield* readTextFile(new URL("../../deno.json", import.meta.url));
    const coordinator = yield* readTextFile(new URL("../lib/verify.ts", import.meta.url));
    const adapter = yield* readTextFile(new URL("../verify.ts", import.meta.url));

    for (const source of [config, coordinator, adapter]) {
      expect(source).not.toContain("--no-site");
    }
  });

  it("carries no per-suite deadline", function* () {
    const coordinator = yield* readTextFile(new URL("../lib/verify.ts", import.meta.url));

    for (const gone of ["TEST_TIMEOUT_MILLISECONDS", "RUNTIME_SUITE_TIMEOUT_MILLISECONDS"]) {
      expect(coordinator).not.toContain(gone);
    }
    expect(coordinator).toContain("PROBE_TIMEOUT_MILLISECONDS");
  });
});
