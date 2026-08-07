/**
 * CLI journal integration tests.
 *
 * Exercises the full CLI pipeline as a subprocess — arg parsing,
 * stream consumption, middleware, and diagnostic journal output.
 *
 * Each test shells out to the CLI under the host runtime
 * and uses timebox to prevent hangs from blocking the test suite.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { ensure, type Operation } from "effection";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "@executablemd/test-support/launch";

// These runs read fixtures from the repository, so they keep this process's
// working directory and its whole environment.
const RUN = { inheritEnv: true, timeout: 15_000 };

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmd-cli-test-"));
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

describe("CLI journal integration", () => {
  // CJ1: Run without journal (raw)
  it("CJ1: runs document without journal --raw", function* () {
    const result = yield* runCli(
      ["run", "packages/core/tests/fixtures/streaming/simple.md", "--raw"],
      RUN,
    ).expect();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello world");
  });

  // CJ2: Run without journal (normalized)
  it("CJ2: runs document without journal (normalized)", function* () {
    const result = yield* runCli(
      ["run", "packages/core/tests/fixtures/streaming/simple.md"],
      RUN,
    ).expect();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello world");
  });

  it("CJ3: --journal writes parseable entries for the current run", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));

    const result = yield* runCli(
      [
        "run",
        "packages/core/tests/fixtures/streaming/simple.md",
        `--journal=${journalPath}`,
        "--raw",
      ],
      RUN,
    ).expect();
    expect(result.code).toBe(0);
    expect(yield* exists(journalPath)).toBe(true);

    const events = yield* readJournal(journalPath);
    expect(events.length).toBeGreaterThan(1);
    expect(events[0]?.type).toBe("yield");
    expect(events.at(-1)?.type).toBe("close");
    expect(events.at(-1)?.coroutineId).toBe("root");
    expect(events.at(-1)?.result?.status).toBe("ok");
  });

  it("CJ4: existing journal path is refused without executing the document", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");
    const documentPath = path.join(tmpDir, "side-effect.md");
    const markerPath = path.join(tmpDir, "executed.txt");
    const existingContent = '{"type":"partial"';
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));

    yield* writeTextFile(journalPath, existingContent);
    yield* writeTextFile(
      documentPath,
      ["```bash exec", `printf ran > "${markerPath}"`, "```"].join("\n"),
    );

    const result = yield* runCli(
      ["run", documentPath, `--journal=${journalPath}`, "--raw"],
      RUN,
    ).join();

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Journal trace already exists");
    expect(result.stdout).toBe("");
    expect(yield* readTextFile(journalPath)).toBe(existingContent);
    expect(yield* exists(markerPath)).toBe(false);
  });

  it("CJ5: separate trace paths produce fresh executions", function* () {
    const tmpDir = makeTmpDir();
    const documentPath = path.join(tmpDir, "document.md");
    const firstJournal = path.join(tmpDir, "first.jsonl");
    const secondJournal = path.join(tmpDir, "second.jsonl");
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));

    yield* writeTextFile(documentPath, "Version one\n");
    const firstRun = yield* runCli(
      ["run", documentPath, `--journal=${firstJournal}`, "--raw"],
      RUN,
    ).expect();

    yield* writeTextFile(documentPath, "Version two\n");
    const secondRun = yield* runCli(
      ["run", documentPath, `--journal=${secondJournal}`, "--raw"],
      RUN,
    ).expect();

    expect(firstRun.stdout).toContain("Version one");
    expect(secondRun.stdout).toContain("Version two");
    expect((yield* readJournal(firstJournal)).at(-1)?.result?.status).toBe("ok");
    expect((yield* readJournal(secondJournal)).at(-1)?.result?.status).toBe("ok");
  });

  it("CJ6: journal writes exec entries", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "test.jsonl");
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));

    const result = yield* runCli(
      ["run", "packages/core/tests/fixtures/streaming/with-exec.md", `--journal=${journalPath}`],
      RUN,
    ).expect();
    expect(result.code).toBe(0);
    expect(
      (yield* readJournal(journalPath)).some((event) => event.description?.type === "exec"),
    ).toBe(true);
  });

  it("CJ7: a review-style Output root exits zero for finding text", function* () {
    const tmpDir = makeTmpDir();
    const documentPath = path.join(tmpDir, "review.md");
    const journalPath = path.join(tmpDir, "review.jsonl");
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));

    yield* writeTextFile(
      documentPath,
      [
        "<Output>",
        "",
        "<!-- ERROR: ordinary review finding text -->",
        "",
        "Finding text is not an execution failure.",
        "",
        "</Output>",
      ].join("\n"),
    );
    const result = yield* runCli(
      ["run", documentPath, `--journal=${journalPath}`, "--raw"],
      RUN,
    ).expect();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Finding text is not an execution failure");
  });

  it("CJ8: an error beneath Output exits nonzero without inspecting output", function* () {
    const tmpDir = makeTmpDir();
    const documentPath = path.join(tmpDir, "review.md");
    const journalPath = path.join(tmpDir, "review.jsonl");
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));
    yield* writeTextFile(
      documentPath,
      ["<Output>", "", "<MissingReviewComponent />", "", "</Output>"].join("\n"),
    );

    const result = yield* runCli(
      ["run", documentPath, `--journal=${journalPath}`, "--raw"],
      RUN,
    ).join();

    expect(result.code).not.toBe(0);
  });

  it("CJ9: failed Output runs still leave the configured journal", function* () {
    const tmpDir = makeTmpDir();
    const documentPath = path.join(tmpDir, "review.md");
    const journalPath = path.join(tmpDir, "review.jsonl");
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));
    yield* writeTextFile(
      documentPath,
      ["<Output>", "", "<MissingReviewComponent />", "", "</Output>"].join("\n"),
    );

    const result = yield* runCli(
      ["run", documentPath, `--journal=${journalPath}`, "--raw"],
      RUN,
    ).join();

    expect(result.code).not.toBe(0);
    expect(yield* exists(journalPath)).toBe(true);
  });

  it("CJ10: only normalized diagnostics cross the journal boundary", function* () {
    const tmpDir = makeTmpDir();
    const journalPath = path.join(tmpDir, "diagnostics.jsonl");
    yield* ensure(() => rm(tmpDir, { recursive: true, force: true }));

    const result = yield* runCli(
      [
        "run",
        "packages/core/tests/fixtures/streaming/normalized-diagnostics.md",
        `--journal=${journalPath}`,
        "--raw",
      ],
      RUN,
    ).expect();
    const journal = yield* readTextFile(journalPath);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("normalized");
    expect(result.stdout).not.toContain("ERROR");
    expect(journal).toContain("normalized");
    expect(journal).not.toContain("RAW_SOURCE");
    expect(journal).not.toContain("ARBITRARY");
    expect(journal).not.toContain("Bearer opaque");
    expect(journal).not.toContain("authorization");
    expect(journal).not.toContain("ghp_x");
    expect(journal).not.toContain("STDOUT");
    expect(journal).not.toContain("STDERR");
  });
});
