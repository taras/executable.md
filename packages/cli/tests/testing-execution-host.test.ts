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
import { Err, ensure, resource, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, readdir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { until } from "effection";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";
import { DEFAULT_AUTHORSHIP_ROOT } from "../src/authorship-profile.ts";
import { testingExecutionHost } from "../src/testing-host.ts";
import { planComponentDescription } from "../src/plan-component.ts";

import { unsupportedRepositories } from "../src/run-repositories.ts";
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

/** An ordinary document that writes a Plan and prints what it bound. */
const PLAN_CHILD = doc(
  "# A document that writes a Plan",
  "",
  '<Plan as="approved">Write the release program.</Plan>',
  "",
  "Approved source: {approved}",
);

/**
 * What a child needs to write one: a scripted agent for the turn, and an
 * authored approval for the review.
 *
 * `anySession` because `<Plan>` derives the conversation it opens from the
 * expansion that asked, so there is no session name to write here.
 */
const PLAN_DECLARATION = [
  "<TestAgent>",
  '<TestAgent.Scenario anySession={true} src="./agents/plan.md" />',
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
    production: yield* listing(DEFAULT_AUTHORSHIP_ROOT),
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
        '<TestAgent.Scenario anySession={true} src="./agents/plan.md" />',
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
   * PMT6 — only the canonical declaration configures a Plan ceiling.
   *
   * The repository file ends the scan, so what the `<Execution>` prefix holds is
   * an ordinary component invocation rather than a declaration this host
   * recognizes. A child whose `<Plan>` found a ceiling anyway would mean the
   * capability came from the name rather than from the definition ordinary
   * resolution selected.
   */
  it("configures no Plan authorship ceiling from a repository TestAgent", function* () {
    const project = yield* useProject({
      "agents/review.md": BEHAVIOR,
      // Chosen ahead of the package's, so this is ordinary assertion content.
      "components/TestAgent.md": doc("a repository component"),
      "writes-a-plan.md": doc('<Plan session="planner" as="approved">Write a program.</Plan>'),
      "README.md": doc(
        '<Test name="a repository TestAgent configures no Plan ceiling" timeout="120s">',
        '<Execution host="run" target="./writes-a-plan.md" as="run">',
        '<TestAgent as="shadowed" />',
        "",
        '<AssertStringIncludes actual={shadowed} expected="a repository component" />',
        "<AssertEquals actual={run.result.ok} expected={false} />",
        "<AssertStringIncludes",
        "  actual={run.result.error.message}",
        '  expected="establishes no coding-agent ceiling"',
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
   * root the declaration — and therefore a ceiling to be refused at — is a
   * change somebody has to make deliberately.
   */
  it("gives a direct test root no Plan authorship authority", function* () {
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
    // And no ceiling was established for it to be refused at, which is the
    // difference between "not this profile" and "this profile, no agent".
    expect(reported).not.toContain("establishes no coding-agent ceiling");
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
      secretDetection: true,
      // deno-lint-ignore require-yield
      installService: function* (): Operation<void> {},
      installRepositories: unsupportedRepositories,
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
