/**
 * Tier TV — TestAgent vocabulary tests (specs/test-agent-spec.md
 * acceptance §1): session guard, mappings, per-test isolation, mismatch
 * failing the owning test, pre-matcher validation, and the inline-only
 * eval and Markdown-only dependency rules.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execute, installAgentVocabulary } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { installTestingVocabulary, useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { installTestAgentVocabulary } from "../src/vocabulary.ts";

const CLI = path.resolve("packages/cli/src/cli.ts");
const WORKER = ["deno", "run", "--allow-all", CLI, "test-agent"];

interface Run {
  result: Result<string>;
  output: string;
  results: readonly TestResult[];
}

function* runDoc(files: Record<string, string>, options?: { session?: boolean }): Operation<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xmd-tv-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return yield* scoped(function* () {
      let testing;
      if (options?.session === false) {
        yield* installTestingVocabulary();
      } else {
        testing = yield* useTesting();
      }
      yield* installTestAgentVocabulary({ workerCommand: WORKER });
      yield* installAgentVocabulary();
      const execution = yield* execute({
        docPath: path.join(dir, "doc.md"),
        stream: new InMemoryStream(),
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      const result = yield* execution;
      const results = testing ? yield* testing.results : [];
      return { result, output: next.value, results };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HI = '<WhenPrompt template="hi" />\n\nhello there\n';

describe("Tier TV — TestAgent vocabulary", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("TV1: <TestAgent> outside an active testing session is a configuration error", function* () {
    const run = yield* runDoc(
      { "doc.md": "<TestAgent>\nbody\n</TestAgent>\n" },
      { session: false },
    );
    expect(run.output).toContain("valid only in an active testing session");
  });

  it("TV2: missing and duplicate mappings fail the owning test before the turn", function* () {
    const run = yield* runDoc({
      "agents/hi.md": HI,
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario session="dup" src="./agents/hi.md" />',
        '  <TestAgent.Scenario session="dup" src="./agents/hi.md" />',
        '  <Test name="missing mapping">',
        '    <Prompt prompt="hi" session="unmapped" />',
        "  </Test>",
        '  <Test name="duplicate mapping">',
        '    <Prompt prompt="hi" session="dup" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["fail", "fail"]);
    expect(run.output).toContain("no <TestAgent.Scenario> maps agent");
    expect(run.output).toContain("duplicate <TestAgent.Scenario> mappings");
  });

  it("TV3: each <Test> gets fresh state; a mismatch fails only its owning test", function* () {
    const run = yield* runDoc({
      "agents/hi.md": HI,
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/hi.md" />',
        '  <Test name="wrong prompt fails">',
        '    <Prompt prompt="wrong" />',
        "  </Test>",
        '  <Test name="fresh instance passes">',
        '    <Prompt prompt="hi" as="reply" />',
        '    <AssertStringIncludes actual={reply} expected="hello there" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["fail", "pass"]);
    expect(run.output).toContain("expected template: hi");
    expect(run.output).toContain("actual prompt: wrong");
  });

  it("TV4: non-whitespace pre-matcher output and eval imports are configuration failures", function* () {
    const preMatcher = yield* runDoc({
      "agents/bad.md": 'leading text\n\n<WhenPrompt template="hi" />\nok\n',
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/bad.md" />',
        '  <Test name="pre-matcher output">',
        '    <Prompt prompt="hi" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(preMatcher.results.map((entry) => entry.status)).toEqual(["fail"]);

    const dynamicImport = yield* runDoc({
      "agents/dyn.md": [
        '<WhenPrompt template="hi" />',
        "",
        "```js eval",
        'const mod = yield* until(import("node:fs"));',
        "return String(typeof mod);",
        "```",
        "",
      ].join("\n"),
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/dyn.md" />',
        '  <Test name="dynamic import rejected">',
        '    <Prompt prompt="hi" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(dynamicImport.results.map((entry) => entry.status)).toEqual(["fail"]);
  });

  it("TV5: Markdown components resolve beneath the scenario dir; .ts candidates are unsupported", function* () {
    const markdown = yield* runDoc({
      "agents/components/Greeting.md": "greetings from a component\n",
      "agents/doc-behavior.md": '<WhenPrompt template="hi" />\n\n<Greeting />\n',
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/doc-behavior.md" />',
        '  <Test name="markdown dependency">',
        '    <Prompt prompt="hi" as="reply" />',
        '    <AssertStringIncludes actual={reply} expected="greetings from a component" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(markdown.results.map((entry) => entry.status)).toEqual(["pass"]);

    const typescript = yield* runDoc({
      "agents/components/Helper.ts": 'export default function* () { return "nope"; }\n',
      "agents/ts-behavior.md": '<WhenPrompt template="hi" />\n\n<Helper />\n',
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/ts-behavior.md" />',
        '  <Test name="typescript dependency">',
        '    <Prompt prompt="hi" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(typescript.results.map((entry) => entry.status)).toEqual(["fail"]);
  });
});
