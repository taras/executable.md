/**
 * CLI journal integration tests.
 *
 * Exercises the full CLI pipeline as a subprocess — arg parsing,
 * stream consumption, middleware, journal persistence, and replay.
 *
 * Each test shells out to `deno run --allow-all cli/src/cli.ts`
 * and uses timebox to prevent hangs from blocking the test suite.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { timebox } from "@effectionx/timebox";
import { spawn, each } from "effection";
import { exec } from "@effectionx/process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI_CMD = "deno";
const CLI_ARGS = ["run", "--allow-all", "cli/src/cli.ts", "run"];
const TIMEOUT = 15_000;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ema-cli-test-"));
}

interface CliResult {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI as a subprocess and collect stdout/stderr regardless
 * of exit code. This avoids ExecError swallowing diagnostic output.
 */
function* runCli(args: string[]) {
  const result = yield* timebox<CliResult>(TIMEOUT, function* () {
    const proc = yield* exec(CLI_CMD, {
      arguments: [...CLI_ARGS, ...args],
      env: process.env as Record<string, string>,
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
    throw new Error(`CLI timed out after ${TIMEOUT}ms`);
  }
  const { value } = result;
  if (value.code !== 0) {
    throw new Error(
      `CLI exited with code ${value.code}\nstderr: ${value.stderr}\nstdout: ${value.stdout}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI journal integration", () => {
  // CJ1: Run without journal (raw)
  it("CJ1: runs document without journal --raw", function* () {
    const result = yield* runCli([
      "core/tests/fixtures/streaming/simple.md",
      "--raw",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello world");
  });

  // CJ2: Run without journal (normalized)
  it("CJ2: runs document without journal (normalized)", function* () {
    const result = yield* runCli([
      "core/tests/fixtures/streaming/simple.md",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello world");
  });

  // CJ3: Replay from journal (raw)
  it("CJ3: replay from journal produces same output --raw", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");

    try {
      const firstRun = yield* runCli([
        "core/tests/fixtures/streaming/simple.md",
        `--journal=${journalPath}`,
        "--raw",
      ]);
      expect(firstRun.code).toBe(0);
      expect(fs.existsSync(journalPath)).toBe(true);

      const secondRun = yield* runCli([
        "core/tests/fixtures/streaming/simple.md",
        `--journal=${journalPath}`,
        "--raw",
      ]);
      expect(secondRun.code).toBe(0);
      expect(secondRun.stdout).toBe(firstRun.stdout);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // CJ4: Replay from journal (normalized)
  it("CJ4: replay from journal produces same output (normalized)", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");

    try {
      const firstRun = yield* runCli([
        "core/tests/fixtures/streaming/simple.md",
        `--journal=${journalPath}`,
      ]);
      expect(firstRun.code).toBe(0);

      const secondRun = yield* runCli([
        "core/tests/fixtures/streaming/simple.md",
        `--journal=${journalPath}`,
      ]);
      expect(secondRun.code).toBe(0);
      expect(secondRun.stdout).toBe(firstRun.stdout);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // CJ5: Replay with exec blocks (raw)
  it("CJ5: replay with exec blocks --raw", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");

    try {
      const firstRun = yield* runCli([
        "core/tests/fixtures/streaming/with-exec.md",
        `--journal=${journalPath}`,
        "--raw",
      ]);
      expect(firstRun.code).toBe(0);
      expect(firstRun.stdout).toContain("hello from exec");

      const secondRun = yield* runCli([
        "core/tests/fixtures/streaming/with-exec.md",
        `--journal=${journalPath}`,
        "--raw",
      ]);
      expect(secondRun.code).toBe(0);
      expect(secondRun.stdout).toBe(firstRun.stdout);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // CJ6: Replay with exec blocks (normalized)
  it("CJ6: replay with exec blocks (normalized)", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");

    try {
      const firstRun = yield* runCli([
        "core/tests/fixtures/streaming/with-exec.md",
        `--journal=${journalPath}`,
      ]);
      expect(firstRun.code).toBe(0);

      const secondRun = yield* runCli([
        "core/tests/fixtures/streaming/with-exec.md",
        `--journal=${journalPath}`,
      ]);
      expect(secondRun.code).toBe(0);
      expect(secondRun.stdout).toBe(firstRun.stdout);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
