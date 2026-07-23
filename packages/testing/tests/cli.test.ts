/**
 * CLI integration tests for `xmd test` and `xmd run` (specs/testing-spec.md).
 *
 * Shells out to `deno run --allow-all packages/cli/src/cli.ts` with piped stdio, so
 * exit codes and report output are asserted TTY-independently.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { timebox } from "@effectionx/timebox";
import { spawn, each } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import process from "node:process";

const TIMEOUT = 30_000;

interface CliResult {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function* runCli(args: string[]): Operation<CliResult> {
  const result = yield* timebox<CliResult>(TIMEOUT, function* () {
    const proc = yield* exec("deno", {
      arguments: ["run", "--allow-all", "packages/cli/src/cli.ts", ...args],
      env: cliEnv(),
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const readStdout = yield* spawn(function* () {
      for (const chunk of yield* each(proc.stdout)) {
        stdoutChunks.push(new TextDecoder().decode(chunk));
        yield* each.next();
      }
    });
    const readStderr = yield* spawn(function* () {
      for (const chunk of yield* each(proc.stderr)) {
        stderrChunks.push(new TextDecoder().decode(chunk));
        yield* each.next();
      }
    });

    const status = yield* proc.join();
    yield* readStdout;
    yield* readStderr;

    return {
      code: status.code,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  });
  if (result.timeout) {
    throw new Error("CLI subprocess timed out");
  }
  return result.value;
}

describe("xmd CLI", () => {
  it("test exits 0 and prints the report when every test passes", function* () {
    const result = yield* runCli(["test", "packages/testing/tests/fixtures/passing.md"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("**AssertEquals** passed");
    expect(result.stdout).toContain("Regular content stays.");
  });

  it("test exits 1 and prints the failure diagnostic when a test fails", function* () {
    const result = yield* runCli(["test", "packages/testing/tests/fixtures/failing.md"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("**Assert** failed");
    expect(result.stdout).toContain("Test **bad** failed");
    expect(result.stderr).toContain("tests failed");
  });

  it("test exits 1 when no tests are discovered", function* () {
    const result = yield* runCli(["test", "README.md"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no tests were discovered");
  });

  it("run skips tests entirely and exits 0", function* () {
    const result = yield* runCli(["run", "packages/testing/tests/fixtures/failing.md"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Assert");
    expect(result.stdout).toContain("# Fixture");
  });
});
