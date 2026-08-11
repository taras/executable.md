/**
 * Tier VR — `xmd run` value roots (spec §5.4, §9.6).
 *
 * Shells out with piped stdio, so the channel separation the contract
 * promises — the JSON result alone on stdout, everything else on stderr — is
 * asserted the way a caller observes it, TTY-independently.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "@executablemd/test-support/launch";

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

const PRINTING_ROOT = [
  "---",
  "returns:",
  "  ok: { type: boolean }",
  "---",
  "",
  "```bash exec",
  `printf 'to-out'; printf 'to-err' >&2`,
  "```",
  "",
  "<Return value={{ ok: true }} />",
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

/** One `<Return>`, in one section — so the other section declares none. */
const SECTIONED_VALUE_ROOT = [
  "---",
  "returns:",
  "  passed: { type: boolean }",
  "---",
  "",
  "# Sectioned",
  "",
  "## Ready",
  "",
  "READY_MARKER",
  "",
  "<Return value={{ passed: true }} />",
  "",
  "## Other",
  "",
  "OTHER_MARKER",
  "",
].join("\n");

const SECTIONED_OUTPUT_ROOT = [
  "# Sectioned",
  "",
  "## Selected",
  "",
  "DOCUMENTATION_MARKER",
  "",
  "<Output>",
  "",
  "SELECTED_MARKER",
  "",
  "</Output>",
  "",
  "## Sibling",
  "",
  "SIBLING_MARKER",
  "",
].join("\n");

describe("Tier VR — xmd run value roots", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("VR1: stdout carries only the JSON result", function* () {
    const result = yield* useFixture({ "doc.md": OBJECT_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], { cwd: dir }).expect();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"passed":true,"summary":"looks good"}\n');
    expect(result.stdout).not.toContain("BODY_MARKER");
  });

  it("VR2: a string result stays a quoted JSON string", function* () {
    const result = yield* useFixture({ "doc.md": STRING_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], { cwd: dir }).expect();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('"shipped"\n');
  });

  it("VR3: --verbose moves body output and diagnostics to stderr", function* () {
    const result = yield* useFixture({ "doc.md": OBJECT_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md", "--verbose"], { cwd: dir }).expect();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"passed":true,"summary":"looks good"}\n');
    expect(result.stderr).toContain("BODY_MARKER");
  });

  it("VR4: a structural failure exits nonzero with empty stdout", function* () {
    const result = yield* useFixture({ "doc.md": INVALID_STRUCTURE_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], { cwd: dir }).join();
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no direct top-level <Return>");
  });

  it("VR5: a failure after <Return> exits nonzero with empty stdout", function* () {
    const result = yield* useFixture({ "doc.md": FAILS_AFTER_RETURN_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md"], { cwd: dir }).join();
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Missing");
  });

  it("VR6: a text root still writes its rendering to stdout", function* () {
    const result = yield* useFixture({ "doc.md": TEXT_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md", "--raw"], { cwd: dir }).expect();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("TEXT_MARKER");
  });

  it("VR7: a targeted value root reserves stdout for its result", function* () {
    const result = yield* useFixture({ "doc.md": SECTIONED_VALUE_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md#Ready", "--verbose"], { cwd: dir }).join();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"passed":true}\n');
    // The projection's own body is observability, and the sibling never ran.
    expect(result.stderr).toContain("READY_MARKER");
    expect(result.stderr).not.toContain("OTHER_MARKER");
  });

  it("VR8: a projection without <Return> is the same structural failure", function* () {
    const result = yield* useFixture({ "doc.md": SECTIONED_VALUE_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md#Other"], { cwd: dir }).join();
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no direct top-level <Return>");
  });

  /**
   * A value root's stdout is the result's, so this process shows a command's
   * stdout on the stream the result leaves free. Which stream that is belongs
   * to this process — the document forwards each channel as the child wrote it,
   * and the record says which channel each byte came from however it is shown.
   */
  it("VR10: a command's stdout is shown beside the result, and recorded as stdout", function* () {
    const result = yield* useFixture({ "doc.md": PRINTING_ROOT }, function* (dir) {
      const trace = path.join(dir, "trace.jsonl");
      const run = yield* runCli(["run", "doc.md", "--journal", trace], {
        cwd: dir,
        env: { HOME: dir },
      }).expect();
      return { run, record: yield* readTextFile(trace) };
    });

    // The result's channel carries the result and nothing else.
    expect(result.run.code).toBe(0);
    expect(result.run.stdout).toBe('{"ok":true}\n');
    // Both of the command's channels reached the reader once, beside it.
    expect(result.run.stderr).toContain("to-out");
    expect(result.run.stderr).toContain("to-err");
    expect(result.run.stderr.match(/to-out/g) ?? []).toHaveLength(1);
    expect(result.run.stderr.match(/to-err/g) ?? []).toHaveLength(1);
    // And the record still holds each channel as the child wrote it.
    const exec = result.record
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line))
      .find((event) => event.description?.type === "exec");
    expect(exec?.result?.value).toMatchObject({ exitCode: 0, stdout: "to-out", stderr: "to-err" });
  });

  it("VR9: <Output> in a projected text root still selects what is emitted", function* () {
    const result = yield* useFixture({ "doc.md": SECTIONED_OUTPUT_ROOT }, function* (dir) {
      return yield* runCli(["run", "doc.md#Selected", "--raw"], { cwd: dir }).expect();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("SELECTED_MARKER");
    expect(result.stdout).not.toContain("DOCUMENTATION_MARKER");
    expect(result.stdout).not.toContain("SIBLING_MARKER");
  });
});
