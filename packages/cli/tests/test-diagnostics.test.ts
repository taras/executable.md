/**
 * `xmd test` progress on stderr and failure journals (#1169, #1170).
 *
 * Every case runs the real CLI on a project in a temporary directory, because
 * what is under test is what a person running the command — or a CI job
 * collecting its artifacts — observes: lines arriving through a pipe while a
 * test is still waiting, and JSONL files that exist only for executions that
 * failed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliCommand, runCli } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { all, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RUN_TIMEOUT = 60_000;

/** Components a case names, resolved from the repository so their imports do. */
const FIXTURES = fileURLToPath(new URL("./fixtures/test-diagnostics", import.meta.url));

function doc(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/** A project on disk, written into a fresh temporary directory. */
function* useProject(files: Record<string, string>): Operation<string> {
  const directory = yield* useTempDirectory("xmd-test-diagnostics-");
  for (const [name, contents] of Object.entries(files)) {
    yield* writeTextFile(join(directory, name), contents);
  }
  return directory;
}

function runTest(directory: string, args: string[], artifacts: string): Operation<ProcessResult> {
  return runCli(["test", ...args], {
    cwd: directory,
    timeout: RUN_TIMEOUT,
    env: { XMD_TEST_ARTIFACTS: artifacts },
  }).join();
}

/** The progress lines of one run, without the prefix every one of them carries. */
function progress(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("[xmd test] "))
    .map((line) => line.slice("[xmd test] ".length));
}

/** Every saved journal under `artifacts`, by invocation and file, parsed. */
function* journals(artifacts: string): Operation<Map<string, DurableEvent[]>> {
  const found = new Map<string, DurableEvent[]>();
  if (!(yield* exists(artifacts))) {
    return found;
  }
  for (const invocation of yield* readdir(artifacts)) {
    for (const file of yield* readdir(join(artifacts, invocation))) {
      const text = yield* readTextFile(join(artifacts, invocation, file));
      const events = text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const event = parseDurableEvent(line);
          if (!event.ok) {
            throw event.error;
          }
          return event.value;
        });
      found.set(join(invocation, file), events);
    }
  }
  return found;
}

/** The names of the saved files, without the invocation directory. */
function fileNames(saved: Map<string, DurableEvent[]>): string[] {
  return [...saved.keys()].map((key) => key.split("/").at(-1) ?? key).sort();
}

/** A running `xmd test` whose stderr can be read while it is still running. */
interface LiveRun {
  readonly pid: number;
  stderr(): string;
  stdout(): string;
  /** Wait, bounded, until stderr contains `text`. */
  waitFor(text: string): Operation<void>;
  join(): Operation<{ code?: number; signal?: string }>;
}

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function* launch(directory: string, args: string[], artifacts: string): Operation<LiveRun> {
  const command = cliCommand(["test", ...args]);
  const child = yield* exec(command.command, {
    arguments: command.arguments,
    cwd: directory,
    env: { ...inheritedEnvironment(), XMD_TEST_ARTIFACTS: artifacts },
  });
  const captured = { stdout: "", stderr: "" };
  const decoder = () => new TextDecoder();
  yield* spawn(function* () {
    const output = yield* child.stderr;
    const text = decoder();
    for (let next = yield* output.next(); !next.done; next = yield* output.next()) {
      captured.stderr += text.decode(next.value, { stream: true });
    }
  });
  yield* spawn(function* () {
    const output = yield* child.stdout;
    const text = decoder();
    for (let next = yield* output.next(); !next.done; next = yield* output.next()) {
      captured.stdout += text.decode(next.value, { stream: true });
    }
  });
  return {
    pid: child.pid,
    stderr: () => captured.stderr,
    stdout: () => captured.stdout,
    *waitFor(text: string) {
      const waited = yield* timebox(RUN_TIMEOUT, function* () {
        while (!captured.stderr.includes(text)) {
          yield* sleep(20);
        }
      });
      if (waited.timeout) {
        throw new Error(`stderr never contained ${JSON.stringify(text)}:\n${captured.stderr}`);
      }
    },
    *join() {
      const status = yield* child.join();
      return {
        ...(typeof status.code === "number" ? { code: status.code } : {}),
        ...(typeof status.signal === "string" ? { signal: status.signal } : {}),
      };
    },
  };
}

/** A command that waits, in the shell, until the test creates `file`. */
function gate(file: string, ...modifiers: string[]): string[] {
  return [
    ["```sh", "exec", ...modifiers].join(" "),
    `while [ ! -f ${file} ]; do sleep 0.05; done`,
    "```",
  ];
}

const FAILING_CHILD = '<Fail message="nested-journal-failure" />\n';

/**
 * One `<Test>`, written once at line 8, that a suite invokes twice. Each
 * invocation blocks at its own fence — line 11 for "first", line 18 for
 * "second" — until its deadline interrupts it.
 */
const REPEATED = doc(
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
);

describe("xmd test failure journals", () => {
  it("saves the root and a failed nested child as separate journals", function* () {
    const directory = yield* useProject({
      "child.md": FAILING_CHILD,
      "suite.test.md": doc(
        '<Test name="nested">',
        '<Execution host="run" target="./child.md" />',
        "</Test>",
      ),
    });
    const artifacts = join(directory, "artifacts");
    const result = yield* runTest(directory, ["suite.test.md"], artifacts);
    expect(result.code).toBe(1);

    const saved = yield* journals(artifacts);
    expect(fileNames(saved)).toEqual(["child-1.jsonl", "root-1.jsonl"]);
    const [childKey] = [...saved.keys()].filter((key) => key.endsWith("child-1.jsonl"));
    const [rootKey] = [...saved.keys()].filter((key) => key.endsWith("root-1.jsonl"));
    const child = saved.get(childKey!) ?? [];
    const root = saved.get(rootKey!) ?? [];
    expect(JSON.stringify(child)).toContain("nested-journal-failure");
    expect(child.some((event) => event.type === "close" && event.coroutineId === "root")).toBe(
      true,
    );
    expect(JSON.stringify(root)).toContain("test_result");
    expect(JSON.stringify(root)).not.toContain('"coroutineId":"root.child');

    for (const key of [childKey!, rootKey!]) {
      expect(result.stderr).toContain(`journal saved: ${join(artifacts, key)}`);
    }
  });

  it("keeps concurrent invocations' journals apart under one artifact root", function* () {
    const directory = yield* useProject({
      "child.md": FAILING_CHILD,
      "suite.test.md": doc(
        '<Test name="nested">',
        '<Execution host="run" target="./child.md" />',
        "</Test>",
      ),
    });
    const artifacts = join(directory, "artifacts");
    const runs = yield* all([
      runTest(directory, ["suite.test.md"], artifacts),
      runTest(directory, ["suite.test.md"], artifacts),
    ]);
    expect(runs.map((run) => run.code)).toEqual([1, 1]);
    const saved = yield* journals(artifacts);
    const invocations = new Set([...saved.keys()].map((key) => key.split("/")[0]));
    expect(invocations.size).toBe(2);
    expect(fileNames(saved)).toEqual([
      "child-1.jsonl",
      "child-1.jsonl",
      "root-1.jsonl",
      "root-1.jsonl",
    ]);
  });

  it("keeps a failed child's journal when the test binds its Err as data", function* () {
    const directory = yield* useProject({
      "child.md": FAILING_CHILD,
      "suite.test.md": doc(
        '<Test name="expects failure">',
        '<Execution host="run" target="./child.md" as="child">',
        "<AssertEquals actual={child.result.ok} expected={false} />",
        "</Execution>",
        "</Test>",
      ),
    });
    const artifacts = join(directory, "artifacts");
    const result = yield* runTest(directory, ["suite.test.md"], artifacts);
    expect(result.code).toBe(0);
    const saved = yield* journals(artifacts);
    expect(fileNames(saved)).toEqual(["child-1.jsonl"]);
    expect(JSON.stringify([...saved.values()])).toContain("nested-journal-failure");
  });

  it("writes nothing for a passing run and leaves an explicit --journal exclusive", function* () {
    const directory = yield* useProject({
      "pass.test.md": doc('<Test name="passes">', "<Assert expr={true} />", "</Test>"),
      "fail.test.md": doc('<Test name="fails">', "<Assert expr={false} />", "</Test>"),
    });
    const artifacts = join(directory, "artifacts");
    const passed = yield* runTest(directory, ["pass.test.md"], artifacts);
    expect(passed.code).toBe(0);
    expect(yield* exists(artifacts)).toBe(false);

    const explicit = yield* runTest(
      directory,
      ["fail.test.md", "--journal", "explicit.jsonl"],
      artifacts,
    );
    expect(explicit.code).toBe(1);
    expect(yield* readTextFile(join(directory, "explicit.jsonl"))).toContain("test_result");
    expect(yield* exists(artifacts)).toBe(false);

    const again = yield* runTest(
      directory,
      ["fail.test.md", "--journal", "explicit.jsonl"],
      artifacts,
    );
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("explicit.jsonl");
    expect(yield* exists(artifacts)).toBe(false);
  });

  it("refuses CollectJournal without an authored journal before any child exists", function* () {
    const directory = yield* useProject({
      "child.md": FAILING_CHILD,
      "suite.test.md": doc(
        '<Test name="collects">',
        '<Execution host="run" target="./child.md" as="child">',
        '<CollectJournal as="journal" />',
        "<AssertEquals actual={child.result.ok} expected={false} />",
        "</Execution>",
        "</Test>",
      ),
    });
    const artifacts = join(directory, "artifacts");
    const result = yield* runTest(directory, ["suite.test.md"], artifacts);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("<CollectJournal> observes a journal the host selected");
    const saved = yield* journals(artifacts);
    expect(fileNames(saved)).toEqual(["root-1.jsonl"]);
    expect(progress(result.stderr).some((line) => line.startsWith("child "))).toBe(false);
  });
});

describe("xmd test live progress", () => {
  it("reports a waiting test and its operation before the work is released", function* () {
    const directory = yield* useProject({
      "suite.test.md": doc('<Test name="held">', "", ...gate("release"), "", "</Test>"),
    });
    const artifacts = join(directory, "artifacts");
    const run = yield* launch(directory, ["suite.test.md"], artifacts);
    yield* run.waitFor("start sh exec at suite.test.md:3:1");
    expect(progress(run.stderr())).toEqual([
      'start test "held" at suite.test.md:1:1',
      "start sh exec at suite.test.md:3:1",
    ]);
    yield* writeTextFile(join(directory, "release"), "");
    const status = yield* run.join();
    expect(status.code).toBe(0);
    expect(progress(run.stderr())).toEqual([
      'start test "held" at suite.test.md:1:1',
      "start sh exec at suite.test.md:3:1",
      "done sh exec at suite.test.md:3:1",
      'pass test "held" at suite.test.md:1:1',
    ]);
    expect(yield* exists(artifacts)).toBe(false);
  });

  it("attributes each invocation of a repeated test to the operation it interrupted", function* () {
    const directory = yield* useProject({
      "Repeated.md": REPEATED,
      "suite.test.md": doc('<Repeated which="first" />', "", '<Repeated which="second" />'),
    });
    const artifacts = join(directory, "artifacts");
    const result = yield* runTest(directory, ["suite.test.md"], artifacts);
    expect(result.code).toBe(1);
    const lines = progress(result.stderr);
    expect(lines.filter((line) => /^start test/.test(line))).toEqual([
      'start test "first" at Repeated.md:8:1',
      'start test "second" at Repeated.md:8:1',
    ]);
    expect(lines.filter((line) => /^(pass|fail) test/.test(line))).toEqual([
      'fail test "first" at Repeated.md:8:1 (timeout; interrupted sh exec at Repeated.md:11:1)',
      'fail test "second" at Repeated.md:8:1 (timeout; interrupted sh exec at Repeated.md:18:1)',
    ]);
  });

  it("attributes concurrent repeated tests when completion order reverses start order", function* () {
    const directory = yield* useProject({
      "Repeated.md": [
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
      "suite.test.md": [
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
    });
    const live = yield* launch(directory, ["suite.test.md"], join(directory, "artifacts"));
    const readiness = yield* timebox(RUN_TIMEOUT, function* () {
      while (
        !(yield* exists(join(directory, "first-ready"))) ||
        !(yield* exists(join(directory, "second-ready")))
      ) {
        yield* sleep(10);
      }
    });
    expect(readiness.timeout).toBe(false);
    expect(
      progress(live.stderr()).filter((line) =>
        /^(done|failed|cancelled) sh exec at Repeated\.md:(12|19):1$/.test(line),
      ),
    ).toEqual([]);
    expect(progress(live.stderr()).filter((line) => /^(pass|fail) test/.test(line))).toEqual([]);
    const joined = yield* timebox(RUN_TIMEOUT, () => live.join());
    expect(joined.timeout).toBe(false);
    if (joined.timeout) {
      throw new Error("concurrent CLI did not finish");
    }
    expect(joined.value.code).toBe(1);
    const lines = progress(live.stderr());
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
    expect(live.stdout()).not.toContain("[xmd test]");
  });

  it("keeps earlier progress and reports each failure once, naming an interrupted operation", function* () {
    const directory = yield* useProject({
      "waits.md": doc(...gate("never-created")),
      "suite.test.md": doc(
        '<Test name="asserts">',
        "<Assert expr={1 === 2} />",
        "</Test>",
        "",
        '<Test name="raises">',
        '<Fail message="unexpected" />',
        "</Test>",
        "",
        '<Test name="times out" timeout="500ms">',
        '<Execution host="run" target="./waits.md" />',
        "</Test>",
        "",
        '<Test name="bound wait" timeout="500ms">',
        "",
        ...gate("never-created", 'as="waited"'),
        "",
        "</Test>",
      ),
    });
    const artifacts = join(directory, "artifacts");
    const result = yield* runTest(directory, ["suite.test.md"], artifacts);
    expect(result.code).toBe(1);
    const lines = progress(result.stderr);
    const outcomes = lines.filter((line) => /^(pass|fail) test/.test(line));
    expect(outcomes).toEqual([
      'fail test "asserts" at suite.test.md:1:1 (assertion)',
      'fail test "raises" at suite.test.md:5:1 (error)',
      'fail test "times out" at suite.test.md:9:1 (timeout; interrupted Execution at suite.test.md:10:1)',
      'fail test "bound wait" at suite.test.md:13:1 (timeout; interrupted sh exec as at suite.test.md:15:1)',
    ]);
    expect(lines).toContain("child 1 ./waits.md: start sh exec at ./waits.md:1:1");
    expect(lines).toContain("child 1 ./waits.md: cancelled sh exec at ./waits.md:1:1");
    expect(lines).toContain("cancelled Execution at suite.test.md:10:1");
    expect(lines).toContain("start sh exec as at suite.test.md:15:1");
    expect(lines).toContain("cancelled sh exec as at suite.test.md:15:1");
    // Everything a test started is still there after the run failed.
    for (const name of ["asserts", "raises", "times out", "bound wait"]) {
      expect(lines.filter((line) => line.startsWith(`start test "${name}"`))).toHaveLength(1);
    }
    const saved = yield* journals(artifacts);
    expect(fileNames(saved)).toEqual(["child-1.jsonl", "root-1.jsonl"]);
  });

  it("reports a test whose teardown fails only after that teardown has joined", function* () {
    const directory = yield* useProject({
      "suite.test.md": doc(
        '<Test name="tears down">',
        '<HeldTeardown started="teardown-started" release="release-teardown" />',
        "<Assert expr={true} />",
        "</Test>",
        "",
        '<Test name="later"><Assert expr={true} /></Test>',
      ),
    });
    const artifacts = join(directory, "artifacts");
    const run = yield* launch(directory, ["suite.test.md", "--include", FIXTURES], artifacts);
    const started = yield* timebox(RUN_TIMEOUT, function* () {
      while (!(yield* exists(join(directory, "teardown-started")))) {
        yield* sleep(20);
      }
    });
    expect(started.timeout).toBe(false);
    expect(progress(run.stderr()).filter((line) => /^(pass|fail) test/.test(line))).toEqual([]);
    yield* writeTextFile(join(directory, "release-teardown"), "");
    const status = yield* run.join();
    expect(status.code).toBe(1);
    const lines = progress(run.stderr());
    expect(lines.filter((line) => /^(pass|fail) test/.test(line))).toEqual([
      'fail test "tears down" at suite.test.md:1:1 (teardown)',
      'pass test "later" at suite.test.md:6:1',
    ]);
    expect(lines).toContain('start test "later" at suite.test.md:6:1');
  });

  it("names elements and nested children without printing captured or rendered content", function* () {
    const directory = yield* useProject({
      "child.md": doc(
        '<Let as="hidden">canary-child-let</Let>',
        "",
        "```sh exec",
        "echo canary-child-output",
        "```",
        "",
        "<Slice length={3}>canary-child-slice</Slice>",
      ),
      "suite.test.md": doc(
        '<Test name="private">',
        '<Let as="captured">canary-let-content</Let>',
        "",
        '```sh exec as="probe"',
        "echo canary-exec-output",
        "```",
        "",
        "<Slice length={3}>canary-slice-text</Slice>",
        "",
        '<Execution host="run" target="./child.md" props={{}} as="child">',
        "<AssertEquals actual={child.result.ok} expected={true} />",
        "</Execution>",
        '<AssertEquals actual={captured} expected={"canary-let-content"} />',
        "</Test>",
      ),
    });
    const artifacts = join(directory, "artifacts");
    const result = yield* runTest(directory, ["suite.test.md"], artifacts);
    expect(result.code).toBe(0);
    for (const canary of [
      "canary-child-output",
      "canary-child-let",
      "canary-let-content",
      "canary-exec-output",
      "canary-slice-text",
      "canary-child-slice",
      "echo",
    ]) {
      expect(result.stderr).not.toContain(canary);
    }
    // The rendered report keeps its own owners: the slice's window and the
    // assertion's report, and nothing a capture or a transformation kept private.
    expect(result.stdout).toContain("code points [0, 3) of 17");
    expect(result.stdout).toContain('expected: "canary-let-content"');
    expect(result.stdout).not.toContain("canary-slice-text");
    expect(result.stdout).not.toContain("canary-child-let");
    const lines = progress(result.stderr);
    expect(lines).toContain("start sh exec as at suite.test.md:4:1");
    expect(lines).toContain("start Slice at suite.test.md:8:1");
    expect(lines).toContain("start Execution at suite.test.md:10:1");
    expect(lines).toContain("child 1 ./child.md: start sh exec at ./child.md:3:1");
    expect(lines).toContain("child 1 ./child.md: done Slice at ./child.md:7:1");
    expect(lines.at(-1)).toBe('pass test "private" at suite.test.md:1:1');
  });

  it("keeps delivered progress and saves a partial journal when the run is cancelled", function* () {
    const directory = yield* useProject({
      "suite.test.md": doc('<Test name="cancelled">', "", ...gate("never-created"), "", "</Test>"),
    });
    const artifacts = join(directory, "artifacts");
    const run = yield* launch(directory, ["suite.test.md"], artifacts);
    yield* run.waitFor("start sh exec at suite.test.md:3:1");
    process.kill(run.pid, "SIGINT");
    yield* run.join();
    const lines = progress(run.stderr());
    expect(lines.slice(0, 2)).toEqual([
      'start test "cancelled" at suite.test.md:1:1',
      "start sh exec at suite.test.md:3:1",
    ]);
    expect(lines).toContain("cancelled sh exec at suite.test.md:3:1");
    const saved = yield* journals(artifacts);
    expect(fileNames(saved)).toEqual(["root-1.jsonl"]);
    const [events] = [...saved.values()];
    expect(events!.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toMatch(/^journal saved: .*root-1\.jsonl \(root 1 suite\.test\.md\)$/);
    const delivered = run.stderr();
    yield* sleep(200);
    expect(run.stderr()).toBe(delivered);
  });
});
