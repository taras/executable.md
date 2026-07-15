/**
 * CLI journal integration tests.
 *
 * Exercises the full CLI pipeline as a subprocess — arg parsing,
 * stream consumption, middleware, and diagnostic journal output.
 *
 * Each test shells out to `deno run --allow-all cli/src/cli.ts`
 * and uses timebox to prevent hangs from blocking the test suite.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { timebox } from "@effectionx/timebox";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { spawn, each, type Operation } from "effection";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmd-cli-test-"));
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
function* runCliResult(args: string[]) {
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
  return result.value;
}

function* runCli(args: string[]) {
  const result = yield* runCliResult(args);
  if (result.code !== 0) {
    throw new Error(
      `CLI exited with code ${result.code}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  return result;
}

interface JournalEventView {
  type: string;
  coroutineId?: string;
  description?: { type?: string };
  result?: { status?: string };
}

function* readJournal(filePath: string): Operation<JournalEventView[]> {
  return (yield* readTextFile(filePath))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JournalEventView);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI journal integration", () => {
  // CJ1: Run without journal (raw)
  it("CJ1: runs document without journal --raw", function* () {
    const result = yield* runCli(["core/tests/fixtures/streaming/simple.md", "--raw"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello world");
  });

  // CJ2: Run without journal (normalized)
  it("CJ2: runs document without journal (normalized)", function* () {
    const result = yield* runCli(["core/tests/fixtures/streaming/simple.md"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello world");
  });

  it("CJ3: --journal writes parseable entries for the current run", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");

    try {
      const result = yield* runCli([
        "core/tests/fixtures/streaming/simple.md",
        `--journal=${journalPath}`,
        "--raw",
      ]);
      expect(result.code).toBe(0);
      expect(yield* exists(journalPath)).toBe(true);

      const events = yield* readJournal(journalPath);
      expect(events.length).toBeGreaterThan(1);
      expect(events[0]?.type).toBe("yield");
      expect(events.at(-1)?.type).toBe("close");
      expect(events.at(-1)?.coroutineId).toBe("root");
      expect(events.at(-1)?.result?.status).toBe("ok");
    } finally {
      yield* rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("CJ4: existing journal path is refused without executing the document", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");
    const documentPath = path.join(tmpDir, "side-effect.md");
    const markerPath = path.join(tmpDir, "executed.txt");
    const existingContent = '{"type":"partial"';

    try {
      yield* writeTextFile(journalPath, existingContent);
      yield* writeTextFile(
        documentPath,
        ["```bash exec", `printf ran > "${markerPath}"`, "```"].join("\n"),
      );

      const result = yield* runCliResult([documentPath, `--journal=${journalPath}`, "--raw"]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Journal trace already exists");
      expect(result.stdout).toBe("");
      expect(yield* readTextFile(journalPath)).toBe(existingContent);
      expect(yield* exists(markerPath)).toBe(false);
    } finally {
      yield* rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("CJ5: separate trace paths produce fresh executions", function* () {
    const tmpDir = makeTmpDir();
    const documentPath = path.join(tmpDir, "document.md");
    const firstJournal = path.join(tmpDir, "first.jsonl");
    const secondJournal = path.join(tmpDir, "second.jsonl");

    try {
      yield* writeTextFile(documentPath, "Version one\n");
      const firstRun = yield* runCli([documentPath, `--journal=${firstJournal}`, "--raw"]);

      yield* writeTextFile(documentPath, "Version two\n");
      const secondRun = yield* runCli([documentPath, `--journal=${secondJournal}`, "--raw"]);

      expect(firstRun.stdout).toContain("Version one");
      expect(secondRun.stdout).toContain("Version two");
      expect((yield* readJournal(firstJournal)).at(-1)?.result?.status).toBe("ok");
      expect((yield* readJournal(secondJournal)).at(-1)?.result?.status).toBe("ok");
    } finally {
      yield* rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("CJ6: journal writes exec entries", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");

    try {
      const result = yield* runCli([
        "core/tests/fixtures/streaming/with-exec.md",
        `--journal=${journalPath}`,
      ]);
      expect(result.code).toBe(0);
      expect(
        (yield* readJournal(journalPath)).some((event) => event.description?.type === "exec"),
      ).toBe(true);
    } finally {
      yield* rm(tmpDir, { recursive: true, force: true });
    }
  });
});
