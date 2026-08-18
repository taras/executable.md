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

function* runGreen(
  commandText: string,
  values: Record<string, string>,
): Operation<number | undefined> {
  const result = yield* exec("/bin/bash", {
    arguments: ["-c", commandText],
    env: {
      PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      RESULTS: JSON.stringify(
        Object.fromEntries(Object.entries(values).map(([key, result]) => [key, { result }])),
      ),
    },
  }).join();
  return result.code;
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

describe("the CI workflow aggregate", () => {
  it("defines green", function* () {
    expect(green(yield* workflow())).toBeDefined();
  });

  it("requires every other job and no future job can be omitted", function* () {
    const parsed = yield* workflow();
    expect(needsOf(green(parsed))).toEqual(allDependencies(parsed));
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

  it("accepts only success and skipped", function* () {
    const parsed = yield* workflow();
    const commandText = command(green(parsed));
    const accepted = ["success", "skipped"];
    const rejected = ["failure", "cancelled", "timed_out", "neutral", "action_required"];

    expect(commandText).toContain('.value.result != "success"');
    expect(commandText).toContain('.value.result != "skipped"');
    for (const result of accepted) {
      expect(yield* runGreen(commandText, results(parsed, result))).toEqual(0);
    }
    const pullRequestResults = results(parsed, "success");
    pullRequestResults.composability = "skipped";
    expect(yield* runGreen(commandText, pullRequestResults)).toEqual(0);
    for (const result of rejected) {
      expect(yield* runGreen(commandText, results(parsed, result))).not.toEqual(0);
    }
  });

  it("does not install dependencies", function* () {
    const aggregate = green(yield* workflow());
    const commandText = command(aggregate);

    expect(aggregate.steps.every((step) => step.uses === undefined)).toBe(true);
    expect(commandText).not.toContain("install");
  });
});
