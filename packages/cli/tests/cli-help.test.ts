/**
 * Tier CH — `xmd` help output.
 *
 * Shells out with piped stdio so exit status and text are asserted
 * TTY-independently. Command-level help is the regression these cover:
 * under configliere 0.2.x the parser stopped at the command name and
 * never reached a trailing `--help`, so `xmd run --help` exited 1 with
 * `docPath: Invalid input: expected string, received undefined`.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { timebox } from "@effectionx/timebox";
import { spawn, each } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import process from "node:process";
import * as path from "node:path";

const CLI = path.resolve("packages/cli/src/cli.ts");
const TIMEOUT = 60_000;

interface CliResult {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "DENO_DIR",
    "DENO_INSTALL_ROOT",
    "XDG_CACHE_HOME",
    "TMPDIR",
  ]) {
    const value = process.env[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return env;
}

function* runCli(args: string[]): Operation<CliResult> {
  const result = yield* timebox<CliResult>(TIMEOUT, function* () {
    const proc = yield* exec("deno", {
      arguments: ["run", "--allow-all", CLI, ...args],
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
    return { code: status.code, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  });
  if (result.timeout) {
    throw new Error("CLI subprocess timed out");
  }
  return result.value;
}

describe("Tier CH — xmd help", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CH1: program help lists the commands", function* () {
    const result = yield* runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: xmd <COMMAND> [OPTIONS]");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("test-agent");
  });

  it("CH2: xmd run --help prints run help instead of a missing-argument error", function* () {
    const result = yield* runCli(["run", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: xmd run [OPTIONS] <docPath>");
    expect(result.stdout).toContain("markdown document to execute");
    expect(result.stdout).toContain("--component-dir");
    expect(result.stderr).not.toContain("Invalid input");
  });

  it("CH3: xmd test --help prints test help", function* () {
    const result = yield* runCli(["test", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: xmd test [OPTIONS] <docPath>");
    expect(result.stdout).toContain("markdown document to test");
  });

  it("CH4: --version prints the version", function* () {
    const result = yield* runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("CH5: a missing document still fails, so help detection does not mask errors", function* () {
    const result = yield* runCli(["run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("docPath");
  });
});
