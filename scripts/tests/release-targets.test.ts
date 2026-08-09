import matter from "gray-matter";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";

import {
  preparationArguments,
  RELEASE_ENTRYPOINT,
  RELEASE_TARGET,
  RELEASE_TARGETS,
} from "../lib/release-targets.ts";

const RELEASE_WORKFLOW = new URL("../../.github/workflows/release.yml", import.meta.url);

/** The reviewed immutable commit for `actions/attest` v4.2.2. */
const ATTEST_ACTION = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";

/**
 * `release.yml` keeps the list GitHub fans out over; this module keeps the
 * flags each of those targets prepares with. Neither is generated from the
 * other, so the two have to be held equal by test — a target added to one alone
 * is either a job that cannot prepare or a mapping nothing uses.
 */
function* matrixTargets(): Operation<string[]> {
  const workflow = yield* readTextFile(RELEASE_WORKFLOW);
  return [...workflow.matchAll(/^\s+- target:\s*(\S+)/gm)].map((match) => match[1] ?? "");
}

/** Executable lines only: a comment naming a command runs nothing. */
function* commands(): Operation<string[]> {
  return (yield* readTextFile(RELEASE_WORKFLOW))
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"));
}

interface Step {
  continueOnError?: boolean;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string;
  steps: Step[];
}

interface Workflow {
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
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

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is not a boolean`);
  }
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value, label)).map(([key, entry]) => [
      key,
      string(entry, `${label}.${key}`),
    ]),
  );
}

function steps(value: unknown, label: string): Step[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value.map((entry, index) => {
    const step = object(entry, `${label}[${index}]`);
    return {
      continueOnError:
        "continue-on-error" in step
          ? boolean(step["continue-on-error"], `${label}[${index}].continue-on-error`)
          : undefined,
      if: "if" in step ? string(step.if, `${label}[${index}].if`) : undefined,
      run: "run" in step ? string(step.run, `${label}[${index}].run`) : undefined,
      uses: "uses" in step ? string(step.uses, `${label}[${index}].uses`) : undefined,
      with: "with" in step ? object(step.with, `${label}[${index}].with`) : undefined,
    };
  });
}

function job(value: unknown, label: string): Job {
  const record = object(value, label);
  return {
    needs: "needs" in record ? string(record.needs, `${label}.needs`) : undefined,
    steps: steps(record.steps, `${label}.steps`),
  };
}

/**
 * The workflow read as YAML rather than as text: an assertion over the parsed
 * steps cannot be satisfied by a comment or by prose that happens to name the
 * action.
 */
function* releaseWorkflow(): Operation<Workflow> {
  const source = yield* readTextFile(RELEASE_WORKFLOW);
  const document = object(matter(`---\n${source}\n---`).data, "release.yml");
  const jobs = object(document.jobs, "release.yml.jobs");
  return {
    permissions: stringRecord(document.permissions, "release.yml.permissions"),
    jobs: Object.fromEntries(
      Object.entries(jobs).map(([id, value]) => [id, job(value, `release.yml.jobs.${id}`)]),
    ),
  };
}

function jobOf(workflow: Workflow, id: string): Job {
  const found = workflow.jobs[id];
  if (found === undefined) {
    throw new Error(`release.yml.jobs.${id} is missing`);
  }
  return found;
}

function attestations(job: Job): Step[] {
  return job.steps.filter((step) => step.uses?.startsWith("actions/attest@") === true);
}

describe("the release matrix and its mapping", () => {
  it("map exactly onto each other", function* () {
    expect([...(yield* matrixTargets())].sort()).toEqual(Object.keys(RELEASE_TARGETS).sort());
  });

  it("is not vacuous", function* () {
    expect((yield* matrixTargets()).length).toBe(5);
  });

  it("compiles its representative target as one of the matrix members", function* () {
    expect(yield* matrixTargets()).toContain(RELEASE_TARGET);
  });
});

describe("preparationArguments", () => {
  /** The mapping the ruling fixed, read back through the argv it produces. */
  it("carries each target's os and arch", function* () {
    const mapped = Object.keys(RELEASE_TARGETS).map((target) => {
      const argv = preparationArguments(target);
      return `${target} ${argv[argv.indexOf("--os") + 1]}/${argv[argv.indexOf("--arch") + 1]}`;
    });

    expect(mapped).toEqual([
      "aarch64-apple-darwin darwin/arm64",
      "x86_64-apple-darwin darwin/x64",
      "x86_64-unknown-linux-gnu linux/x64",
      "aarch64-unknown-linux-gnu linux/arm64",
      "x86_64-pc-windows-msvc win32/x64",
    ]);
  });

  it("prepares exactly, and in full", function* () {
    expect(preparationArguments("x86_64-pc-windows-msvc")).toEqual([
      "install",
      "--entrypoint",
      "--node-modules-dir=none",
      "--frozen",
      "--os",
      "win32",
      "--arch",
      "x64",
      RELEASE_ENTRYPOINT,
    ]);
  });

  /**
   * The isolation, per target: preparation adds to the Deno cache and leaves the
   * host `node_modules` alone. `verify:clean` proves it empirically; this fails
   * the moment the flag is dropped.
   */
  it("never manages node_modules, for any target", function* () {
    for (const target of Object.keys(RELEASE_TARGETS)) {
      expect(preparationArguments(target)).toContain("--node-modules-dir=none");
      expect(preparationArguments(target)).toContain("--frozen");
    }
  });

  it("refuses an unknown target by naming the ones it knows", function* () {
    let failure: unknown;
    try {
      preparationArguments("sparc-sun-solaris");
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("unknown release target");
    for (const target of Object.keys(RELEASE_TARGETS)) {
      expect(String(failure)).toContain(target);
    }
  });
});

describe("release.yml", () => {
  it("prepares each target through the same entry point the mapping backs", function* () {
    expect((yield* commands()).join("\n")).toContain("deno task deps:target ${{ matrix.target }}");
  });

  /**
   * Ordering inside the build job, not merely somewhere in the file: a
   * preparation step that landed in `preflight` would leave every compile
   * reaching for packages it does not have.
   */
  it("prepares before it compiles, inside the job that compiles", function* () {
    const job =
      (yield* commands())
        .join("\n")
        .split(/^  \w[\w-]*:$/m)
        .find((section) => section.includes("deno compile")) ?? "";

    const prepare = job.indexOf("deno task deps:target");
    const compile = job.indexOf("deno compile");

    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(compile);
  });

  it("compiles for the matrix target under the isolation flags", function* () {
    const invocation = (yield* commands()).join("\n");
    const compile = invocation.slice(invocation.indexOf("deno compile"));
    const flags = compile.slice(0, compile.indexOf(RELEASE_ENTRYPOINT));

    for (const flag of ["--node-modules-dir=none", "--cached-only", "--frozen", "--target"]) {
      expect({ flag, present: flags.includes(flag) }).toEqual({ flag, present: true });
    }
  });
});

/**
 * GitHub holds build provenance for each released binary, and the workflow is
 * the only place that says so. The five subjects come from one shared matrix
 * step, so the exact-five assertion above is what proves every platform is
 * covered.
 */
describe("release.yml binary attestation", () => {
  it("grants the scopes an attestation is minted and published with", function* () {
    const { permissions } = yield* releaseWorkflow();

    for (const scope of ["contents", "id-token", "attestations"]) {
      expect({ scope, granted: permissions[scope] }).toEqual({ scope, granted: "write" });
    }
  });

  it("attests once for the whole matrix, at the reviewed pin", function* () {
    const attested = attestations(jobOf(yield* releaseWorkflow(), "build"));

    expect(attested.length).toBe(1);
    expect(attested[0]?.uses).toEqual(ATTEST_ACTION);
  });

  /**
   * Exact inputs, not merely the presence of the subject: the default mode
   * signs SLSA build provenance and publishes it to GitHub's attestation API,
   * which a registry push, a renamed subject, or a custom predicate would
   * silently replace.
   */
  it("attests the file the matrix job compiled, and configures nothing else", function* () {
    const [attest] = attestations(jobOf(yield* releaseWorkflow(), "build"));

    expect(stringRecord(attest?.with, "attestation.with")).toEqual({
      "subject-path": "dist/${{ matrix.artifact }}",
    });
  });

  it("cannot be softened into a warning", function* () {
    const [attest] = attestations(jobOf(yield* releaseWorkflow(), "build"));

    expect(attest?.if).toBeUndefined();
    expect(attest?.continueOnError).not.toBe(true);
  });

  /**
   * Placement is the whole guarantee: before the compile there are no bytes to
   * attest, and after the upload an unattested binary is already in the set
   * `release` downloads.
   */
  it("attests after the compile and before the upload", function* () {
    const build = jobOf(yield* releaseWorkflow(), "build");
    const compile = build.steps.findIndex((step) => step.run?.includes("deno compile") === true);
    const attest = build.steps.findIndex(
      (step) => step.uses?.startsWith("actions/attest@") === true,
    );
    const upload = build.steps.findIndex(
      (step) => step.uses?.startsWith("actions/upload-artifact@") === true,
    );

    expect(compile).toBeGreaterThan(-1);
    expect(attest).toBeGreaterThan(compile);
    expect(upload).toBeGreaterThan(attest);
  });

  it("publishes no binary once an attestation has failed", function* () {
    expect(jobOf(yield* releaseWorkflow(), "release").needs).toEqual("build");
  });
});
