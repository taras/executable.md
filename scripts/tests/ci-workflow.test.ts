import matter from "gray-matter";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";

const CI_WORKFLOW = new URL("../../.github/workflows/ci.yml", import.meta.url);

interface Step {
  env?: Record<string, string>;
  run?: string;
  uses?: string;
}

interface Job {
  if?: string;
  name?: string;
  needs?: string[];
  steps: Step[];
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
      run: "run" in step ? string(step.run, `${label}[${index}].run`) : undefined,
      uses: "uses" in step ? string(step.uses, `${label}[${index}].uses`) : undefined,
    };
  });
}

function job(value: unknown, label: string): Job {
  const record = object(value, label);
  return {
    if: "if" in record ? string(record.if, `${label}.if`) : undefined,
    name: "name" in record ? string(record.name, `${label}.name`) : undefined,
    needs: "needs" in record ? strings(record.needs, `${label}.needs`) : undefined,
    steps: steps(record.steps, `${label}.steps`),
  };
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
