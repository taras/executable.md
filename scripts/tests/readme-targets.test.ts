/**
 * Tier RM — README dogfood (issue #414).
 *
 * The repository's own `README.md`, executed through the source CLI, is the
 * subject: these cases run the committed document rather than a fixture, so
 * they fail when the README's hierarchy or its commands drift.
 *
 * Nothing here installs, builds, or verifies anything. The invocation gets a
 * temporary `PATH` whose `deno` records the leaf tasks it is asked to run and
 * answers success — or, for one case, failure — without doing their work. It
 * delegates everything else, including the source-CLI bootstrap, back to the
 * exact executable running this test, so the CLI, the document, and the
 * projection are all real. The outer command is that executable directly, never
 * the shim.
 *
 * What each case reads is the recorded argv, not rendered text: which commands
 * ran, in which order, is the whole question.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The leaf tasks the README composes. The shim answers for exactly these. */
const LEAF_TASKS = ["setup", "build", "lint", "check", "check:jsr", "test", "verify"];

/** The changed-test leaf, as the shim sees it on the command line. */
const CHANGED_TESTS = "test --changed=origin/main";

/**
 * What the shim prints on stdout for each leaf it answers.
 *
 * A real task writes to the terminal while it runs, and that is the thing these
 * blocks exist to let a contributor watch. The marker stands in for it, so a
 * case can ask where that output went and how often.
 */
function marker(task: string): string {
  return `xmd-ran:${task}`;
}

const SHIM = [
  "#!/usr/bin/env bash",
  "# Answers for the repository's leaf tasks and delegates everything else —",
  "# `deno task xmd …`, `deno task verify:focused`, and the `deno run` that",
  "# bootstraps the CLI — to the executable that launched the test.",
  'if [ "$1" = "task" ]; then',
  '  case "$2" in',
  `  ${LEAF_TASKS.join("|")})`,
  "    shift",
  '    printf "%s\\n" "$*" >> "$XMD_TASK_LOG"',
  "    # What a real task writes while it runs.",
  '    printf "%s%s\\n" "$XMD_MARKER_PREFIX" "$*"',
  '    if [ "$*" = "$XMD_FAIL_TASK" ]; then',
  "      exit 1",
  "    fi",
  "    exit 0",
  "    ;;",
  "  esac",
  "fi",
  'exec "$XMD_REAL_DENO" "$@"',
  "",
].join("\n");

/**
 * Answers for `npm` and records every invocation.
 *
 * `#Bootstrap` is the one target that can reach a public registry, so the cases
 * below need to see whether it did. The version it reports is below the floor
 * the document requires, so a run that does reach npm refuses at the first
 * question and asks the registry nothing.
 */
const NPM_SHIM = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "$XMD_NPM_LOG"',
  'if [ "$1" = "--version" ]; then echo "11.0.0"; exit 0; fi',
  'if [ "$1" = "whoami" ]; then echo "shim-user"; exit 0; fi',
  "exit 1",
  "",
].join("\n");

interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
  /** Every leaf task the run asked for, in order, as written on the command line. */
  tasks: string[];
  /** Every `npm` invocation the run made, in order. */
  npmCalls: string[];
}

/**
 * Run `deno task <args>` in the repository, with the shim in front of `deno`.
 *
 * Everything the invocation owns — its directory, its shim, its log and its
 * environment — is created for it and removed with it, so nothing is shared
 * between cases and nothing is written into the repository.
 */
function* invoke(args: string[], options: { fail?: string } = {}): Operation<Invocation> {
  return yield* scoped(function* () {
    const base = yield* useTempDirectory("xmd-readme-");

    const bin = path.join(base, "bin");
    yield* ensureDir(bin);
    const shim = path.join(bin, "deno");
    yield* writeTextFile(shim, SHIM);
    // @effectionx/fs has no chmod, and a shim that is not executable is not one.
    yield* until(chmod(shim, 0o755));

    const npmShim = path.join(bin, "npm");
    yield* writeTextFile(npmShim, NPM_SHIM);
    yield* until(chmod(npmShim, 0o755));

    const log = path.join(base, "tasks.log");
    yield* writeTextFile(log, "");
    const npmLog = path.join(base, "npm.log");
    yield* writeTextFile(npmLog, "");

    const result = yield* timebox(120_000, () =>
      exec(Deno.execPath(), {
        arguments: ["task", ...args],
        cwd: REPO,
        env: {
          ...Deno.env.toObject(),
          PATH: `${bin}${path.delimiter}${Deno.env.get("PATH") ?? ""}`,
          XMD_TASK_LOG: log,
          XMD_NPM_LOG: npmLog,
          XMD_REAL_DENO: Deno.execPath(),
          XMD_FAIL_TASK: options.fail ?? "",
          XMD_MARKER_PREFIX: marker(""),
        },
      }).join(),
    );
    if (result.timeout) {
      throw new Error(`deno task ${args.join(" ")} did not finish`);
    }

    const recorded = yield* readTextFile(log);
    const npmRecorded = yield* readTextFile(npmLog);
    return {
      code: result.value.code ?? 1,
      stdout: result.value.stdout,
      stderr: result.value.stderr,
      tasks: recorded.split("\n").filter((line) => line.length > 0),
      npmCalls: npmRecorded.split("\n").filter((line) => line.length > 0),
    };
  });
}

const SETUP = "setup";
const BUILD = "build";
const FOCUSED = ["lint", "check", "check:jsr", CHANGED_TESTS];
const VERIFY = "verify";

/** The executable hierarchy, in the order the document declares it. */
const TARGETS = [
  "README.md#Setup",
  "README.md#Build",
  "README.md#Test",
  "README.md#Test/Focused",
  "README.md#Test/Complete",
  "README.md#Bootstrap",
];

describe("Tier RM — README dogfood", () => {
  it("RM1: the document describes the developer path, once each, in source order", function* () {
    const listed = yield* invoke(["xmd", "run", "README.md", "--help"]);
    expect(listed.code).toBe(0);

    const section = listed.stdout.slice(listed.stdout.indexOf("Targets in README.md"));
    expect(section.length).toBeGreaterThan(0);
    const rows = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("README.md#"));

    // The whole catalog, exactly. This is a development guide, so what it
    // addresses is what a developer runs and nothing else — a section that
    // drifted back into product documentation, or a prose heading that would
    // inherit the preamble's setup, shows up here as an extra row.
    expect(rows).toEqual(TARGETS);

    // Every target says what selecting it does. A section whose first block
    // stopped being static prose loses its description and fails here.
    for (const target of TARGETS) {
      const at = section.indexOf(`  ${target}\n`);
      const [, described = ""] = section.slice(at).split("\n");
      expect({ target, described: described.trim().length > 0 }).toEqual({
        target,
        described: true,
      });
    }

    // Describing runs nothing.
    expect(listed.tasks).toEqual([]);
    expect(listed.npmCalls).toEqual([]);
  });

  it("RM2: Setup runs setup and nothing else", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Setup", "--raw"]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP]);
  });

  it("RM3: Build inherits setup and adds the build", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Build", "--raw"]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, BUILD]);
  });

  it("RM4: Focused inherits setup and runs the short battery in order", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Test/Focused", "--raw"]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, ...FOCUSED]);
    expect(run.tasks).not.toContain(BUILD);
    expect(run.tasks).not.toContain(VERIFY);
  });

  it("RM5: Complete inherits setup and runs the whole battery", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Test/Complete", "--raw"]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, VERIFY]);
  });

  it("RM6: the Test parent runs both levels beneath it", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Test", "--raw"]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, ...FOCUSED, VERIFY]);
  });

  it("RM7: the whole document runs preparation, the build and verification, once each", function* () {
    const run = yield* invoke(["xmd", "run", "README.md", "--raw"]);
    expect(run.code).toBe(0);
    // Source order, and nothing twice: every other executable-looking fence in
    // this README is an ordinary example and stays passive.
    expect(run.tasks).toEqual([SETUP, BUILD, ...FOCUSED, VERIFY]);
  });

  it("RM8: deno task verify:focused enters the same target, with no cycle", function* () {
    const shorthand = yield* invoke(["verify:focused"]);
    const direct = yield* invoke(["xmd", "run", "README.md#Test/Focused", "--raw"]);
    expect(shorthand.code).toBe(0);
    expect(shorthand.tasks).toEqual(direct.tasks);
    expect(shorthand.tasks).toEqual([SETUP, ...FOCUSED]);
  });

  it("RM9: a failed task stops the document and fails the run", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Test/Focused", "--raw"], { fail: "check" });

    expect(run.code).toBe(1);
    // It stopped where it failed: check:jsr, the tests and verify never ran.
    expect(run.tasks).toEqual([SETUP, "lint", "check"]);
    expect(run.stderr).toContain("Command failed");
  });

  it("RM9a: a failed task stops the whole document too, before its later sections", function* () {
    const run = yield* invoke(["xmd", "run", "README.md", "--raw"], { fail: "build" });

    expect(run.code).toBe(1);
    expect(run.tasks).toEqual([SETUP, BUILD]);
  });

  /**
   * The point of running a build or a test suite is watching it, so what a
   * command writes has to reach the reader — once. A block that forwarded a
   * chunk live and then rendered the same text into the document at completion
   * would show every line twice, which is the defect this counts.
   */
  it("RM10: each command's output reaches the reader live, exactly once", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Build", "--raw"]);
    expect(run.code).toBe(0);

    expect(occurrences(run.stdout, marker(SETUP))).toBe(1);
    expect(occurrences(run.stdout, marker(BUILD))).toBe(1);
    // In the order the document runs them: the ancestor's preparation, then the
    // leaf's own command.
    expect(run.stdout.indexOf(marker(SETUP))).toBeLessThan(run.stdout.indexOf(marker(BUILD)));
    // Beside the section's own prose, which is what `--raw` renders.
    expect(run.stdout).toContain("Compile the standalone");
    // And nothing from a sibling the target did not select.
    expect(run.stdout).not.toContain(marker(VERIFY));
  });

  it("RM11: Bootstrap names no package by default, and reaches no registry", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Bootstrap", "--raw"]);

    // The whole point of the default: every other target composes into
    // `xmd run README.md`, and this one publishes to a public registry. Naming
    // nothing has to mean doing nothing, not doing it to an unnamed package.
    expect(run.code).toBe(0);
    expect(run.npmCalls).toEqual([]);
    expect(run.stdout).toContain("No package was named");
  });

  it("RM12: Bootstrap runs the reservation for the package it is given", function* () {
    const run = yield* invoke([
      "xmd",
      "run",
      "README.md#Bootstrap",
      "--props-package",
      "packages/workflow",
      "--raw",
    ]);

    // The control for RM11: the guard is what keeps npm out, not an absent
    // wiring. Naming a package reaches npm, and the shim's version is below the
    // floor, so it refuses there — before it asks the registry anything.
    expect(run.npmCalls).toContain("--version");
    expect(run.code).toBe(1);
    // The refusal is the run's own failure, so it is reported once as a
    // diagnostic rather than rendered into the document.
    expect(run.stderr).toContain("npm trust needs npm 11.15 or newer");
  });
});

/** How many times `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
