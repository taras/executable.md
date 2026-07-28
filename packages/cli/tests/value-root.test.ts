/**
 * Tier VR — `xmd run` value roots (spec §5.4, §9.6).
 *
 * Shells out with piped stdio, so the channel separation the contract
 * promises — the JSON result alone on stdout, everything else on stderr — is
 * asserted the way a caller observes it, TTY-independently.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { timebox } from "@effectionx/timebox";
import { each, ensure, scoped, spawn } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { cliCommand } from "@executablemd/test-support/launch";

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

function* runCli(args: string[], dir: string): Operation<CliResult> {
  const result = yield* timebox<CliResult>(TIMEOUT, function* () {
    const cli = cliCommand(args);
    const proc = yield* exec(cli.command, {
      arguments: cli.arguments,
      cwd: dir,
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

function* useFixture<T>(
  files: Record<string, string>,
  body: (dir: string) => Operation<T>,
): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-vr-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(path.join(dir, name), content);
    }
    return yield* body(dir);
  });
}

const OBJECT_ROOT = [
  "---",
  "returns:",
  "  passed: { type: boolean }",
  "  summary: { type: string }",
  "---",
  "",
  "BODY_MARKER",
  "",
  '<Return value={{ passed: true, summary: "looks good" }} />',
  "",
].join("\n");

const STRING_ROOT = [
  "---",
  "returns:",
  "  type: string",
  "---",
  "",
  '<Return value="shipped" />',
  "",
].join("\n");

const INVALID_STRUCTURE_ROOT = [
  "---",
  "returns:",
  "  type: string",
  "---",
  "",
  "BODY_MARKER",
  "",
].join("\n");

const FAILS_AFTER_RETURN_ROOT = [
  "---",
  "returns:",
  "  type: string",
  "---",
  "",
  '<Return value="shipped" />',
  "",
  "<Missing />",
  "",
].join("\n");

const TEXT_ROOT = "TEXT_MARKER\n";

describe("Tier VR — xmd run value roots", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("VR1: stdout carries only the JSON result", function* () {
    const result = yield* useFixture({ "doc.md": OBJECT_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], dir);
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"passed":true,"summary":"looks good"}\n');
    expect(result.stdout).not.toContain("BODY_MARKER");
  });

  it("VR2: a string result stays a quoted JSON string", function* () {
    const result = yield* useFixture({ "doc.md": STRING_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], dir);
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('"shipped"\n');
  });

  it("VR3: --verbose moves body output and diagnostics to stderr", function* () {
    const result = yield* useFixture({ "doc.md": OBJECT_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md", "--verbose"], dir);
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"passed":true,"summary":"looks good"}\n');
    expect(result.stderr).toContain("BODY_MARKER");
  });

  it("VR4: a structural failure exits nonzero with empty stdout", function* () {
    const result = yield* useFixture({ "doc.md": INVALID_STRUCTURE_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], dir);
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no direct top-level <Return>");
  });

  it("VR5: a failure after <Return> exits nonzero with empty stdout", function* () {
    const result = yield* useFixture({ "doc.md": FAILS_AFTER_RETURN_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], dir);
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Missing");
  });

  it("VR6: a text root still writes its rendering to stdout", function* () {
    const result = yield* useFixture({ "doc.md": TEXT_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md", "--raw"], dir);
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("TEXT_MARKER");
  });
});
