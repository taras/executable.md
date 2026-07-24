/**
 * Tier TV — TestAgent vocabulary tests (specs/test-agent-spec.md
 * acceptance §1): session guard, default/named mappings, per-test and
 * cwd isolation, mismatch failing the owning test, declaration
 * snapshots, pre-matcher validation, inline-only eval, Markdown-only
 * dependencies with TypeScript precedence/fallback, exhaustion, and
 * clean suspended teardown.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute, installAgentVocabulary } from "@executablemd/core";
import { API } from "@executablemd/runtime";
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

interface RunOptions {
  session?: boolean;
  /** Mutable contextual cwd served to the document. */
  cwdRef?: { value: string; flipTo: string };
}

function* runDoc(files: Record<string, string>, options?: RunOptions): Operation<Run> {
  const dir = path.join(os.tmpdir(), `xmd-tv-${randomUUID()}`);
  yield* ensureDir(dir);
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      yield* ensureDir(path.dirname(target));
      yield* writeTextFile(target, content.replaceAll("__DIR__", dir));
    }
    return yield* scoped(function* () {
      const cwdRef = options?.cwdRef;
      if (cwdRef) {
        yield* API.Env.around({
          // deno-lint-ignore require-yield
          *cwd() {
            return cwdRef.value;
          },
        });
        // The flip-cwd exec hook lets a document switch the contextual
        // cwd between prompts without touching the real system.
        yield* API.Process.around({
          *exec([execOptions], next) {
            if (execOptions.command.join(" ").includes("flip-cwd")) {
              cwdRef.value = cwdRef.flipTo;
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            return yield* next(execOptions);
          },
        });
      }
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
    yield* rm(dir, { recursive: true, force: true });
  }
}

const HI = '<WhenPrompt template="hi" />\n\nhello there\n';
const TWO_STAGES =
  '<WhenPrompt template="one" />\n\nfirst\n\n<WhenPrompt template="two" />\n\nsecond\n';

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

    const staticImport = yield* runDoc({
      "agents/static.md": [
        '<WhenPrompt template="hi" />',
        "",
        "```js eval",
        'import { readFileSync } from "node:fs";',
        "return String(typeof readFileSync);",
        "```",
        "",
      ].join("\n"),
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/static.md" />',
        '  <Test name="static import rejected">',
        '    <Prompt prompt="hi" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(staticImport.results.map((entry) => entry.status)).toEqual(["fail"]);

    const whitespaceOnly = yield* runDoc({
      "agents/ws.md": "\n   \n\t\n" + HI,
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/ws.md" />',
        '  <Test name="whitespace preamble is allowed">',
        '    <Prompt prompt="hi" as="reply" />',
        '    <AssertStringIncludes actual={reply} expected="hello there" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(whitespaceOnly.results.map((entry) => entry.status)).toEqual(["pass"]);
  });

  it("TV5: Markdown wins over TypeScript; missing .ts falls back; existing .ts is unsupported", function* () {
    const precedence = yield* runDoc({
      "agents/components/Greeting.md": "markdown wins\n",
      "agents/components/Greeting.ts": 'export default function* () { return "ts"; }\n',
      "agents/components/Nested/index.md": "index fallback\n",
      "agents/both.md": '<WhenPrompt template="hi" />\n\n<Greeting />\n<Nested />\n',
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/both.md" />',
        '  <Test name="precedence and fallback">',
        '    <Prompt prompt="hi" as="reply" />',
        '    <AssertStringIncludes actual={reply} expected="markdown wins" />',
        '    <AssertStringIncludes actual={reply} expected="index fallback" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(precedence.results.map((entry) => entry.status)).toEqual(["pass"]);

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

  it("TV6: default and named mappings resolve; the agent prop registers additional agents", function* () {
    const run = yield* runDoc({
      "agents/default.md": '<WhenPrompt template="d" />\n\ndefault-reply\n',
      "agents/named.md": '<WhenPrompt template="n" />\n\nnamed-reply\n',
      "agents/extra.md": '<WhenPrompt template="x" />\n\nextra-reply\n',
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/default.md" />',
        '  <TestAgent.Scenario session="named" src="./agents/named.md" />',
        '  <TestAgent.Scenario agent="extra" src="./agents/extra.md" />',
        '  <Test name="mappings">',
        '    <Prompt prompt="d" as="d" />',
        '    <Prompt prompt="n" session="named" as="n" />',
        '    <Prompt prompt="x" agent="extra" as="x" />',
        '    <AssertStringIncludes actual={d} expected="default-reply" />',
        '    <AssertStringIncludes actual={n} expected="named-reply" />',
        '    <AssertStringIncludes actual={x} expected="extra-reply" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
  });

  it("TV7: different working directories get independent scenario instances", function* () {
    const cwdRef = { value: path.resolve("."), flipTo: os.tmpdir() };
    const run = yield* runDoc(
      {
        "agents/hi.md": HI,
        "doc.md": [
          "<TestAgent>",
          '  <TestAgent.Scenario src="./agents/hi.md" />',
          '  <Test name="cwd isolation">',
          '    <Prompt prompt="hi" as="first" />',
          "",
          "```bash exec silent",
          "flip-cwd",
          "```",
          "",
          '    <Prompt prompt="hi" as="second" />',
          '    <AssertStringIncludes actual={first} expected="hello there" />',
          '    <AssertStringIncludes actual={second} expected="hello there" />',
          "  </Test>",
          "</TestAgent>",
          "",
        ].join("\n"),
      },
      { cwdRef },
    );
    // The same stage-1 prompt matched twice: the flipped cwd allocated a
    // fresh instance instead of reusing (and exhausting) the first one.
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
  });

  it("TV8: exhaustion fails the owning test; a suspended scenario tears down cleanly", function* () {
    const run = yield* runDoc({
      "agents/hi.md": HI,
      "agents/two.md": TWO_STAGES,
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/hi.md" />',
        '  <TestAgent.Scenario session="partial" src="./agents/two.md" />',
        '  <Test name="exhausted">',
        '    <Prompt prompt="hi" />',
        '    <Prompt prompt="hi again" />',
        "  </Test>",
        '  <Test name="suspended mid-scenario">',
        '    <Prompt prompt="one" session="partial" as="reply" />',
        '    <AssertStringIncludes actual={reply} expected="first" />',
        "  </Test>",
        "</TestAgent>",
        "",
        "after the agent scope",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["fail", "pass"]);
    expect(run.output).toContain("scenario exhausted");
    // Clean teardown: the suspended second scenario did not fail the
    // document, and content after the boundary still rendered.
    expect(run.output).toContain("after the agent scope");
    expect(run.result.ok).toBe(false);
  });

  it("TV9: the behavior document executes from the declaration snapshot", function* () {
    const dirToken = `xmd-snap-${randomUUID()}`;
    const run = yield* runDoc({
      "agents/hi.md": HI,
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/hi.md" />',
        "",
        "```bash exec silent",
        `rm __DIR__/agents/hi.md || true # ${dirToken}`,
        "```",
        "",
        '  <Test name="snapshot survives source removal">',
        '    <Prompt prompt="hi" as="reply" />',
        '    <AssertStringIncludes actual={reply} expected="hello there" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
  });
});
