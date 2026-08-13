/**
 * Tier TV — <TestAgent> component tests (specs/test-agent-spec.md
 * acceptance §1): scenario mapping, per-<Test> and per-cwd isolation,
 * captures and constraints, failure propagation to the owning test, and
 * clean suspension at teardown — driven through the component surface
 * with real workers.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "@executablemd/core";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { Component, execute, installAgentComponents } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { installTestingComponents, useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { installTestAgentComponents } from "../src/components.ts";
import { useCommand } from "./command.ts";
import { cliBase } from "@executablemd/test-support/launch";
import type { Json } from "@executablemd/core";

const WORKER = cliBase();

interface Run {
  result: Result<Json>;
  output: string;
  results: readonly TestResult[];
}

interface RunOptions {
  session?: boolean;
  /**
   * Search these for repository components, relative to the fixture directory.
   * The default dirs resolve against the process cwd, not the temp project, so
   * a fixture component is invisible without this.
   */
  componentDirs?: string[];
  /** Mutable contextual cwd served to the document. */
  cwdRef?: { value: string; flipTo: string };
}

function* runDoc(files: Record<string, string>, options?: RunOptions): Operation<Run> {
  const dir = path.join(os.tmpdir(), `xmd-tv-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      yield* ensureDir(path.dirname(target));
      yield* writeTextFile(target, content.replaceAll("__DIR__", dir));
    }
    // The scope closes before the fixtures are removed, so workers and
    // controllers finish teardown while their scenario files still exist.
    return yield* scoped(function* () {
      const cwdRef = options?.cwdRef;
      if (cwdRef) {
        yield* API.Env.around({
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
        yield* installTestingComponents();
      } else {
        testing = yield* useTesting();
      }
      yield* useCommand(WORKER);
      yield* installTestAgentComponents();
      yield* installAgentComponents();
      const execution = yield* execute({
        path: path.join(dir, "doc.md"),
        stream: new InMemoryStream(),
        ...(options?.componentDirs
          ? { componentDirs: options.componentDirs.map((d) => path.join(dir, d)) }
          : {}),
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
  });
}

const HI = '<WhenPrompt template="hi" />\n\nhello there\n';
const TWO_STAGES =
  '<WhenPrompt template="one" />\n\nfirst\n\n<WhenPrompt template="two" />\n\nsecond\n';

describe("Tier TV — TestAgent components", { sanitizeOps: false, sanitizeResources: false }, () => {
  beforeAll(() => useTempFileCompiler());
  it("TV1: <TestAgent> outside an active testing session is a configuration error", function* () {
    const run = yield* runDoc(
      { "doc.md": "<TestAgent>\nbody\n</TestAgent>\n" },
      { session: false },
    );
    // Nothing recovers the configuration error, so it is the run's outcome.
    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(
      "valid only in an active testing session",
    );
  });

  it("TV12: a configuration diagnostic is observed once and rendered once", function* () {
    const observed: string[] = [];
    yield* Component.around({
      *raise([error], next) {
        observed.push(error.message);
        return yield* next(error);
      },
    });
    // Written in a region that prints: what this pins is that the diagnostic
    // is observed once and rendered once, which needs it rendered.
    const run = yield* runDoc(
      { "doc.md": "<PrintErrors>\n<TestAgent>\nbody\n</TestAgent>\n</PrintErrors>\n" },
      { session: false },
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain("valid only in an active testing session");
    expect(run.output.match(/valid only in an active testing session/g)).toHaveLength(1);
  });

  it("TV2: missing and duplicate mappings fail the owning test before the turn", function* () {
    const run = yield* runDoc({
      "agents/hi.md": HI,
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario session="dup" src="./agents/hi.md" />',
        '  <TestAgent.Scenario session="dup" src="./agents/hi.md" />',
        '  <Test name="missing mapping">',
        '    <Prompt text="hi" session="unmapped" />',
        "  </Test>",
        '  <Test name="duplicate mapping">',
        '    <Prompt text="hi" session="dup" />',
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
        '    <Prompt text="wrong" />',
        "  </Test>",
        '  <Test name="fresh scenario passes">',
        '    <Prompt text="hi" as="reply" />',
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
        '    <Prompt text="hi" />',
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
        '    <Prompt text="hi" />',
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
        '    <Prompt text="hi" />',
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
        '    <Prompt text="hi" as="reply" />',
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
        '    <Prompt text="hi" as="reply" />',
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
        '    <Prompt text="hi" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(typescript.results.map((entry) => entry.status)).toEqual(["fail"]);
  });

  it("TV6: default and named mappings resolve; the agent prop registers additional agents", function* () {
    // One <Test> per mapping: each prompt spawns a worker, and under Node a
    // spawn costs enough that three inside one <Test> brush the fixed
    // 20-second test timeout on a loaded runner (#332). Splitting keeps every
    // test far from the deadline and names the mapping that failed.
    const run = yield* runDoc({
      "agents/default.md": '<WhenPrompt template="d" />\n\ndefault-reply\n',
      "agents/named.md": '<WhenPrompt template="n" />\n\nnamed-reply\n',
      "agents/extra.md": '<WhenPrompt template="x" />\n\nextra-reply\n',
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario src="./agents/default.md" />',
        '  <TestAgent.Scenario session="named" src="./agents/named.md" />',
        '  <TestAgent.Scenario agent="extra" src="./agents/extra.md" />',
        '  <Test name="default mapping">',
        '    <Prompt text="d" as="d" />',
        '    <AssertStringIncludes actual={d} expected="default-reply" />',
        "  </Test>",
        '  <Test name="named mapping">',
        '    <Prompt text="n" session="named" as="n" />',
        '    <AssertStringIncludes actual={n} expected="named-reply" />',
        "  </Test>",
        '  <Test name="agent prop mapping">',
        '    <Prompt text="x" agent="extra" as="x" />',
        '    <AssertStringIncludes actual={x} expected="extra-reply" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("TV7: different working directories get independent scenario scenarios", function* () {
    const cwdRef = { value: path.resolve("."), flipTo: os.tmpdir() };
    const run = yield* runDoc(
      {
        "agents/hi.md": HI,
        "doc.md": [
          "<TestAgent>",
          '  <TestAgent.Scenario src="./agents/hi.md" />',
          '  <Test name="cwd isolation">',
          '    <Prompt text="hi" as="first" />',
          "",
          "```bash exec silent",
          "flip-cwd",
          "```",
          "",
          '    <Prompt text="hi" as="second" />',
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
    // fresh scenario instead of reusing (and exhausting) the first one.
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
        '    <Prompt text="hi" />',
        '    <Prompt text="hi again" />',
        "  </Test>",
        '  <Test name="suspended mid-scenario">',
        '    <Prompt text="one" session="partial" as="reply" />',
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
        '    <Prompt text="hi" as="reply" />',
        '    <AssertStringIncludes actual={reply} expected="hello there" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
  });

  it("TV10: <Agent>/<Session> pin a resolved session that routes nested prompts", function* () {
    const run = yield* runDoc({
      "agents/two.md": TWO_STAGES,
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario agent="test" session="review" src="./agents/two.md" />',
        '  <Test name="pinned session advances one scenario">',
        '    <Agent name="test">',
        '      <Session name="review">',
        '        <Prompt text="one" as="first" />',
        '        <Prompt text="two" as="second" />',
        "      </Session>",
        "    </Agent>",
        '    <AssertStringIncludes actual={first} expected="first" />',
        '    <AssertStringIncludes actual={second} expected="second" />',
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    // Both prompts routed through the Session object pinned by <Session>
    // to the same scenario, so stage 2 matched after stage 1.
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
  });

  it("TV11: a pinned session is rejected for an agent that did not create it", function* () {
    const run = yield* runDoc({
      "agents/owner.md": '<WhenPrompt template="one" />\n\nowner-reply\n',
      "agents/other.md": '<WhenPrompt template="one" />\n\nother-reply\n',
      "doc.md": [
        "<TestAgent>",
        '  <TestAgent.Scenario agent="test" session="review" src="./agents/owner.md" />',
        '  <TestAgent.Scenario agent="extra" session="review" src="./agents/other.md" />',
        '  <Test name="cross-agent session">',
        '    <Agent name="test">',
        '      <Session name="review">',
        '        <Agent name="extra">',
        '          <Prompt text="one" />',
        "        </Agent>",
        "      </Session>",
        "    </Agent>",
        "  </Test>",
        "</TestAgent>",
        "",
      ].join("\n"),
    });
    expect(run.results.map((entry) => entry.status)).toEqual(["fail"]);
    expect(run.output).toContain('agent "extra" does not match session');
    // Neither agent's scenario advanced: no turn ran on either.
    expect(run.output).not.toContain("owner-reply");
    expect(run.output).not.toContain("other-reply");
  });

  // The regression the scoped() removal fixes: content projected by
  // tryContent() anchors to the invocation, so anything <TestAgent> installs
  // inside a child frame is invisible to its own body. Wrapping the region in
  // scoped() again turns every scenario into "valid only inside <TestAgent>"
  // and every prompt into "Agent.agent() has no provider".
  it("TV13: a scenario in the body sees the session <TestAgent> installed", function* () {
    const run = yield* runDoc({
      "agents/hi.md": HI,
      "doc.md": [
        "<TestAgent>",
        '<TestAgent.Scenario src="./agents/hi.md" />',
        '<Test name="reaches it"><Prompt text="hi" /></Test>',
        "</TestAgent>",
        "",
      ].join("\n"),
    });

    expect(run.output).not.toContain("is valid only inside <TestAgent>");
    expect(run.output).not.toContain("has no provider");
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
  });

  // TC1's analog: a settled diagnostic beside healthy scenarios renders inline
  // and the rest of the body still runs. content() would replace the whole
  // invocation's output with that diagnostic instead. The empty-string src also
  // pins that the component's own check still owns that wording — the schema
  // accepts "" as a string, so only the fn can catch it.
  it("TV14: a scenario diagnostic renders inline beside a healthy one", function* () {
    const run = yield* runDoc({
      "agents/hi.md": HI,
      // The region prints, which is what lets the rest of the body run after
      // the scenario's own diagnostic.
      "doc.md": [
        "<PrintErrors>",
        "<TestAgent>",
        '<TestAgent.Scenario src="" />',
        '<TestAgent.Scenario src="./agents/hi.md" />',
        "BODY TEXT",
        '<Test name="still runs"><Prompt text="hi" /></Test>',
        "</TestAgent>",
        "</PrintErrors>",
        "",
      ].join("\n"),
    });

    expect(run.output).toContain('requires a "src" prop');
    expect(run.output).toContain("BODY TEXT");
    expect(run.results.map((entry) => entry.status)).toEqual(["pass"]);
  });

  // A registration is a default, so a repository component of either name wins.
  // Each fixture declares a props schema: a markdown component without one
  // accepts no props and is rejected before it can answer.
  it("TV15: a repository component overrides either registered name", function* () {
    const withProps = (body: string) =>
      [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    agent: { type: string }",
        "    src: { type: string }",
        "    session: { type: string }",
        "---",
        "",
        body,
        "",
      ].join("\n");

    const agentRun = yield* runDoc(
      {
        "doc.md": "<TestAgent>\nbody\n</TestAgent>\n",
        "components/TestAgent.md": withProps("LOCAL TEST AGENT"),
      },
      { componentDirs: ["components", "."] },
    );
    expect(agentRun.output).toContain("LOCAL TEST AGENT");

    // The dotted name addresses a subdirectory, so the override lives at
    // components/TestAgent/Scenario.md.
    const scenarioRun = yield* runDoc(
      {
        "agents/hi.md": HI,
        "doc.md": [
          "<TestAgent>",
          '<TestAgent.Scenario src="./agents/hi.md" />',
          "</TestAgent>",
          "",
        ].join("\n"),
        "components/TestAgent/Scenario.md": withProps("LOCAL SCENARIO"),
      },
      { componentDirs: ["components", "."] },
    );
    expect(scenarioRun.output).toContain("LOCAL SCENARIO");
  });
});
