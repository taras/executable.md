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
