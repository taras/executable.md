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
import { mkdtempSync } from "node:fs";
import { chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The leaf tasks the README composes. The shim answers for exactly these. */
const LEAF_TASKS = ["setup", "build", "lint", "check", "check:jsr", "test", "verify"];

/**
 * The changed-test leaf as the shim sees it. The README redirects the report
 * away, and the shell consumes that redirection, so what reaches `deno` — and
 * the log — is the task and its flag alone.
 */
const CHANGED_TESTS = "test --changed=origin/main";

/**
 * A credential-shaped canary the shim prints when it answers the changed-test
 * leaf, assembled from fragments so no complete token-shaped literal is
 * committed. The real suite prints strings like it — fixtures for the secret
 * scanner — and journaling one fails a run, which is why the README discards
 * that report. If the redirection goes, this reaches the exec result and the
 * run is refused.
 */
const CANARY_PREFIX = ["gh", "p", "_"].join("");
const CANARY_BODY = `${"abcdefghijklmnopqrstuvwxyz"}${"0123456789"}`;

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
  '    if [ "$*" = "$XMD_FAIL_TASK" ]; then',
  "      exit 1",
  "    fi",
  "    # What a real test report carries: the scanner's own fixtures.",
  '    if [ "$*" = "$XMD_CANARY_TASK" ]; then',
  '      printf "%s%s\\n" "$XMD_CANARY_PREFIX" "$XMD_CANARY_BODY"',
  "    fi",
  "    exit 0",
  "    ;;",
  "  esac",
  "fi",
  'exec "$XMD_REAL_DENO" "$@"',
  "",
].join("\n");

interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
  /** Every leaf task the run asked for, in order, as written on the command line. */
  tasks: string[];
}

/**
 * Run `deno task <args>` in the repository, with the shim in front of `deno`.
 *
 * Everything the invocation owns — its directory, its shim, its log and its
 * environment — is created for it and removed with it, so nothing is shared
 * between cases and nothing is written into the repository.
 */
function* invoke(args: string[], options: { fail?: string } = {}): Operation<Invocation> {
  // @effectionx/fs has no mkdtemp. Creating the directory synchronously is
  // what lets its removal be registered with no interruption window between
  // the two.
  const base = mkdtempSync(path.join(os.tmpdir(), "xmd-readme-"));
  return yield* scoped(function* () {
    yield* ensure(() => rm(base, { recursive: true, force: true }));

    const bin = path.join(base, "bin");
    yield* ensureDir(bin);
    const shim = path.join(bin, "deno");
    yield* writeTextFile(shim, SHIM);
    // @effectionx/fs has no chmod, and a shim that is not executable is not one.
    yield* until(chmod(shim, 0o755));

    const log = path.join(base, "tasks.log");
    yield* writeTextFile(log, "");

    const result = yield* timebox(120_000, () =>
      exec(Deno.execPath(), {
        arguments: ["task", ...args],
        cwd: REPO,
        env: {
          ...Deno.env.toObject(),
          PATH: `${bin}${path.delimiter}${Deno.env.get("PATH") ?? ""}`,
          XMD_TASK_LOG: log,
          XMD_REAL_DENO: Deno.execPath(),
          XMD_FAIL_TASK: options.fail ?? "",
          XMD_CANARY_TASK: CHANGED_TESTS,
          XMD_CANARY_PREFIX: CANARY_PREFIX,
          XMD_CANARY_BODY: CANARY_BODY,
        },
      }).join(),
    );
    if (result.timeout) {
      throw new Error(`deno task ${args.join(" ")} did not finish`);
    }

    const recorded = yield* readTextFile(log);
    return {
      code: result.value.code ?? 1,
      stdout: result.value.stdout,
      stderr: result.value.stderr,
      tasks: recorded.split("\n").filter((line) => line.length > 0),
    };
  });
}

const SETUP = "setup";
const BUILD = "build";
const FOCUSED = ["lint", "check", "check:jsr", CHANGED_TESTS];
const VERIFY = "verify";

/** The executable hierarchy, in the order the document declares it. */
const DEVELOPMENT_TARGETS = [
  "README.md#Development",
  "README.md#Development/Setup",
  "README.md#Development/Build",
  "README.md#Development/Verification",
  "README.md#Development/Verification/Focused",
  "README.md#Development/Verification/Complete",
];

describe("Tier RM — README dogfood", () => {
  it("RM1: the development hierarchy is addressable, once each, in source order", function* () {
    const listed = yield* invoke(["xmd", "targets", "README.md"]);
    expect(listed.code).toBe(0);

    const lines = listed.stdout.split("\n").filter((line) => line.length > 0);

    // Exactly these, once each, in source order. A prose heading beneath
    // `## Development` would inherit its direct content, so selecting that
    // prose would run setup — this assertion is what refuses that.
    expect(lines.filter((line) => line.includes("#Development"))).toEqual(DEVELOPMENT_TARGETS);

    // Documentation that belongs beside the hierarchy rather than inside it
    // stays addressable as a top-level section.
    expect(lines).toContain("README.md#Implementation%20feedback");
    expect(lines).toContain("README.md#Dependency%20layout");

    // The root `<Output />` declares a policy, not a region: every other
    // heading in the document is still addressable beside it.
    expect(lines).toContain("README.md#Install");
    expect(lines).toContain("README.md#Status");
    // Discovery runs nothing.
    expect(listed.tasks).toEqual([]);
  });

  it("RM2: Setup runs setup and nothing else", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Development/Setup", "--raw"]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP]);
  });

  it("RM3: Build inherits setup and adds the build", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Development/Build", "--raw"]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, BUILD]);
  });

  it("RM4: Focused inherits setup and runs the short battery in order", function* () {
    const run = yield* invoke([
      "xmd",
      "run",
      "README.md#Development/Verification/Focused",
      "--raw",
    ]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, ...FOCUSED]);
    expect(run.tasks).not.toContain(BUILD);
    expect(run.tasks).not.toContain(VERIFY);
  });

  it("RM5: Complete inherits setup and runs the whole battery", function* () {
    const run = yield* invoke([
      "xmd",
      "run",
      "README.md#Development/Verification/Complete",
      "--raw",
    ]);
    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, VERIFY]);
  });

  it("RM6: the Verification parent runs both batteries beneath it", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Development/Verification", "--raw"]);
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
    const direct = yield* invoke([
      "xmd",
      "run",
      "README.md#Development/Verification/Focused",
      "--raw",
    ]);
    expect(shorthand.code).toBe(0);
    expect(shorthand.tasks).toEqual(direct.tasks);
    expect(shorthand.tasks).toEqual([SETUP, ...FOCUSED]);
  });

  it("RM9: a failed task stops the document and fails the run", function* () {
    const run = yield* invoke(
      ["xmd", "run", "README.md#Development/Verification/Focused", "--raw"],
      { fail: "check" },
    );

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
   * `xmd test` executes a document while it looks for `<Test>` regions, so this
   * README runs before it reports that it holds none. That is a consequence of
   * making it executable, and it is recorded here rather than designed around:
   * nothing makes these blocks conditional on the command.
   *
   * It cannot recurse here, and it could not recurse in a real run either — the
   * leaf that would re-enter this document is answered by the invocation's own
   * shim.
   */
  it("RM11: xmd test runs the document too, then reports no tests", function* () {
    const run = yield* invoke(["xmd", "test", "README.md"]);

    expect(run.tasks).toEqual([SETUP, BUILD, ...FOCUSED, VERIFY]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no tests were discovered");
  });

  /**
   * The changed-test report is discarded by the README's own redirection, not
   * by turning the scanner off. The canary the shim prints for that leaf is
   * what a real report carries — a fixture shaped like a credential — and a
   * journaled one is refused, so a run that succeeds proves the report never
   * reached the exec result.
   */
  it("RM12: the entry point succeeds with secret detection still enabled", function* () {
    const run = yield* invoke(["verify:focused"]);

    expect(run.code).toBe(0);
    expect(run.tasks).toEqual([SETUP, ...FOCUSED]);
    expect(run.stderr).not.toContain("secret detection rejected");
    // No substitution of --no-secret-detection: the CLI announces that opt-out.
    expect(run.stderr).not.toContain("secret detection is disabled");
  });

  it("RM10: a target that succeeds renders nothing and says so with its status", function* () {
    const run = yield* invoke(["xmd", "run", "README.md#Development/Build", "--raw"]);
    expect(run.code).toBe(0);
    // `silent` blocks under a root that declares `<Output />`: the exit status
    // is the result, and no section text is emitted around them.
    expect(run.stdout).toBe("");
  });
});
