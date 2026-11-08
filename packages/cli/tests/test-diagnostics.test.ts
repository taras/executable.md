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
    `: > ${file}.waiting; while [ ! -f ${file} ]; do sleep 0.05; done`,
    "```",
  ];
}

function* arrived(directory: string, file: string): Operation<void> {
  const waited = yield* timebox(RUN_TIMEOUT, function* () {
    while (!(yield* exists(join(directory, file)))) {
      yield* sleep(20);
    }
  });
  if (waited.timeout) {
    throw new Error(`${file} was never created in ${directory}`);
  }
}

const FAILING_CHILD = '<Fail message="nested-journal-failure" />\n';

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
  it("keeps interruption ownership when named tests repeat one authored location", function* () {
    const directory = yield* useProject({
      "suite.test.md": doc(
        '<Each in={["before", "interrupted", "after"]} let="variant">',
        '<Test name={variant} timeout="1s">',
        '<If condition={variant === "interrupted"}>',
        ...gate("never-created"),
        "</If>",
        "</Test>",
        "</Each>",
      ),
    });
    const artifacts = join(directory, "artifacts");
    const run = yield* launch(directory, ["suite.test.md"], artifacts);
    yield* arrived(directory, "never-created.waiting");
    const status = yield* run.join();
    expect(status.code).toBe(1);
    const lines = progress(run.stderr());
    expect(lines.filter((line) => /^(pass|fail) test/.test(line))).toEqual([
      'pass test "before" at suite.test.md:2:1',
      'fail test "interrupted" at suite.test.md:2:1 (timeout; interrupted sh exec at suite.test.md:4:1)',
      'pass test "after" at suite.test.md:2:1',
    ]);
    expect(lines).not.toContain("cancelled sh exec at suite.test.md:4:1");
    expect(lines).not.toContain("start sh exec at suite.test.md:4:1");
    expect(lines.indexOf('start test "interrupted" at suite.test.md:2:1')).toBeLessThan(
      lines.indexOf('pass test "before" at suite.test.md:2:1'),
    );
    const saved = yield* journals(artifacts);
    expect(fileNames(saved)).toEqual(["root-1.jsonl"]);
    const records = [...saved.values()]
      .flat()
      .flatMap((event) =>
        event.type === "yield" &&
        event.description.type === "test_result" &&
        event.result.status === "ok"
          ? [event.result.value]
          : [],
      );
    expect(records).toEqual([
      { name: "before", location: "suite.test.md:2:1", status: "pass" },
      {
        name: "interrupted",
        location: "suite.test.md:2:1",
        status: "fail",
        error: { kind: "timeout", message: "test timed out after 1 seconds" },
      },
      { name: "after", location: "suite.test.md:2:1", status: "pass" },
    ]);
  });

  it("reports a waiting test before release without ordinary operation chatter", function* () {
    const directory = yield* useProject({
      "suite.test.md": doc('<Test name="held">', "", ...gate("release"), "", "</Test>"),
    });
    const artifacts = join(directory, "artifacts");
    const run = yield* launch(directory, ["suite.test.md"], artifacts);
    yield* arrived(directory, "release.waiting");
    yield* run.waitFor('start test "held" at suite.test.md:1:1');
    expect(progress(run.stderr())).toEqual(['start test "held" at suite.test.md:1:1']);
    yield* writeTextFile(join(directory, "release"), "");
    const status = yield* run.join();
    expect(status.code).toBe(0);
    expect(progress(run.stderr())).toEqual([
      'start test "held" at suite.test.md:1:1',
      'pass test "held" at suite.test.md:1:1',
    ]);
    expect(yield* exists(artifacts)).toBe(false);
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
    expect(lines).toContain("start Execution at suite.test.md:10:1");
    expect(lines).toContain("cancelled Execution at suite.test.md:10:1");
    expect(
      lines.some((line) =>
        /^journal saved: .*child-1\.jsonl \(child 1 \.\/waits\.md\)$/.test(line),
      ),
    ).toBe(true);
    expect(
      lines.filter((line) => /^(start|done|failed|cancelled) (?!test\b|Execution\b)/.test(line)),
    ).toEqual([]);
    expect(lines.some((line) => line.startsWith("child "))).toBe(false);
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
    yield* arrived(directory, "teardown-started");
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

  it("reports accepted Executions without ordinary chatter or declaration scan failures", function* () {
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
        '<Execution host="run" target="./child.md" as="blockChild">',
        "",
        "```sh exec",
        "true",
        "```",
        "",
        "</Execution>",
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
    expect(progress(result.stderr)).toEqual([
      'start test "private" at suite.test.md:1:1',
      "start Execution at suite.test.md:10:1",
      "done Execution at suite.test.md:10:1",
      "start Execution at suite.test.md:14:1",
      "done Execution at suite.test.md:14:1",
      'pass test "private" at suite.test.md:1:1',
    ]);
    expect(yield* exists(artifacts)).toBe(false);
  });

  it("keeps delivered progress and saves a partial journal when the run is cancelled", function* () {
    const directory = yield* useProject({
      "suite.test.md": doc('<Test name="cancelled">', "", ...gate("never-created"), "", "</Test>"),
    });
    const artifacts = join(directory, "artifacts");
    const run = yield* launch(directory, ["suite.test.md"], artifacts);
    yield* arrived(directory, "never-created.waiting");
    yield* run.waitFor('start test "cancelled" at suite.test.md:1:1');
    process.kill(run.pid, "SIGINT");
    yield* run.join();
    const lines = progress(run.stderr());
    expect(lines.slice(0, 2)).toEqual([
      'start test "cancelled" at suite.test.md:1:1',
      'cancelled test "cancelled" at suite.test.md:1:1 (interrupted sh exec at suite.test.md:3:1)',
    ]);
    expect(lines.filter((line) => /^(pass|fail) test/.test(line))).toEqual([]);
    const saved = yield* journals(artifacts);
    expect(fileNames(saved)).toEqual(["root-1.jsonl"]);
    const [events] = [...saved.values()];
    expect(events!.length).toBeGreaterThan(0);
    expect(
      events!.some((event) => event.type === "yield" && event.description.type === "test_result"),
    ).toBe(false);
    expect(lines.at(-1)).toMatch(/^journal saved: .*root-1\.jsonl \(root 1 suite\.test\.md\)$/);
    const delivered = run.stderr();
    yield* sleep(200);
    expect(run.stderr()).toBe(delivered);
  });
});
