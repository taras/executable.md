/**
 * `xmd test` diagnostics from the compiled binary (#1169, #1170).
 *
 * The runtime shards launch the source entrypoint. What a CI job and a person
 * running a release actually launch is `dist/xmd`, so this runs a failing
 * Markdown test there and reads what it left: a failed exit, progress on stderr
 * apart from the rendered report on stdout, and the failed root and child
 * journals as parseable JSONL beneath the artifact root it was given.
 *
 * It runs against `dist/xmd`, so `deno task build` has to have happened. A
 * missing binary is reported as the setup it is rather than as a failed assertion.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { parseDurableEvent } from "@executablemd/durable-streams";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = path.join(ROOT, "dist", "xmd");
const TIMEOUT = 60_000;

describe("compiled xmd test diagnostics", () => {
  it("reports progress on stderr and saves the failed root and child journals", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    const directory = yield* useTempDirectory("xmd-compiled-diagnostics-");
    const artifacts = path.join(directory, "artifacts");
    yield* writeTextFile(
      path.join(directory, "child.md"),
      '<Fail message="compiled-child-failure" />\n',
    );
    yield* writeTextFile(
      path.join(directory, "suite.test.md"),
      ['<Test name="nested">', '<Execution host="run" target="./child.md" />', "</Test>", ""].join(
        "\n",
      ),
    );

    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    const run = yield* timebox(TIMEOUT, () =>
      exec(BINARY, {
        arguments: ["test", "suite.test.md"],
        cwd: directory,
        env: { ...environment, XMD_TEST_ARTIFACTS: artifacts },
      }).join(),
    );
    if (run.timeout) {
      throw new Error(`dist/xmd test did not finish within ${TIMEOUT}ms`);
    }
    const result = run.value;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[xmd test] start test "nested" at suite.test.md:1:1');
    expect(result.stderr).toContain('[xmd test] fail test "nested" at suite.test.md:1:1 (error)');
    expect(result.stdout).not.toContain("[xmd test]");

    const [invocation, ...others] = yield* readdir(artifacts);
    expect(others).toEqual([]);
    const retained = path.join(artifacts, invocation ?? "");
    const files = (yield* readdir(retained)).sort();
    expect(files).toEqual(["child-1.jsonl", "root-1.jsonl"]);
    for (const file of files) {
      const saved = path.join(retained, file);
      expect(result.stderr).toContain(`[xmd test] journal saved: ${saved}`);
      const lines = (yield* readTextFile(saved)).split("\n").filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(parseDurableEvent(line).ok).toBe(true);
      }
    }
    expect(yield* readTextFile(path.join(retained, "child-1.jsonl"))).toContain(
      "compiled-child-failure",
    );
  });

  it("attributes each invocation of a repeated test to the operation it interrupted", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    const directory = yield* useTempDirectory("xmd-compiled-repeated-");
    // One `<Test>`, written once at line 8, invoked twice; "first" blocks at
    // line 11 and "second" at line 18 until the 1s deadline interrupts it.
    yield* writeTextFile(
      path.join(directory, "Repeated.md"),
      [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    which: { type: string }",
        "  required: [which]",
        "---",
        '<Test name={props.which} timeout="1s">',
        '<If condition={props.which === "first"}>',
        "",
        "```sh exec",
        "sleep 10",
        "```",
        "",
        "</If>",
        '<If condition={props.which === "second"}>',
        "",
        "```sh exec",
        "sleep 10",
        "```",
        "",
        "</If>",
        "</Test>",
        "",
      ].join("\n"),
    );
    yield* writeTextFile(
      path.join(directory, "suite.test.md"),
      '<Repeated which="first" />\n\n<Repeated which="second" />\n',
    );
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    const run = yield* timebox(TIMEOUT, () =>
      exec(BINARY, {
        arguments: ["test", "suite.test.md"],
        cwd: directory,
        env: { ...environment, XMD_TEST_ARTIFACTS: path.join(directory, "artifacts") },
      }).join(),
    );
    if (run.timeout) {
      throw new Error(`dist/xmd test did not finish within ${TIMEOUT}ms`);
    }
    expect(run.value.code).toBe(1);
    const outcomes = run.value.stderr
      .split("\n")
      .filter((line) => /^\[xmd test\] (pass|fail) test/.test(line));
    expect(outcomes).toEqual([
      '[xmd test] fail test "first" at Repeated.md:8:1 (timeout; interrupted sh exec at Repeated.md:11:1)',
      '[xmd test] fail test "second" at Repeated.md:8:1 (timeout; interrupted sh exec at Repeated.md:18:1)',
    ]);
    expect(run.value.stderr).toContain('[xmd test] start test "first" at Repeated.md:8:1');
    expect(run.value.stderr).toContain('[xmd test] start test "second" at Repeated.md:8:1');
  });
});
