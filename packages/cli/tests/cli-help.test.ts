/**
 * Tier CH — `xmd` help output.
 *
 * Shells out with captured stdio so exit status and text are asserted
 * TTY-independently. Command-level help is the regression these cover:
 * under configliere 0.2.x the parser stopped at the command name and
 * never reached a trailing `--help`, so `xmd run --help` exited 1 with
 * `path: Invalid input: expected string, received undefined`.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

function* useFixture<T>(
  files: Record<string, string>,
  body: (dir: string) => Operation<T>,
): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-ch-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(path.join(dir, name), content);
    }
    return yield* body(dir);
  });
}

/** A document that addresses two sections and declares one property. */
const DOCUMENT = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string, description: Person to greet }",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  "# Guide",
  "",
  "## Prepare",
  "",
  "Install what the later sections read from.",
  "",
  "## Verify",
  "",
  "```bash",
  "echo verified",
  "```",
  "",
].join("\n");

describe("Tier CH — xmd help", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CH1: program help lists the commands", function* () {
    const { stdout } = yield* runCli(["--help"]).expect();
    expect(stdout).toContain("Usage: xmd <COMMAND> [OPTIONS]");
    expect(stdout).toContain("run");
    expect(stdout).toContain("test-agent");
  });

  it("CH2: xmd run --help prints run help instead of a missing-argument error", function* () {
    const { stdout, stderr } = yield* runCli(["run", "--help"]).expect();
    // The path is optional because `--eval` is the other way to supply a root
    // document; which of the two a run needs is stated below the options.
    expect(stdout).toContain("Usage: xmd run [OPTIONS] [path]");
    expect(stdout).toContain("markdown document to execute");
    expect(stdout).toContain("-e, --eval");
    expect(stdout).toContain("Exactly one root document is required");
    expect(stdout).toContain("--component-dir");
    expect(stderr).not.toContain("Invalid input");
  });

  it("CH3: xmd test --help prints test help", function* () {
    const { stdout } = yield* runCli(["test", "--help"]).expect();
    expect(stdout).toContain("Usage: xmd test [OPTIONS] [path]");
    expect(stdout).toContain("markdown document or directory to test");
  });

  it("CH4: --version prints the version", function* () {
    const { stdout } = yield* runCli(["--version"]).expect();
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("CH5: a missing document still fails, so help detection does not mask errors", function* () {
    const { code, stderr } = yield* runCli(["run"]).join();
    expect(code).toBe(1);
    // Once `path` became optional the parser stopped raising, so the diagnostic
    // is the CLI's own and names both ways to supply a root document.
    expect(stderr).toContain("requires a document path or an inline document");
  });

  it("CH6: no command named targets is registered", function* () {
    const { stdout } = yield* runCli(["--help"]).expect();
    expect(stdout).not.toContain("targets");
    expect(stdout).not.toContain("xmd targets");
  });

  it("CH7: a document named targets gets ordinary shorthand run help", function* () {
    // Removing the command returns the word to the grammar that owns every
    // other token in that position: it names a document, and nothing reserves
    // it. Help therefore describes that document rather than a command.
    yield* useFixture({ targets: DOCUMENT }, function* (dir) {
      const { stdout, stderr } = yield* runCli(["targets", "--help"], { cwd: dir }).expect();
      expect(stdout).toContain("Usage: xmd run [OPTIONS] [path]");
      expect(stdout).toContain("Properties declared by targets");
      expect(stdout).toContain("Targets in targets");
      expect(stdout).toContain("  targets#Prepare");
      expect(stdout).not.toContain("Usage: xmd targets");
      expect(stderr).toBe("");
    });
  });

  it("CH8: run help teaches the document-reference grammar", function* () {
    const { stdout } = yield* runCli(["run", "--help"]).expect();
    expect(stdout).toContain("xmd run README.md#Release/Publish");
    expect(stdout).toContain("xmd README.md#Release/*");
    expect(stdout).toContain("`xmd run <document.md> --help`");
    expect(stdout).toContain("write `#` as `%23` and a literal `%` as `%25`");
  });

  it("CH10: generic run help reads no document and shows neither section", function* () {
    yield* useFixture({ "doc.md": DOCUMENT }, function* (dir) {
      const { stdout } = yield* runCli(["run", "--help"], { cwd: dir }).expect();
      expect(stdout).toContain("Usage: xmd run [OPTIONS] [path]");
      // The fixture is the working directory, so a generic help that read
      // anything would have this document to read.
      expect(stdout).not.toContain("Targets in");
      expect(stdout).not.toContain("Properties declared by");
      expect(stdout).not.toContain("Install what the later sections read from.");
    });
  });

  it("CH11: a file-backed form adds both contextual sections to the same run help", function* () {
    yield* useFixture({ "doc.md": DOCUMENT }, function* (dir) {
      const { stdout } = yield* runCli(["run", "doc.md", "--help"], { cwd: dir }).expect();
      // The generic help is still all there; the document only adds to it.
      expect(stdout).toContain("Usage: xmd run [OPTIONS] [path]");
      expect(stdout).toContain("Exactly one root document is required");
      expect(stdout).toContain("Properties declared by doc.md");
      // Properties first, then targets: the order help has always composed in.
      expect(stdout.indexOf("Properties declared by doc.md")).toBeLessThan(
        stdout.indexOf("Targets in doc.md"),
      );
      expect(stdout).toContain(["Targets in doc.md", "", "  doc.md#Prepare"].join("\n"));
    });
  });

  it("CH9: test help is unchanged by the reference grammar", function* () {
    const { stdout } = yield* runCli(["test", "--help"]).expect();
    expect(stdout).toContain("Usage: xmd test [OPTIONS] [path]");
    expect(stdout).not.toContain("%23");
    expect(stdout).not.toContain("document reference");
  });
});
