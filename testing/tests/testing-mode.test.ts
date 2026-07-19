import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { sleep } from "effection";
import { API } from "@executablemd/runtime";
import { useFailingExec } from "@executablemd/runtime/test";
import { runDocument } from "@executablemd/core";
import { TestFailureError } from "../src/test-api.ts";
import { createTestHandlers } from "../src/handlers.ts";
import { createExecuteDocument } from "../src/execute.ts";
import { failureOf, runDoc } from "./helpers.ts";

describe("testing mode", () => {
  it("skips <Test> entirely during regular execution", function* () {
    const execCalls: string[] = [];
    yield* API.Process.around({
      // deno-lint-ignore require-yield
      *exec([options], _next) {
        execCalls.push(options.command.join(" "));
        return { exitCode: 0, stdout: "ran\n", stderr: "" };
      },
    });
    const doc = [
      "before",
      "<Test>",
      "```bash exec",
      "echo hi",
      "```",
      "test body text",
      "</Test>",
      "after",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.output).toContain("before");
    expect(run.output).toContain("after");
    expect(run.output).not.toContain("test body text");
    expect(execCalls).toEqual([]);
    expect(run.results).toEqual([]);
  });

  it("explicit <Testing> runs its subtree during a regular run", function* () {
    const doc = '<Testing><Test name="t"><Assert expr={true} /></Test></Testing>\n';
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((r) => [r.name, r.status])).toEqual([["t", "pass"]]);
    expect(run.boundaries).toEqual([{ tests: 1, failed: 0 }]);
  });

  it("a failing <Testing> boundary rejects an ordinary run", function* () {
    const doc = "<Testing><Test><Assert expr={false} /></Test></Testing>\n";
    const run = yield* runDoc({ "README.md": doc });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.output).toContain("Test");
  });

  it("an empty <Testing> boundary rejects an ordinary run", function* () {
    const run = yield* runDoc({ "README.md": "<Testing>no tests here</Testing>\n" });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.boundaries).toEqual([{ tests: 0, failed: 0 }]);
  });

  it("root activation runs tests without <Testing>", function* () {
    const doc = '<Test name="rooted"><Assert expr={true} /></Test>\n';
    const run = yield* runDoc({ "README.md": doc }, { testing: true });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((r) => [r.name, r.status])).toEqual([["rooted", "pass"]]);
  });

  it("root activation with zero tests fails", function* () {
    const run = yield* runDoc({ "README.md": "just text\n" }, { testing: true });
    const error = failureOf(run);
    expect(error).toBeInstanceOf(TestFailureError);
    expect(error?.message).toContain("no tests were discovered");
  });

  it("nested <Testing> delegates results outward", function* () {
    const doc = [
      "<Testing>",
      "<Testing><Test><Assert expr={true} /></Test></Testing>",
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    // Inner boundary reports first; the outer boundary sees the delegated
    // result, so neither boundary is empty.
    expect(run.boundaries).toEqual([
      { tests: 1, failed: 0 },
      { tests: 1, failed: 0 },
    ]);
    expect(run.results).toHaveLength(1);
  });

  it("a failing exec block fails the test; later tests run", function* () {
    yield* useFailingExec(3, "command exploded");
    const doc = [
      "<Testing>",
      '<Test name="broken">',
      "```bash exec",
      "false",
      "```",
      "</Test>",
      '<Test name="fine"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["broken", "fail", "error"],
      ["fine", "pass", undefined],
    ]);
  });

  it("an unresolvable component import fails the test; later tests run", function* () {
    const doc = [
      "<Testing>",
      '<Test name="missing"><NoSuchComponent /></Test>',
      '<Test name="fine"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["missing", "fail", "error"],
      ["fine", "pass", undefined],
    ]);
  });

  it("nested <Test> fails the enclosing test; later tests run", function* () {
    const doc = [
      "<Testing>",
      '<Test name="outer"><Test name="inner"><Assert expr={true} /></Test></Test>',
      '<Test name="fine"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["outer", "fail", "error"],
      ["fine", "pass", undefined],
    ]);
    expect(run.results[0]?.error?.message).toContain("Nested <Test>");
  });

  it("an error raised inside a component-owned <Output> region fails the test", function* () {
    const comp = "<Output>\nregion start\n<NoSuchThing />\n</Output>\n";
    const doc = [
      "<Testing>",
      '<Test name="output-region"><Regioned /></Test>',
      '<Test name="fine"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc, "components/Regioned.md": comp });
    expect(run.results.map((r) => [r.name, r.status])).toEqual([
      ["output-region", "fail"],
      ["fine", "pass"],
    ]);
  });

  it("a completed failing test inside a documentation region stays contained", function* () {
    const comp = "<Output>\n<Content />\n</Output>\n";
    const doc = [
      "<Testing><Regioned>",
      '<Test name="contained"><Assert expr={false} /></Test>',
      "</Regioned></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc, "components/Regioned.md": comp });
    // The document expands fully — the failure surfaces as a testing
    // outcome, not an expansion abort.
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.results.map((r) => [r.name, r.status])).toEqual([["contained", "fail"]]);
  });

  it("bindings written in one test are invisible to the next", function* () {
    const doc = [
      "```js eval",
      "const inherited = 7;",
      "```",
      "<Testing>",
      '<Test name="writer">',
      "```js eval",
      "const leak = 1;",
      "```",
      '<Capture as="cap">captured</Capture>',
      "<AssertEquals actual={inherited} expected={7} />",
      "</Test>",
      '<Test name="reader">',
      '<Assert expr={typeof leak === "undefined" && typeof cap === "undefined"} />',
      "<AssertEquals actual={inherited} expected={7} />",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((r) => r.status)).toEqual(["pass", "pass"]);
  });

  it("captures persist for the immediately following assertion", function* () {
    const doc = [
      "<Testing><Test>",
      '<Capture as="result">Hello World</Capture>',
      '<AssertEquals actual={result} expected={"Hello World"} />',
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((r) => r.status)).toEqual(["pass"]);
  });

  it("effects spawned in one test are torn down before the next begins", function* () {
    const globalValues = globalThis as Record<string, unknown>;
    delete globalValues.__testingLeaseAlive;
    const doc = [
      "<Testing>",
      '<Test name="spawner">',
      "```js persist eval",
      "globalThis.__testingLeaseAlive = true;",
      "yield* spawn(function* () { try { yield* suspend(); } finally { globalThis.__testingLeaseAlive = false; } });",
      "```",
      "<Assert expr={globalThis.__testingLeaseAlive === true} />",
      "</Test>",
      '<Test name="observer">',
      "<Assert expr={globalThis.__testingLeaseAlive === false} />",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((r) => [r.name, r.status])).toEqual([
      ["spawner", "pass"],
      ["observer", "pass"],
    ]);
  });

  it("output before a failure is kept, followed by the diagnostic", function* () {
    const doc = [
      "<Testing><Test>",
      "first line",
      "<Assert expr={false} />",
      "never rendered",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.output).toContain("first line");
    expect(run.output).toContain("**Assert** failed");
    expect(run.output).not.toContain("never rendered");
    const firstAt = run.output.indexOf("first line");
    const diagnosticAt = run.output.indexOf("**Assert** failed");
    expect(firstAt).toBeLessThan(diagnosticAt);
  });

  it("a hanging test times out, is torn down, and later tests run", function* () {
    yield* API.Process.around({
      *exec(_args, _next) {
        yield* sleep(10_000);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const execute = createExecuteDocument({
      runDocument,
      handlers: createTestHandlers({ timeoutMs: 100 }),
    });
    const doc = [
      "<Testing>",
      '<Test name="hangs">',
      "```bash exec",
      "sleep 60",
      "```",
      "</Test>",
      '<Test name="fine"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc }, { execute });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["hangs", "fail", "timeout"],
      ["fine", "pass", undefined],
    ]);
  });

  it("unnamed tests are identified by source location", function* () {
    const doc = [
      "---",
      "title: Located",
      "---",
      "<Testing>",
      "<Test><Assert expr={false} /></Test>",
      "</Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.results[0]?.location).toBe("README.md:5:1");
    expect(run.output).toContain("test at README.md:5:1");
  });
});
