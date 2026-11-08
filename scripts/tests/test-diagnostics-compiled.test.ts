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
import { sleep, spawn } from "effection";
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
  it("attributes concurrent repeated tests when completion order reverses start order", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run deno task build`);
    }
    const directory = yield* useTempDirectory("xmd-compiled-concurrent-");
    yield* writeTextFile(
      path.join(directory, "Repeated.md"),
      [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    which: { type: string }",
        "    timeout: { type: string }",
        "  required: [which, timeout]",
        "---",
        "<Test name={props.which} timeout={props.timeout}>",
        '<If condition={props.which === "first"}>',
        "",
        "```sh exec",
        "touch first-ready; while [ ! -f never-created ]; do sleep 0.05; done",
        "```",
        "",
        "</If>",
        '<If condition={props.which === "second"}>',
        "",
        "```sh exec",
        "touch second-ready; while [ ! -f never-created ]; do sleep 0.05; done",
        "```",
        "",
        "</If>",
        "</Test>",
        "",
      ].join("\n"),
    );
    yield* writeTextFile(
      path.join(directory, "suite.test.md"),
      [
        "<All>",
        "<Spawn>",
        "```sh exec",
        "while [ ! -f second-ready ]; do sleep 0.05; done",
        "```",
        '<Repeated which="first" timeout="1s" />',
        "</Spawn>",
        '<Spawn><Repeated which="second" timeout="3s" /></Spawn>',
        "</All>",
        "",
      ].join("\n"),
    );
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    const child = yield* exec(BINARY, {
      arguments: ["test", "suite.test.md"],
      cwd: directory,
      env: { ...environment, XMD_TEST_ARTIFACTS: path.join(directory, "artifacts") },
    });
    let stderr = "";
    let stdout = "";
    const output = yield* child.stdout;
    const outputReader = yield* spawn(function* () {
      const decoder = new TextDecoder();
      for (let item = yield* output.next(); !item.done; item = yield* output.next()) {
        stdout += decoder.decode(item.value, { stream: true });
      }
    });
    const subscription = yield* child.stderr;
    const reader = yield* spawn(function* () {
      const decoder = new TextDecoder();
      for (let item = yield* subscription.next(); !item.done; item = yield* subscription.next()) {
        stderr += decoder.decode(item.value, { stream: true });
      }
    });
    const readiness = yield* timebox(TIMEOUT, function* () {
      while (
        !(yield* exists(path.join(directory, "first-ready"))) ||
        !(yield* exists(path.join(directory, "second-ready")))
      ) {
        yield* sleep(10);
      }
    });
    expect(readiness.timeout).toBe(false);
    expect(
      stderr
        .split("\n")
        .filter((line) =>
          /^\[xmd test\] (done|failed|cancelled) sh exec at Repeated\.md:(12|19):1$/.test(line),
        ),
    ).toEqual([]);
    expect(
      stderr.split("\n").filter((line) => /^\[xmd test\] (pass|fail) test/.test(line)),
    ).toEqual([]);
    const joined = yield* timebox(TIMEOUT, () => child.join());
    if (joined.timeout) {
      throw new Error("compiled concurrent CLI did not finish");
    }
    yield* reader;
    yield* outputReader;
    expect(joined.value.code).toBe(1);
    const lines = stderr
      .split("\n")
      .filter((line) => line.startsWith("[xmd test] "))
      .map((line) => line.slice(11));
    expect(lines.filter((line) => /^start test/.test(line))).toEqual([
      'start test "second" at Repeated.md:9:1',
      'start test "first" at Repeated.md:9:1',
    ]);
    const operations = ["start sh exec at Repeated.md:19:1", "start sh exec at Repeated.md:12:1"];
    expect(lines.filter((line) => operations.includes(line))).toEqual(operations);
    expect(lines.filter((line) => /^(pass|fail) test/.test(line))).toEqual([
      'fail test "first" at Repeated.md:9:1 (timeout; interrupted sh exec at Repeated.md:12:1)',
      'fail test "second" at Repeated.md:9:1 (timeout; interrupted sh exec at Repeated.md:19:1)',
    ]);
    expect(stdout).not.toContain("[xmd test]");
  });
});
