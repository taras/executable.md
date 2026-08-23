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
import { fileURLToPath } from "node:url";

import { PROVENANCE_VARIABLES, weightsFile } from "../lib/test-weights.ts";
import { BATTERY } from "../lib/verify.ts";

const ROOT = new URL("../../", import.meta.url);
const WORKFLOW = new URL(".github/workflows/measure-test-weights.yml", ROOT);
const CI_WORKFLOW = new URL(".github/workflows/ci.yml", ROOT);

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env: Record<string, string>;
  with: Record<string, string>;
}

interface Job {
  steps: Step[];
  permissions?: Record<string, string>;
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
      env: "env" in step ? strings(step.env, `${label}[${index}].env`) : {},
      with: "with" in step ? strings(step.with, `${label}[${index}].with`) : {},
    };
  });
}

function* document(path: URL): Operation<Record<string, unknown>> {
  return object(matter(`---\n${yield* readTextFile(path)}\n---`).data, "workflow");
}

function* measurement(): Operation<{ workflow: Record<string, unknown>; job: Job }> {
  const workflow = yield* document(WORKFLOW);
  const jobs = object(workflow.jobs, "workflow.jobs");
  const entry = Object.entries(jobs)[0];
  if (entry === undefined) {
    throw new Error("the measurement workflow defines no job");
  }
  const job = object(entry[1], `workflow.jobs.${entry[0]}`);
  return {
    workflow,
    job: {
      steps: steps(job.steps, `workflow.jobs.${entry[0]}.steps`),
      permissions:
        "permissions" in job
          ? strings(job.permissions, `workflow.jobs.${entry[0]}.permissions`)
          : undefined,
    },
  };
}

/** `deno task weights:measure` with an environment of the test's choosing. */
function* measure(
  provenance: Record<string, string>,
): Operation<{ code?: number; stderr: string }> {
  const result = yield* exec(Deno.execPath(), {
    arguments: ["task", "weights:measure"],
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

describe("the measurement command", () => {
  it("refuses an empty environment before running a single test", function* () {
    expect(yield* exists(weightsFile(ROOT))).toBe(false);

    const { code, stderr } = yield* measure({});

    expect(code).toEqual(1);
    for (const variable of Object.values(PROVENANCE_VARIABLES)) {
      expect(stderr).toContain(variable);
    }
    expect(stderr).not.toContain(FIRST_LAUNCH);
    expect(yield* exists(weightsFile(ROOT))).toBe(false);
  });

  it("names the one value it is missing", function* () {
    const { code, stderr } = yield* measure({ ...COMPLETE, WEIGHTS_BUN: "" });

    expect(code).toEqual(1);
    expect(stderr).toContain("WEIGHTS_BUN");
    expect(stderr).not.toContain(FIRST_LAUNCH);
    expect(yield* exists(weightsFile(ROOT))).toBe(false);
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

    // And no ordinary check reaches it: the battery is what `deno task verify`
    // runs, and a weights refresh inside it would rewrite tracked data on every
    // verification.
    for (const command of BATTERY) {
      expect(command.args.join(" ")).not.toContain("weights");
    }
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
    const { job } = yield* measurement();
    const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
    if (upload === undefined) {
      throw new Error("no step uploads the measurement");
    }

    expect(upload.with.path).toEqual("test-weights.json");
    expect(upload.with["if-no-files-found"]).toEqual("error");
  });
});
