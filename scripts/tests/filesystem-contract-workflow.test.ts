/**
 * The five-target filesystem contract job, held to the release matrix.
 *
 * The claim `xmd run` makes about containment is per-platform: path arithmetic
 * and `realpath` are the host's, and Windows brings drive letters, UNC paths,
 * junctions, and reparse points that POSIX does not. A job that covered four of
 * the five triples would leave the fifth's claim asserted and unproven, and
 * nothing about adding a release target would notice.
 *
 * So the matrix is held to `RELEASE_TARGETS` by set equality, the same way
 * `publish-workflow-membership.test.ts` holds the release workflow. Adding a
 * target without adding a row fails here.
 */

import matter from "gray-matter";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";
import { RELEASE_TARGETS } from "../lib/release-targets.ts";

const CI_WORKFLOW = new URL("../../.github/workflows/ci.yml", import.meta.url);
const JOB = "filesystem-contract";
const PROBE = "scripts/files-contract-probe.ts";
const SUITE = "packages/runtime/tests/host-files.test.ts";

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

interface Row {
  runner: string;
  target: string;
}

interface ContractJob {
  runsOn: string;
  rows: Row[];
  commands: string[];
}

function* job(): Operation<ContractJob> {
  const source = yield* readTextFile(CI_WORKFLOW);
  const document = object(matter(`---\n${source}\n---`).data, "workflow");
  const jobs = object(document.jobs, "workflow.jobs");
  const contract = object(jobs[JOB], `workflow.jobs.${JOB}`);
  const strategy = object(contract.strategy, `${JOB}.strategy`);
  const matrix = object(strategy.matrix, `${JOB}.strategy.matrix`);
  const include = matrix.include;
  if (!Array.isArray(include)) {
    throw new Error(`${JOB}.strategy.matrix.include is not an array`);
  }
  const steps = contract.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${JOB}.steps is not an array`);
  }

  return {
    runsOn: string(contract["runs-on"], `${JOB}.runs-on`),
    rows: include.map((entry, index) => {
      const row = object(entry, `${JOB}.strategy.matrix.include[${index}]`);
      return {
        runner: string(row.runner, `include[${index}].runner`),
        target: string(row.target, `include[${index}].target`),
      };
    }),
    commands: steps.flatMap((entry, index) => {
      const step = object(entry, `${JOB}.steps[${index}]`);
      return "run" in step ? [string(step.run, `${JOB}.steps[${index}].run`)] : [];
    }),
  };
}

describe("the filesystem contract matrix", () => {
  it("covers exactly the release targets", function* () {
    const contract = yield* job();
    expect([...contract.rows.map((row) => row.target)].sort()).toEqual(
      Object.keys(RELEASE_TARGETS).sort(),
    );
  });

  it("gives every target its own runner", function* () {
    const contract = yield* job();
    const runners = contract.rows.map((row) => row.runner);
    expect(new Set(runners).size).toEqual(runners.length);
    expect(contract.runsOn).toEqual("${{ matrix.runner }}");
  });

  it("names a runner whose platform matches its target", function* () {
    const platforms: Record<string, { os: string; arch: string }> = {
      "macos-15": { os: "darwin", arch: "arm64" },
      "macos-15-intel": { os: "darwin", arch: "x64" },
      "ubuntu-24.04": { os: "linux", arch: "x64" },
      "ubuntu-24.04-arm": { os: "linux", arch: "arm64" },
      "windows-2025": { os: "win32", arch: "x64" },
    };

    const contract = yield* job();
    for (const row of contract.rows) {
      const runner = platforms[row.runner];
      if (runner === undefined) {
        throw new Error(`no platform recorded for runner "${row.runner}"`);
      }
      expect(runner).toEqual(RELEASE_TARGETS[row.target]);
    }
  });

  // Every row must run all four: the source suite under each runtime the
  // project ships, and the compiled probe. A row that only ran one of them
  // would report "the contract holds" for a shape it never executed.
  it("runs the contract under Deno, Node, Bun, and a compiled binary", function* () {
    const commands = (yield* job()).commands.join("\n");

    expect(commands).toContain(`deno test --allow-all --frozen ${SUITE}`);
    expect(commands).toContain(`tsx --tsconfig tsconfig.node.json --test ${SUITE}`);
    expect(commands).toContain(`bun test --timeout=300000 ${SUITE}`);
    expect(commands).toContain(`deno compile`);
    expect(commands).toContain(PROBE);
  });

  // The Deno steps come before either package manager's install, because each
  // rewrites `node_modules` into its own layout and a Deno run afterwards
  // resolves through links the other pruned (#279).
  it("runs every Deno step before a package manager rewrites node_modules", function* () {
    const commands = (yield* job()).commands;
    const lastDeno = commands.findLastIndex((command) => command.includes("deno "));
    const firstInstall = commands.findIndex(
      (command) => command.trim() === "pnpm install" || command.trim() === "bun install",
    );

    expect(lastDeno).toBeGreaterThan(-1);
    expect(firstInstall).toBeGreaterThan(lastDeno);
  });

  it("does not duplicate the whole corpus on every row", function* () {
    const commands = (yield* job()).commands.join("\n");

    expect(commands).not.toContain("deno task test\n");
    expect(commands).not.toContain("pnpm test:node");
    expect(commands).not.toContain("bun run test:bun");
  });
});
