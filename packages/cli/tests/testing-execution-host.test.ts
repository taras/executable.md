import { captureHostFilesAccess } from "@executablemd/runtime";
/**
 * The trusted host profile a Markdown test runs a nested execution under
 * (issue #454).
 *
 * `packages/testing/tests/execution-harness.test.ts` holds the harness: which
 * root a target names, when the declarations are installed, what is displayed
 * and what is collected, and who may run a child at all. What it cannot hold is
 * the thing this file is for — that a child gets *production* assembly, the
 * same one `xmd run` gets after its arguments are read — because the testing
 * package must not import the CLI.
 *
 * So this runs `xmd test` on a real project, and the child documents use what
 * only an entrypoint installs: a foreground command, a core default component,
 * and the run host's journal policy.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, ensure, resource, scoped, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { readTextFile, ensureDir, readdir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { until } from "effection";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliBase, cliRuntime, runCli } from "@executablemd/test-support/launch";
import { PLAN_WRITER_INSTRUCTIONS, DEFAULT_PLAN_WRITER_ROOT } from "../src/plan-writer-profile.ts";
import type { PlanWriterObservation } from "../src/plan-writer-profile.ts";
import { testingExecutionHost } from "../src/testing-host.ts";
import { planComponentDeclaration, planComponentDescription } from "../src/plan-component.ts";
import { BUNDLED_PLUGIN } from "../src/run-profile.ts";

function doc(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/** A project on disk, because a child resolves its root the way `xmd run` does. */
function useProject(files: Record<string, string>): Operation<string> {
  return resource<string>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-nested-")));
    yield* ensure(function* () {
      yield* rm(root, { recursive: true, force: true });
    });
    for (const [name, contents] of Object.entries(files)) {
      const path = join(root, name);
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent !== root) {
        yield* ensureDir(parent);
      }
      yield* writeTextFile(path, contents);
    }
    yield* provide(root);
  });
}

const CHILD = doc(
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    who: { type: string }",
  "  required: [who]",
  "  additionalProperties: false",
  "---",
  "",
  "hello {props.who}",
  "",
  "```sh exec",
  'echo "from a command"',
  "```",
);

const GUIDE = doc("# First", "", "first body", "", "# Second", "", "second body");

/** The one request the Plan workflow sends, answered with a complete program. */
const PLAN_BEHAVIOR = doc(
  '<WhenPrompt template="{?lead}Create one complete XMD Plan from this Prompt:{?rest}" />',
  "",
  "<Let",
  '  as="program"',
  "  value={[",
  '    "# Approved program",',
  '    "",',
  '    "Write the evidence file this program names.",',
  '    "",',
  `    '<File path="planned.txt">the approved Plan ran</File>',`,
  '    "",',
  '  ].join("\\n")}',
  "/>",
  "",
  "{program}",
);

/**
 * A turn that produces part of a candidate and then fails.
 *
 * The marker is emitted before the failure, so it is exactly what a `<Prompt>`
 * that rendered whatever a failed turn managed to emit would hand onward. Under
 * the Plan writer policy no such partial reaches the draft check or the review,
 * and the run ends instead.
 */
const PARTIAL_THEN_FAILS = doc(
  '<WhenPrompt template="{?lead}Create one complete XMD Plan from this Prompt:{?rest}" />',
  "",
  "# Half a program",
  "",
  "partialcandidatemarker",
  "",
  '<Fail message="the scripted turn failed after emitting part of a candidate" />',
);

/** An ordinary document that writes a Plan and prints what it bound. */
const PLAN_CHILD = doc(
  "# A document that writes a Plan",
  "",
  '<Plan session="planner" as="approved">Write the release program.</Plan>',
  "",
  "Approved source: {approved}",
);

/**
 * What a child needs to write one: a scripted agent for the turn, and an
 * authored approval for the review.
 *
 * The trusted child host privately connects the authored `planner` label to
 * the opaque conversation identity while the provider keeps that identity.
 */
const PLAN_DECLARATION = [
  "<TestAgent>",
  '<TestAgent.Scenario session="planner" src="./agents/plan.md" />',
  "</TestAgent>",
  "",
  "<Answers>",
  '<Answer value={{ decision: "Approve" }} />',
  "</Answers>",
];

/**
 * What the two Plan authorship trees hold right now.
 *
 * `children` is the temporary directory, filtered to the roots a configured
 * child makes; `production` is the tree a real `xmd plan` keeps its sessions in,
 * read and never written. A tree that does not exist yet holds nothing, which is
 * the ordinary state of the production one on a machine that has never run the
 * command.
 */
function* planRoots(): Operation<{ children: string[]; production: string[] }> {
  return {
    children: (yield* listing(tmpdir())).filter((entry) => entry.startsWith("xmd-child-plan-")),
    production: yield* listing(DEFAULT_PLAN_WRITER_ROOT),
  };
}

function* listing(directory: string): Operation<string[]> {
  try {
    return (yield* readdir(directory)).sort();
  } catch {
    return [];
  }
}

/** A declared child relaunches `xmd` as its agent worker, so it needs both. */
const WORKER = { inheritEnv: true, timeout: 180_000 };

/** A repository component taking one string prop, so shadowing one validates. */
function repositoryComponent(prop: string, marker: string): string {
  return doc(
    "---",
    "props:",
    "  type: object",
    "  properties:",
    `    ${prop}: { type: string }`,
    "  additionalProperties: false",
    "---",
    "",
    marker,
  );
}

describe("nested execution under the production run host", () => {
  it("compiles authored eval in an isolated run child", function* () {
    const project = yield* useProject({
      "child.md": doc(
        "~~~js eval",
        "const answer = 20 + 22;",
        "~~~",
        "",
        "<Output><Json value={answer} /></Output>",
      ),
      "README.md": doc(
        '<Test name="child eval">',
        '<Execution host="run" target="child.md">',
        '<CollectOutput as="output" />',
        '<AssertEquals actual={output.trim()} expected="42" />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect({ code: result.code, output: result.stdout + result.stderr }).toMatchObject({
      code: 0,
    });
  });

  it("runs referenced documents, targets and inline source as real roots", function* () {
    const project = yield* useProject({
      "reports/quarterly-summary.md": CHILD,
      "guide.md": GUIDE,
      "README.md": doc(
        '<Test name="referenced root">',
        '<Execution host="run" target="./reports/quarterly-summary.md" props={{ who: "world" }} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertEquals actual={child.kind} expected="settled" />',
        "<AssertEquals actual={child.result.ok} expected={true} />",
        '<AssertStringIncludes actual={output} expected="hello world" />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="selected target">',
        '<Execution host="run" target="guide.md#Second" as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="second body" />',
        '<AssertEquals actual={output.includes("first body")} expected={false} />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="inline source">',
        '<Execution host="run" source={"from inline source\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="from inline source" />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="diagnostic journal">',
        '<Execution host="run" target="guide.md" as="child">',
        "<DiagnosticJournal />",
        '<CollectJournal as="journal" />',
        "",
        "<AssertEquals actual={journal.length > 0} expected={true} />",
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.code).toBe(0);
    // A foreground command reaches a reader only where the entrypoint installed
    // the process adapter, and a transient child retains none of its bytes — so
    // seeing them here is the child running production assembly and this
    // document displaying what it produced.
    expect(result.stdout + result.stderr).toContain("from a command");
  });

  /**
   * The production run profile's own vocabulary reaches a child.
   *
   * `<Plan>` is packaged Markdown the host declares, not a registration a child
   * inherits — so a child assembled without the declaration resolves the name to
   * nothing and reports a missing component, which reads exactly like a document
   * that wrote a typo. That is the wrong answer twice over: the profile *does*
   * have `<Plan>`, and what a child of `xmd test` actually lacks is a coding
   * agent to write one with.
   *
   * The Prompt is deliberately empty, because that is the phase the Component
   * refuses before any of the authorship it could not perform here: the body
   * renders to nothing, and the failure comes from the Component's own `<Fail>`.
   * So this proves the exact protected bytes resolved and expanded in the child,
   * with no catalog, no session, no directory and no Agent turn behind it.
   */
  it("resolves the packaged <Plan> Component in a run child, and fails at its own first phase", function* () {
    const project = yield* useProject({
      "README.md": doc(
        '<Test name="the run profile has Plan">',
        '<Execution host="run" source={"<Plan as=\\"approved\\">   </Plan>\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertEquals actual={child.kind} expected="settled" />',
        "<AssertEquals actual={child.result.ok} expected={false} />",
        "<AssertStringIncludes",
        "  actual={child.result.error.message}",
        '  expected="<Plan> requires its body to render a non-empty Prompt."',
        "/>",
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.code).toBe(0);
    // The failure the child reported is the Component's, not resolution's. Naming
    // both is what keeps this case from passing on a child that simply failed.
    const printed = result.stdout + result.stderr;
    expect(printed).not.toContain("Cannot resolve component: Plan");
  });

  it("creates no authored file for an inline child", function* () {
    const project = yield* useProject({
      "README.md": doc(
        '<Test name="inline leaves nothing">',
        '<Execution host="run" source={"inline only\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="inline only" />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.code).toBe(0);
    // Inline source is text the child ran under the `<eval>` identity, not a
    // document written down and then read back.
    expect(yield* readdir(project)).toEqual(["README.md"]);
  });

  /**
   * The child resolves component names through what the outer command was
   * given, not through a search path a nested execution decides for itself:
   * `elsewhere` is on no default path, and the child's own document is inline
   * text with no directory of its own.
   */
  it("resolves a child's component only through the outer command's includes", function* () {
    const project = yield* useProject({
      "elsewhere/Greeting.md": doc("hello from the configured include"),
      "README.md": doc(
        '<Test name="nested resolution">',
        '<Execution host="run" source={"<Greeting />\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="hello from the configured include" />',
        "</Execution>",
        "</Test>",
      ),
    });

    const configured = yield* runCli(["test", "README.md", "--include", "elsewhere"], {
      cwd: project,
    }).join();
    expect(configured.code).toBe(0);

    // Without it the child has nowhere to find the name and renders nothing,
    // which is what makes the passing run above evidence that the setting
    // reached the child rather than something the default path supplied.
    const bare = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(bare.code).not.toBe(0);
    expect(bare.stdout + bare.stderr).toContain("1 of 1 tests failed");
  });

  /**
   * A child is a root, so the vocabulary it observes is its own.
   *
   * `<Syntax />` describes the site it is written at, and a child's site is the
   * child run profile with the child's includes — not the outer test's. The
   * positive control is the same document run as the outer root: the name the
   * child cannot see is one the outer include path really does supply, so the
   * absence below is isolation rather than a component nobody has.
   */
  it("gives a nested run child its own catalog rather than the outer root's", function* () {
    const project = yield* useProject({
      "elsewhere/Greeting.md": doc("hello"),
      "catalog.md": doc("<Syntax />"),
      "README.md": doc(
        '<Test name="nested catalog">',
        '<Execution host="run" source={"<Syntax />\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="### `<Syntax>`" />',
        "<AssertNotMatch actual={output} expected={/### `<Greeting>`/} />",
        "</Execution>",
        "</Test>",
      ),
    });

    // The child runs with no include of its own, so the outer command's
    // `--include elsewhere` does not put `<Greeting>` in the child's catalog.
    const nested = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(nested.code).toBe(0);

    // The control: with that include configured, an ordinary root at the same
    // site does observe the name, so the child's catalog above was narrower
    // rather than empty.
    const outer = yield* runCli(["run", "catalog.md", "--include", "elsewhere"], {
      cwd: project,
    }).join();
    expect(outer.code).toBe(0);
    expect(outer.stdout).toContain("### `<Greeting>`");
  });

  it("gives a nested run child the documentation for what it registers", function* () {
    // `<WebForm>` is the web package's, which the run profile registers — so a
    // child that is the run profile can run it, and must be able to explain it.
    // Prose from `packages/web/src/components.md`, not the catalog description
    // an entry already carries: a child whose index held core's contributions
    // alone would render the entry and then say it is undocumented.
    const project = yield* useProject({
      "elsewhere/Greeting.md": doc("hello"),
      // Not `webform.md`: this filesystem is case-insensitive, so a document
      // of that name is found as the repository component `WebForm` and
      // shadows the registration — the fallback would then be correct, and the
      // case would be measuring the wrong thing.
      "lookup.md": doc('<Syntax names={["WebForm"]} />'),
      "README.md": doc(
        '<Test name="nested documentation">',
        '<Execution host="run" source={"<Syntax names={[\\"WebForm\\"]} />\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="### `<WebForm>`" />',
        // Unique to the long-form documentation.
        '<AssertStringIncludes actual={output} expected="anything awkward to type at a" />',
        // And never the fallback, which is what this regression is about.
        "<AssertNotMatch actual={output} expected={/No long-form documentation/} />",
        // The child's own isolation is unchanged: the outer include still does
        // not reach it.
        "<AssertNotMatch actual={output} expected={/### `<Greeting>`/} />",
        "</Execution>",
        "</Test>",
      ),
    });

    const nested = yield* runCli(["test", "README.md", "--include", "elsewhere"], {
      cwd: project,
    }).join();
    expect(nested.code).toBe(0);

    // The ordinary-run control: both profiles read the same owning package's
    // documentation, so the child above is not a special case that happens to
    // agree.
    const ordinary = yield* runCli(["run", "lookup.md"], { cwd: project }).join();
    expect(ordinary.code).toBe(0);
    expect(ordinary.stdout).toContain("### `<WebForm>`");
    expect(ordinary.stdout).toContain("anything awkward to type at a");
    expect(ordinary.stdout).not.toContain("No long-form documentation");
  });

  /**
   * The run profile's read table reaches a child, whichever command hosts it.
   *
   * `host="run"` means the run profile, and the evaluation ceiling is part of
   * it: a child of `xmd test` evaluates a generated fragment under exactly what
   * `xmd run` states. So the same three read entries are here — the file, the
   * search and the vocabulary — and the write table is still not what `read`
   * selects.
   */
  it("gives a run child the ordinary read profile: File, Glob and Syntax", function* () {
    const project = yield* useProject({
      "notes.md": doc("the retained note"),
      "reader.md": doc(
        `<Evaluate text={'<Glob include={["notes.md"]} as="paths" />\\n` +
          `<File path="notes.md" as="note" />\\n` +
          `<Json value={{ paths, note }} />\\n'} as="answer" />`,
        "",
        "<Json value={answer} />",
      ),
      "writer.md": doc(
        `<Evaluate text={'<File path="made.md">written by the fragment</File>\\n'} ` +
          `allow={["read"]} />`,
      ),
      "README.md": doc(
        '<Test name="run child reads">',
        '<Execution host="run" target="./reader.md" as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="notes.md" />',
        '<AssertStringIncludes actual={output} expected="the retained note" />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="run child cannot write under read">',
        '<Execution host="run" target="./writer.md" as="child">',
        "<AssertEquals actual={child.result.ok} expected={false} />",
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.code).toBe(0);
    // The refused write left nothing behind, which is what "before any
    // operation" means for a selection that never held the write table.
    expect(yield* readdir(project)).not.toContain("made.md");
  });

  it("refuses <Execution> outside a canonical <Test>", function* () {
    const project = yield* useProject({
      "child.md": doc("child"),
      "README.md": doc('<Execution host="run" target="child.md" />'),
    });
    const result = yield* runCli(["run", "README.md", "--raw"], { cwd: project }).join();
    expect(result.stdout + result.stderr).toContain("canonical <Test>");
  });

  it("refuses <WorkflowRun> on a host with no workflow profile", function* () {
    const project = yield* useProject({
      "README.md": doc(
        '<Test name="workflow">',
        '<WorkflowRun id="demo">',
        "</WorkflowRun>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.stdout + result.stderr).toContain("no workflow profile");
    expect(result.code).not.toBe(0);
  });
});

/**
 * Deterministic dependencies declared for one nested child (issue #641).
 *
 * `packages/testing/tests/execution-harness.test.ts` holds the seam — what a
 * declaration is recognized by, what crosses, and what refuses. What only this
 * file can hold is that the trusted host builds the *real* thing from that
 * data: this package's controlled provider and a real `xmd test-agent` worker,
 * the first-party Agent defaults, and the run profile's own elicitation
 * ordering. So these run `xmd test` on a real project and let a real child
 * document meet them.
 */

const SCHEMA =
  '{"type":"object","properties":{"decision":{"type":"string"}},' +
  '"required":["decision"],"additionalProperties":false}';

/**
 * A behavior document with a third stage nothing sends.
 *
 * `unsentstagemarker` is in the scenario source and in no prompt and no reply,
 * so a journal that mentions it retained configuration rather than results.
 */
const BEHAVIOR = doc(
  '<WhenPrompt as="review" template="Review {?subject}" />',
  "",
  "reviewed **{review.subject}**",
  "",
  '<WhenPrompt template="Summarize {review.subject}" />',
  "",
  "summarized **{review.subject}**",
  "",
  '<WhenPrompt template="unsentstagemarker" />',
  "",
  "never reached",
);

/** Two `<Session>` invocations naming one conversation, then an elicitation. */
const TWO_TURNS = doc(
  "# The document under test",
  "",
  '<Session name="review">',
  '<Prompt text="Review the plan" as="first" />',
  "</Session>",
  "",
  '<Session name="review">',
  '<Prompt text="Summarize the plan" as="second" />',
  "</Session>",
  "",
  `<Elicit schema='${SCHEMA}' as="verdict">Approve the review?</Elicit>`,
  "",
  "first: {first} second: {second} decision: {verdict.decision}",
);

/** One turn, so two siblings running it both have to be at stage one. */
const ONE_TURN = doc(
  '<Session name="review">',
  '<Prompt text="Review the plan" as="first" />',
  "</Session>",
  "",
  "sibling saw: {first}",
);

const DECLARATION = [
  "<TestAgent>",
  '<TestAgent.Scenario session="review" src="./agents/review.md" />',
  "</TestAgent>",
];

const INSPECTION_MODELS =
  '{selected:"small",options:[' +
  '{id:"small",efforts:{selected:"low",options:["low"]}},' +
  '{id:"sol",efforts:{selected:"medium",options:["medium","high"]}}]}';

const INSPECTION_PROBE = doc(
  '<AgentProvider name="acpx" defaultAgent="codex">',
  "",
  "```js ephemeral eval",
  'import { Agent } from "@executablemd/core";',
  'const choices = yield* Agent.operations.options("codex", { model: "sol" });',
  'if (choices.agent !== "codex" || choices.model?.selected !== "sol" ||',
  '    choices.model?.options.map((choice) => choice.id).join(",") !== "small,sol" ||',
  '    choices.effort?.selected !== "medium" ||',
  '    choices.effort?.options.map((choice) => choice.id).join(",") !== "medium,high") {',
  '  throw new Error("Unexpected Codex inspection choices");',
  "}",
  "```",
  "",
  "sol medium",
  "",
  "</AgentProvider>",
  "",
  "Preflight released.",
);

function inspectionHost(observe = false): string {
  const core = new URL("../../core/mod.ts", import.meta.url).href;
  const api = new URL("../../core/api.ts", import.meta.url).href;
  const testing = new URL("../../testing/mod.ts", import.meta.url).href;
  const runtime = new URL("../../runtime/mod.ts", import.meta.url).href;
  const install = cliRuntime() === "deno" ? "useDataUriCompiler" : "useTempFileCompiler";
  return doc(
    `import { Agent, registerComponents, ${install} } from ${JSON.stringify(core)};`,
    `import { writeTextFile } from ${JSON.stringify(runtime)};`,
    'import { fileURLToPath } from "node:url";',
    'const trace = fileURLToPath(new URL("./inspection-events.json", import.meta.url));',
    `import { Plugin } from ${JSON.stringify(api)};`,
    `import { ExecutionHost } from ${JSON.stringify(testing)};`,
    'export default Plugin({ name: "inspection-test-host", *install(request) {',
    '  if (request.command === "run") {',
    `    yield* ${install}();`,
    ...(observe
      ? [
          "    const events = [];",
          "    function* record(event) {",
          "      events.push(event);",
          "      yield* writeTextFile(trace, JSON.stringify(events));",
          "    }",
          "    yield* Agent.around({ *options(args, next) {",
          "      const result = yield* next(...args);",
          '      yield* record({ kind: "options", args, agent: result.agent,',
          "        model: result.model?.selected, models: result.model?.options.map(({id}) => id),",
          "        effort: result.effort?.selected, efforts: result.effort?.options.map(({id}) => id) });",
          "      return result;",
          "    } });",
          '    yield* registerComponents([{ name: "AfterInspection", origin: "fixture",',
          '      props: { type: "object", properties: {}, additionalProperties: false }, *fn() {',
          '      yield* record({ kind: "following-component" });',
          '      return "";',
          "    } }]);",
        ]
      : []),
    "    return;",
    "  }",
    "  yield* ExecutionHost.around({ *run([request], next) {",
    "    const config = request.profile.configuration?.[0];",
    '    if (config?.kind === "test-agent" && config.inspection) {',
    "      const { inspection } = config;",
    "      const models = inspection.models;",
    "      const effort = models?.options[1]?.efforts;",
    "      if (!models || models.selected !== models.options[0]?.id || !effort ||",
    "          ![config, inspection, models, models.options, models.options[1], effort, effort.options]",
    "            .every(Object.isFrozen)) {",
    '        throw new Error("Expected detached inspection configuration at the host boundary");',
    "      }",
    "    }",
    "    yield* next(request);",
    "  } });",
    "} });",
  );
}

describe("TestAgent inspection in a nested run", () => {
  for (const mode of ["success", "open", "close"]) {
    it(`observes inspection ${mode} through explicit acpx`, function* () {
      const success = mode === "success";
      const refusal = success ? "" : `,refuse:"${mode}"`;
      const project = yield* useProject({
        "README.md": doc(
          `<Test name="inspection ${mode}" timeout="120s">`,
          '<Execution host="run" target="./preflight.md" as="run">',
          `<TestAgent agent="codex" inspection={{models:${INSPECTION_MODELS}${refusal}}} />`,
          '<CollectOutput as="output" />',
          '<AssertEquals actual={run.kind} expected="settled" />',
          `<AssertEquals actual={run.result.ok} expected={${success}} />`,
          `<AssertEquals actual={output.includes("sol medium")} expected={${success}} />`,
          `<AssertEquals actual={output.includes("Preflight released.")} expected={${success}} />`,
          ...(success
            ? []
            : [
                `<AssertStringIncludes actual={run.result.error.message} expected="TestAgent inspection refused to ${mode}." />`,
              ]),
          "</Execution>",
          "</Test>",
        ),
        "preflight.md": INSPECTION_PROBE.replace(
          "Preflight released.",
          "<AfterInspection />\n\nPreflight released.",
        ),
        // The temp-file compiler writes .ts under this project, where tsx needs ESM.
        "package.json": '{"type":"module"}',
        "inspection-host.mjs": inspectionHost(true),
        "inspection-events.json": "[]",
      });
      const result = yield* runCli(["test", "--plugin", "./inspection-host.mjs", "README.md"], {
        cwd: project,
        ...WORKER,
      }).join();
      expect(result.stdout + result.stderr).not.toContain("❌");
      expect(result.code).toBe(0);
      const events: unknown = JSON.parse(
        yield* readTextFile(join(project, "inspection-events.json")),
      );
      expect(events).toEqual([
        ...(mode === "open"
          ? []
          : [
              {
                kind: "options",
                args: ["codex", { model: "sol" }],
                agent: "codex",
                model: "sol",
                models: ["small", "sol"],
                effort: "medium",
                efforts: ["medium", "high"],
              },
            ]),
        ...(success ? [{ kind: "following-component" }] : []),
      ]);
    });
  }

  it("keeps inspection independent of a same-agent named scenario and sibling children", function* () {
    const namedControl = doc(
      '<Session name="review" model="named" effort="deep">',
      '<Prompt text="Review the plan" as="first" />',
      "</Session>",
      "",
      "named result: {first}",
    );
    const siblingProbe = INSPECTION_PROBE.replaceAll("small,sol", "tiny,sol").replaceAll(
      "medium,high",
      "medium,deep",
    );
    const siblingModels = INSPECTION_MODELS.replaceAll("small", "tiny").replaceAll("high", "deep");
    const project = yield* useProject({
      "README.md": doc(
        '<Test name="inspection owns one child" timeout="120s">',
        '<Execution host="run" target="./named.md" as="named">',
        `<TestAgent agent="codex" inspection={{models:${INSPECTION_MODELS}}}>`,
        '<TestAgent.Scenario session="review" src="./agents/review.md" models={{selected:"named",options:[{id:"named",efforts:{selected:"deep",options:["deep"]}}]}} />',
        "</TestAgent>",
        '<CollectOutput as="namedOutput" />',
        "<AssertEquals actual={named.result.ok} expected={true} />",
        '<AssertStringIncludes actual={namedOutput} expected="sol medium" />',
        '<AssertStringIncludes actual={namedOutput} expected="reviewed **the plan**" />',
        "</Execution>",
        '<Execution host="run" target="./sibling.md" as="sibling">',
        `<TestAgent agent="codex" inspection={{models:${siblingModels}}} />`,
        "<AssertEquals actual={sibling.result.ok} expected={true} />",
        "</Execution>",
        '<Execution host="run" target="./preflight.md" as="plain">',
        "<AssertEquals actual={plain.result.ok} expected={false} />",
        '<AssertStringIncludes actual={plain.result.error.message} expected="AgentProvider" />',
        "</Execution>",
        "</Test>",
      ),
      "agents/review.md": BEHAVIOR.replace(
        'as="review"',
        'as="review" model="named" effort="deep"',
      ),
      "preflight.md": INSPECTION_PROBE,
      "package.json": '{"type":"module"}',
      "inspection-host.mjs": inspectionHost(),
      "sibling.md": siblingProbe,
      "named.md": INSPECTION_PROBE.replace(
        "</AgentProvider>",
        `
${namedControl}
</AgentProvider>`,
      ),
    });
    const result = yield* runCli(["test", "--plugin", "./inspection-host.mjs", "README.md"], {
      cwd: project,
      ...WORKER,
    }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);
  });

  it("refuses an invalid inspection catalog before importing the child", function* () {
    const project = yield* useProject({
      "child.md": doc("the child imported its root"),
      "README.md": doc(
        '<Test name="malformed inspection">',
        '<Execution host="run" target="./child.md" as="run">',
        '<TestAgent inspection={{models:{selected:"missing",options:[{id:"sol"}]}}} />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("model selections must be unique members");
    expect(result.stdout + result.stderr).not.toContain("the child imported its root");
  });
});

describe("deterministic dependencies declared for a nested run", () => {
  it("gives a declared child the agent defaults, its own session and its answers", function* () {
    const project = yield* useProject({
      "agents/review.md": BEHAVIOR,
      "two-turns.md": TWO_TURNS,
      "one-turn.md": ONE_TURN,
      "bare.md": doc('<Session name="review">', "nothing here", "</Session>"),
      "README.md": doc(
        '<Test name="scripted agent and declared answers" timeout="120s">',
        '<Execution host="run" target="./two-turns.md" as="run">',
        ...DECLARATION,
        "",
        "<Answers>",
        `<Answer template="Approve the review?" value={{ decision: "approve" }} />`,
        // Never fires, so its template is configuration and nothing else.
        `<Answer template="unusedmatchermarker" value={{ decision: "no" }} />`,
        "</Answers>",
        "",
        "<DiagnosticJournal />",
        '<CollectOutput as="output" />',
        '<CollectJournal as="journal" />',
        "",
        "<AssertEquals actual={run.result.ok} expected={true} />",
        // The first-party <Session> and <Prompt> ran a scripted turn, and
        // reopening the named session continued the same conversation rather
        // than starting it again.
        '<AssertStringIncludes actual={output} expected="reviewed **the plan**" />',
        // The second stage answers only after the first has been sent, so
        // reaching it is the named session having continued rather than
        // restarted.
        '<AssertStringIncludes actual={output} expected="summarized **the plan**" />',
        '<AssertStringIncludes actual={output} expected="decision: approve" />',
        "",
        // What the child actually did is retained; what configured it is not.
        '<AssertEquals actual={JSON.stringify(journal).includes("agent_prompt")} expected={true} />',
        '<AssertEquals actual={JSON.stringify(journal).includes("elicit")} expected={true} />',
        '<AssertEquals actual={JSON.stringify(journal).includes("unsentstagemarker")} expected={false} />',
        '<AssertEquals actual={JSON.stringify(journal).includes("unusedmatchermarker")} expected={false} />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="sibling executions each start at stage one" timeout="120s">',
        '<Execution host="run" target="./one-turn.md" as="left">',
        ...DECLARATION,
        "",
        '<CollectOutput as="leftOutput" />',
        "",
        "<AssertEquals actual={left.result.ok} expected={true} />",
        '<AssertStringIncludes actual={leftOutput} expected="reviewed **the plan**" />',
        "</Execution>",
        "",
        '<Execution host="run" target="./one-turn.md" as="right">',
        ...DECLARATION,
        "",
        '<CollectOutput as="rightOutput" />',
        "",
        // A shared partition would have this one at stage two, where "Review
        // the plan" is not the active template.
        "<AssertEquals actual={right.result.ok} expected={true} />",
        '<AssertStringIncludes actual={rightOutput} expected="reviewed **the plan**" />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="a child with no declaration has no agent surface" timeout="120s">',
        '<Execution host="run" target="./bare.md" as="bare">',
        "<AssertEquals actual={bare.result.ok} expected={false} />",
        '<AssertStringIncludes actual={bare.result.error.message} expected="Session" />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);
  });

  it("keeps the outer test's agent and answers out of the child", function* () {
    const project = yield* useProject({
      "agents/review.md": BEHAVIOR,
      // The outer wrapper's scenario answers a prompt the child never sends,
      // so a scenario that leaked inward would mismatch rather than pass.
      "agents/outer.md": doc(
        '<WhenPrompt template="an outer prompt" />',
        "",
        "the outer scenario answered",
      ),
      "two-turns.md": TWO_TURNS,
      "README.md": doc(
        "<TestAgent>",
        '<TestAgent.Scenario session="review" src="./agents/outer.md" />',
        "",
        "<Answers>",
        `<Answer value={{ decision: "the outer answer" }} />`,
        "",
        '<Test name="the child reaches only what it declared" timeout="120s">',
        '<Execution host="run" target="./two-turns.md" as="run">',
        ...DECLARATION,
        "",
        "<Answers>",
        `<Answer template="Approve the review?" value={{ decision: "approve" }} />`,
        "</Answers>",
        "",
        '<CollectOutput as="output" />',
        "",
        "<AssertEquals actual={run.result.ok} expected={true} />",
        '<AssertStringIncludes actual={output} expected="decision: approve" />',
        '<AssertEquals actual={output.includes("the outer answer")} expected={false} />',
        '<AssertEquals actual={output.includes("the outer scenario answered")} expected={false} />',
        "</Execution>",
        "</Test>",
        "</Answers>",
        "</TestAgent>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);
  });

  it("lets a repository TestAgent end the scan and configure nothing", function* () {
    const project = yield* useProject({
      "agents/review.md": BEHAVIOR,
      // Chosen ahead of the package's, so this is ordinary assertion content.
      "components/TestAgent.md": doc("a repository component"),
      "two-turns.md": TWO_TURNS,
      "README.md": doc(
        '<Test name="a repository TestAgent configures nothing" timeout="120s">',
        '<Execution host="run" target="./two-turns.md" as="run">',
        '<TestAgent as="shadowed" />',
        "",
        '<AssertStringIncludes actual={shadowed} expected="a repository component" />',
        // Nothing configured the child, so its first-party <Session> was never
        // registered and the run refuses rather than reaching a provider.
        "<AssertEquals actual={run.result.ok} expected={false} />",
        '<AssertStringIncludes actual={run.result.error.message} expected="Session" />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);
  });

  /**
   * PMT4 and PMT5 — where a Plan conversation lives, and that none of it stays.
   *
   * Where the root goes is a host dependency no caller selects. Production keeps
   * it under the caller's home; a configured child gets one of its own under the
   * temporary directory, so a test never reads or removes anything a real
   * `xmd plan` owns. Both facts are read the same way — what these directories
   * held before the run against what they hold after — because a child's root
   * exists only while that child does, and the evidence is the absence.
   *
   * The two endings are here together because cleanup that only ran on the happy
   * path would satisfy a case that checked one of them. The approved sibling and
   * the stopped sibling also prove the two children are separate: each answers
   * from its own scenario and its own authored decision.
   */
  it("gives each configured child its own Plan root, and keeps none of them", function* () {
    const before = yield* planRoots();
    const project = yield* useProject({
      "agents/plan.md": PLAN_BEHAVIOR,
      "writes-a-plan.md": PLAN_CHILD,
      "README.md": doc(
        '<Test name="an approved sibling and a stopped one" timeout="180s">',
        '<Execution host="run" target="./writes-a-plan.md" as="approved">',
        ...PLAN_DECLARATION,
        "",
        '<CollectOutput as="output" />',
        "",
        "<AssertEquals actual={approved.result.ok} expected={true} />",
        '<AssertStringIncludes actual={output} expected="# Approved program" />',
        "</Execution>",
        "",
        '<Execution host="run" target="./writes-a-plan.md" as="stopped">',
        "<TestAgent>",
        '<TestAgent.Scenario session="planner" src="./agents/plan.md" />',
        "</TestAgent>",
        "",
        "<Answers>",
        '<Answer value={{ decision: "Stop" }} />',
        "</Answers>",
        "",
        "<AssertEquals actual={stopped.result.ok} expected={false} />",
        "<AssertStringIncludes",
        "  actual={stopped.result.error.message}",
        '  expected="stopped at your request"',
        "/>",
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);

    // Both children wrote a Plan — the rows above say so — and neither kept the
    // root it wrote it under. One that outlived its child would be here, named
    // for the child that made it.
    const after = yield* planRoots();
    expect(after.children.filter((entry) => !before.children.includes(entry))).toEqual([]);
    // And neither of them reached the tree a production `xmd plan` owns.
    expect(after.production.filter((entry) => !before.production.includes(entry))).toEqual([]);
  });

  /**
   * PMT4 — the configuration a Plan invocation actually runs under.
   *
   * Read from what the adapter assembled and the frame installed, after the last
   * install, rather than from the policy either was handed: a report taken from
   * the input would agree with the policy however the adapter assembled its
   * dependencies, and could not tell an assembly that honored it from one that
   * dropped it. The provider is the name that actually routes a turn rather than
   * a label authored beside it.
   *
   * Cancellation is the ending here because it is the one that has no completion
   * to hang teardown on: `halt()` returns only once the provider, the
   * declaration, the session directory and the child root have all gone.
   */
  it("installs the controlled Plan configuration and removes its root after cancellation", function* () {
    const before = yield* planRoots();
    const observed = withResolvers<PlanWriterObservation>();
    const hold = withResolvers<void>();
    const host = testingExecutionHost({
      includes: [],
      plugins: [],
      pluginArgs: [],
      secretDetection: true,
      // deno-lint-ignore require-yield
      installService: function* (): Operation<void> {},
      bundledPlugin: BUNDLED_PLUGIN,
      testAgentWorker: Ok([...cliBase(), "test-agent"]),
      planDeclaration: (request) =>
        planComponentDeclaration({
          surface: "component",
          includes: [],
          context: request.context,
          ...(request.planWriterRoot === undefined
            ? {}
            : { planWriterRoot: request.planWriterRoot }),
          host: request.host,
          ...(request.observePlanWriter === undefined
            ? {}
            : { observePlanWriter: request.observePlanWriter }),
          installElicitation: request.installElicitation,
        }),
      *observePlanWriter(observation): Operation<void> {
        observed.resolve(observation);
        yield* hold.operation;
      },
    });
    const running = yield* spawn(() =>
      host.runChild({
        request: {
          host: "run",
          source: '<Plan session="planner" as="approved">Write a program.</Plan>\n',
          props: {},
          journal: "transient",
          collectJournal: false,
          configuration: [
            {
              kind: "test-agent",
              defaultAgent: "test",
              scenarios: [
                {
                  agent: "test",
                  session: "planner",
                  rootDir: tmpdir(),
                  document: { path: "plan.md", source: PLAN_BEHAVIOR },
                },
              ],
            },
          ],
        },
        run: undefined,
        cwd: tmpdir(),
        // deno-lint-ignore require-yield
        *chunk(): Operation<void> {},
      }),
    );

    // What comes back is the installation, not an account of it: the same value
    // registered the provider and installed the invocation options.
    const installed = yield* observed.operation;

    // The identity that was registered and selected for this invocation.
    expect(installed.provider).toBe("test-agent");
    expect(installed.invocation.permissionMode).toBe("deny-all");

    // And the dependencies the provider actually holds. Read through the
    // provider's own accessors where it has them, so a provider disconnected
    // from these dependencies reports what it really has.
    const dependencies = installed.dependencies;
    expect(dependencies.newSessionOptions?.systemPrompt).toBe(PLAN_WRITER_INSTRUCTIONS);
    expect(dependencies.newSessionOptions?.allowedTools).toEqual([]);
    expect(dependencies.mcpServers).toEqual([]);
    expect(dependencies.permissions).toBe("strict");
    const agentCwd = dependencies.agentCwd === undefined ? "" : yield* dependencies.agentCwd();
    expect(agentCwd.startsWith(join(tmpdir(), "xmd-child-plan-"))).toBe(true);
    expect(agentCwd.startsWith(DEFAULT_PLAN_WRITER_ROOT)).toBe(false);

    // The observer runs once the Plan writer frame is installed and before the
    // Component's content starts, so no Prompt has been sent yet — what is in
    // flight is the invocation holding the provider, the session directory and
    // the child root. halt() waits for all of them to finish teardown before it
    // returns, which is what makes this a structured-cancellation proof rather
    // than a check that something was deleted eventually.
    yield* running.halt();
    const after = yield* planRoots();
    expect(after.children.filter((entry) => !before.children.includes(entry))).toEqual([]);
    expect(after.production.filter((entry) => !before.production.includes(entry))).toEqual([]);
  });

  /**
   * PMT4 — the prompt-failure rule, proven by a turn rather than by a value.
   *
   * `<Prompt>` ordinarily renders whatever a failed turn managed to emit and
   * carries on. The Plan writer policy installs the opposite, and this is the difference
   * being observed: a turn that emits part of a candidate and then fails must
   * end authorship before that partial can be checked or reviewed. A report
   * saying the policy is installed would say so however the middleware behaved.
   */
  it("stops authorship when a turn fails after emitting part of a candidate", function* () {
    const project = yield* useProject({
      "agents/plan.md": PARTIAL_THEN_FAILS,
      "writes-a-plan.md": PLAN_CHILD,
      "README.md": doc(
        '<Test name="a failed turn ends authorship" timeout="180s">',
        '<Execution host="run" target="./writes-a-plan.md" as="run">',
        ...PLAN_DECLARATION,
        "",
        '<CollectOutput as="output" />',
        "",
        "<AssertEquals actual={run.result.ok} expected={false} />",
        // The partial never became a draft, so it reached neither the check nor
        // the review, and no approved source came back.
        '<AssertEquals actual={output.includes("partialcandidatemarker")} expected={false} />',
        '<AssertEquals actual={output.includes("Approved source:")} expected={false} />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);
    // And the partial reached the person running the suite nowhere either.
    expect(result.stdout + result.stderr).not.toContain("partialcandidatemarker");
  });

  /**
   * PMT6 — only the canonical declaration supplies a Plan Agent context.
   *
   * The repository file ends the scan, so what the `<Execution>` prefix holds is
   * an ordinary component invocation rather than a declaration this host
   * recognizes. A child whose `<Plan>` found an Agent context anyway would mean the
   * capability came from the name rather than from the definition ordinary
   * resolution selected.
   */
  it("supplies no Plan Agent context from a repository TestAgent", function* () {
    const project = yield* useProject({
      "agents/review.md": BEHAVIOR,
      // Chosen ahead of the package's, so this is ordinary assertion content.
      "components/TestAgent.md": doc("a repository component"),
      "writes-a-plan.md": doc('<Plan session="planner" as="approved">Write a program.</Plan>'),
      "README.md": doc(
        '<Test name="a repository TestAgent supplies no Agent context" timeout="120s">',
        '<Execution host="run" target="./writes-a-plan.md" as="run">',
        '<TestAgent as="shadowed" />',
        "",
        '<AssertStringIncludes actual={shadowed} expected="a repository component" />',
        "<AssertEquals actual={run.result.ok} expected={false} />",
        "<AssertEquals",
        "  actual={run.result.error.message}",
        '  expected="No Agent context was found. No Plan was returned."',
        "/>",
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);
  });

  /**
   * PMT7 — the direct test root is the testing profile, not a Plan host.
   *
   * The run profile's vocabulary is installed for a run, and `xmd test` is a
   * different profile: it declares `<Plan>` to the production run children it
   * launches and to nothing else, so its own root does not resolve the name at
   * all (`cli.ts`, where the declaration is withheld under `mode.testing`).
   *
   * Either refusal would satisfy "a test root cannot write a Plan". This case
   * pins which one is delivered, so a later change that quietly gave the test
   * root the declaration — and therefore an Agent context to be refused for — is a
   * change somebody has to make deliberately.
   */
  it("gives a direct test root no Plan authorship permission", function* () {
    const project = yield* useProject({
      "README.md": doc(
        '<Test name="a test root cannot write a Plan">',
        '<Plan session="planner" as="approved">Write a program.</Plan>',
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.code).toBe(1);
    const reported = result.stdout + result.stderr;
    expect(reported).toContain("Cannot resolve component: Plan");
    // And no Agent context was supplied for it to be refused for, which is the
    // difference between "not this profile" and "this profile, no agent".
    expect(reported).not.toContain("No Agent context was found.");
  });

  it("refuses an unreadable behavior document before the child's root is imported", function* () {
    const project = yield* useProject({
      "two-turns.md": doc("the child imported its root"),
      "README.md": doc(
        '<Test name="an unreadable behavior document">',
        '<Execution host="run" target="./two-turns.md" as="run">',
        "<TestAgent>",
        '<TestAgent.Scenario src="./agents/absent.md" />',
        "</TestAgent>",
        "",
        "<AssertEquals actual={run.result.ok} expected={true} />",
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.code).toBe(1);
    const reported = result.stdout + result.stderr;
    expect(reported).toContain("cannot read the behavior document");
    // Reading the root would have printed this, so the child was never created.
    expect(reported).not.toContain("the child imported its root");
  });

  it("refuses a scripted agent when this entrypoint cannot re-invoke itself", function* () {
    // A host that installed no command adapter runs documents all the same —
    // `<TestAgent>` makes the same allowance by asking for its relaunch at its
    // own invocation. Only a child that declares a scripted agent has anything
    // to say about it, and what it says is why.
    const host = testingExecutionHost({
      includes: [],
      plugins: [],
      pluginArgs: [],
      secretDetection: true,
      // deno-lint-ignore require-yield
      installService: function* (): Operation<void> {},
      bundledPlugin: BUNDLED_PLUGIN,
      testAgentWorker: Err(new Error("xmd command not installed")),
      // The run profile's own Component is built for every child, and this case
      // is about the relaunch it cannot perform rather than about `<Plan>`.
      planDeclaration: () => planComponentDescription(),
    });
    const refusal = yield* scoped(function* () {
      try {
        yield* host.runChild({
          request: {
            host: "run",
            source: "the child imported its root\n",
            props: {},
            journal: "transient",
            collectJournal: false,
            configuration: [{ kind: "test-agent", defaultAgent: "test", scenarios: [] }],
          },
          run: undefined,
          // Unobservable here: the refusal is reached before the child stands
          // anywhere, and `tmpdir()` is a directory this assertion cannot
          // depend on having any particular contents.
          cwd: tmpdir(),
          // deno-lint-ignore require-yield
          *chunk(): Operation<void> {},
        });
        return "the child ran";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(refusal).toContain("cannot re-invoke itself to run one");
    // The reason is carried rather than discarded, so the sentence names what
    // the host could not do instead of only that it could not.
    expect(refusal).toContain("xmd command not installed");
  });

  it("keeps ordinary resolution and Elicit validation inside a configured child", function* () {
    const project = yield* useProject({
      "agents/review.md": BEHAVIOR,
      // Repository components of two first-party names. Configuring the
      // provider says what the defaults can reach, never that they are chosen.
      "components/Prompt.md": repositoryComponent("text", "a repository prompt"),
      "components/Session.md": repositoryComponent("name", "a repository session"),
      "shadowed.md": doc('<Session name="review" />', "", '<Prompt text="Review the plan" />'),
      "invalid-answer.md": doc(
        "the child imported its root",
        "",
        `<Elicit schema='${SCHEMA}' as="verdict">Approve the review?</Elicit>`,
      ),
      "README.md": doc(
        '<Test name="repository components still shadow the defaults" timeout="120s">',
        '<Execution host="run" target="./shadowed.md" as="run">',
        ...DECLARATION,
        "",
        "<DiagnosticJournal />",
        '<CollectOutput as="output" />',
        '<CollectJournal as="journal" />',
        "",
        '<AssertStringIncludes actual={run.result.ok ? "ok" : run.result.error.message} expected="ok" />',
        '<AssertStringIncludes actual={output} expected="a repository session" />',
        '<AssertStringIncludes actual={output} expected="a repository prompt" />',
        "",
        // The controlled provider was configured and never asked: no default
        // was selected, so no turn happened.
        '<AssertEquals actual={JSON.stringify(journal).includes("agent_prompt")} expected={false} />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="a well-formed answer still meets the Elicit schema" timeout="120s">',
        '<Execution host="run" target="./invalid-answer.md" as="run">',
        "<Answers>",
        // Structurally valid configuration, and not what this Elicit accepts.
        `<Answer template="Approve the review?" value={{ verdict: "approve" }} />`,
        "</Answers>",
        "",
        '<CollectOutput as="output" />',
        "",
        // The root imported and rendered before the elicitation refused, so
        // this failed at <Elicit> rather than before the child.
        '<AssertStringIncludes actual={output} expected="the child imported its root" />',
        "<AssertEquals actual={run.result.ok} expected={false} />",
        '<AssertStringIncludes actual={run.result.error.message} expected="decision" />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project, ...WORKER }).join();
    expect(result.stdout + result.stderr).not.toContain("❌");
    expect(result.code).toBe(0);
  });
});

describe("execution initialization in isolated run children", () => {
  it("EI-child: chosen Plugin setup is reinstalled after cwd and parent middleware stays outside", function* () {
    const project = yield* useProject({});
    const api = new URL("../../core/api.ts", import.meta.url).href;
    const runtime = new URL("../../runtime/mod.ts", import.meta.url).href;
    // ESM by extension, because the project is a bare directory with no
    // `package.json`: a `.ts` plugin there loads as CommonJS under Node, and
    // the dependencies core reaches through publish an import condition only.
    yield* writeTextFile(
      join(project, "init-plugin.mjs"),
      [
        `import { Execution, Plugin, Syntax } from ${JSON.stringify(api)};`,
        `import { cwd } from ${JSON.stringify(runtime)};`,
        "const calls = [];",
        "export default Plugin({ name: 'init-evidence', *install(request) {",
        "  yield* Execution.around({ *init(_args, next) {",
        "    calls.push(`${request.command}@${yield* cwd()}`);",
        "    yield* Syntax.around({ *text() { return calls.join(','); } }, { at: 'min' });",
        "    yield* next();",
        "  } });",
        "  return undefined;",
        "} });",
      ].join("\n"),
    );
    const canonical = yield* until(realpath(project));
    const expected = `test@${canonical},run@${canonical}`;
    yield* writeTextFile(
      join(project, "README.md"),
      doc(
        '<Test name="child initialization">',
        '<Execution host="run" source={"<Syntax />\\n"} as="child">',
        '<CollectOutput as="output" />',
        '<AssertEquals actual={child.kind} expected="settled" />',
        "<AssertEquals actual={child.result.ok} expected={true} />",
        `<AssertStringIncludes actual={output} expected={${JSON.stringify(expected)}} />`,
        "</Execution>",
        "</Test>",
      ),
    );
    const result = yield* runCli(["test", "--plugin", "./init-plugin.mjs", "README.md"], {
      cwd: project,
    }).join();
    if (result.code !== 0) {
      throw new Error(result.stdout + result.stderr);
    }
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("❌");
  });
});

describe("L4 — current source host installation", () => {
  it("installs the loader and carries it into detached run children", function* () {
    const project = yield* useProject({
      "package.json": '{"type":"module"}',
      "helper.ts": 'export const value: string = "host-typed-component";',
      "Typed.ts":
        'import { value } from "./helper.ts";\nexport default function*() { const typed: string = value; return typed; }',
      "README.test.md": doc(
        '<Test name="host module selection">',
        '<Typed as="direct" />',
        '<AssertEquals actual={direct} expected="host-typed-component" />',
        '<Execution host="run" source={"<Typed />"} as="child">',
        '<CollectOutput as="output" />',
        '<AssertStringIncludes actual={output} expected="host-typed-component" />',
        "</Execution>",
        "</Test>",
      ),
    });
    const args = ["test", "README.test.md", "--include", project];
    console.log(JSON.stringify({ argv: [...cliBase(), ...args], cwd: project }));
    const result = yield* runCli(args, { cwd: project }).join();
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("host-typed-component");
    expect(result.stdout).toContain("AssertEquals** passed");
  });
});

describe("1113: clean run child filesystem roots", () => {
  it("1113: restates fixed limits independently of its cwd and parent middleware", function* () {
    const project = yield* useProject({
      "storage/session/private-canary": "private bytes",
      "storage/session/components/fixtures/note": "fixture",
    });
    const storage = join(project, "storage");
    const session = join(storage, "session");
    const fileAccess = yield* captureHostFilesAccess({
      project,
      private: storage,
      assets: join(session, "assets"),
      components: join(session, "components"),
    });
    const host = testingExecutionHost({
      fileAccess,
      includes: [],
      plugins: [],
      pluginArgs: [],
      secretDetection: true,
      installService: function* () {},
      bundledPlugin: BUNDLED_PLUGIN,
      testAgentWorker: Err(new Error("no scripted agent")),
      planDeclaration: () => planComponentDescription(),
    });
    const child = yield* host.runChild({
      request: {
        host: "run",
        source:
          '<File path="components/fixtures/created">allowed child</File><File path="private-canary" as="canary" /><Output>{canary}</Output>',
        props: {},
        journal: "transient",
        collectJournal: false,
        configuration: [],
      },
      cwd: session,
      run: undefined,
      *chunk() {},
    });
    expect(child.outcome).toMatchObject({ kind: "settled", result: { ok: false } });
    expect(
      child.outcome.kind === "settled" &&
        !child.outcome.result.ok &&
        child.outcome.result.error.message,
    ).toContain("outside the working directory");
    expect(yield* readTextFile(join(session, "components/fixtures/created"))).toBe("allowed child");
    expect(yield* readTextFile(join(session, "private-canary"))).toBe("private bytes");
  });
});
