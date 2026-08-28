/**
 * `<Answers>` and `<Answer>` (spec §6.16.2).
 *
 * `Answers.test.md` covers the authoring contract in Markdown. These cover what
 * a document cannot construct or observe about itself: a component that elicits
 * internally, an outer provider watching what was delegated to it, a journal
 * whose recorded answer disagrees with the matcher, and the configuration
 * printed errors.
 *
 * Two failure shapes appear here and they are not interchangeable. A
 * configuration mistake is a raised `ErrorSegment`, settled under the ambient
 * error mode — printed where the region prints, and the run's own outcome where
 * it does not. An unmatched elicitation is a thrown provider failure, which
 * fails the run wherever it is written. The helpers below keep both
 * observable.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collect } from "../src/collect.ts";
import { AnswersDeclaration, installAnswerProvider } from "../src/answers.ts";
import type { AnswerConfiguration } from "../src/answers.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import type { ElicitationRequest } from "../src/elicitation-api.ts";
import { execute } from "../src/execute.ts";
import { ComponentRegistrationError, registerComponents } from "../src/components/registration.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";

const SCHEMA =
  '{"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"],' +
  '"additionalProperties":false}';

function useWorkspace(): Operation<string> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "answers-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* provide(root);
  });
}

interface Run {
  output: string;
  /** What an outer provider was asked, when one is installed. */
  delegated: ElicitationRequest[];
  failure?: string;
}

/**
 * Execute `source`, optionally behind an outer provider.
 *
 * `outer` is what makes delegation observable: without it, "the elicitation
 * passed outward" and "the region answered it" look the same from the
 * document's side.
 */
function run(
  workspace: string,
  source: string,
  options: {
    outer?: (request: ElicitationRequest, index: number) => Operation<unknown>;
    /**
     * Installed after `outer`, so it is the nearer provider at the same
     * `{ at: "min" }` — which is where a trusted host puts a child's declared
     * answers, in front of the run profile's own form.
     */
    nearer?: () => Operation<void>;
    stream?: InMemoryStream;
  } = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(workspace, "doc.md");
    yield* writeTextFile(path, source);
    yield* useTempFileCompiler();

    const delegated: ElicitationRequest[] = [];
    if (options.outer) {
      const answer = options.outer;
      yield* Elicitation.around(
        {
          *elicit([request]) {
            delegated.push(request);
            return yield* answer(request, delegated.length - 1);
          },
        },
        { at: "min" },
      );
    }
    if (options.nearer) {
      yield* options.nearer();
    }

    try {
      const output = yield* collect(
        yield* execute({
          path,
          stream: options.stream ?? new InMemoryStream(),
          includes: [workspace],
        }),
      );
      return { output: String(output), delegated };
    } catch (error) {
      return {
        output: "",
        delegated,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** The same journal, with the recorded elicitation answer replaced. */
function* withRecordedAnswer(stream: InMemoryStream, answer: Json): Operation<InMemoryStream> {
  const events = yield* stream.readAll();
  return new InMemoryStream(
    events.map((event) => {
      if (event.type !== "yield" || event.description.type !== "elicit") {
        return event;
      }
      return { ...event, result: { status: "ok", value: answer } };
    }),
  );
}

/** The journal without the root's close, so the next run replays and continues. */
function* partial(stream: InMemoryStream): Operation<InMemoryStream> {
  const events = yield* stream.readAll();
  return new InMemoryStream(
    events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
}

/** A repository component that elicits internally — the case `<Answers>` is for. */
function* writeGate(workspace: string): Operation<void> {
  yield* ensureDir(workspace);
  yield* writeTextFile(
    join(workspace, "ReviewGate.md"),
    [
      "```js eval",
      `const gateSchema = JSON.parse(${JSON.stringify(SCHEMA)});`,
      "```",
      "",
      '<Elicit schema={gateSchema} as="verdict">Approve the plan?</Elicit>',
      "",
      "gate saw: {verdict.decision}",
      "",
    ].join("\n"),
  );
}

const SCHEMA_BLOCK = [
  "```js eval",
  `const s = JSON.parse(${JSON.stringify(SCHEMA)});`,
  "```",
  "",
].join("\n");

function elicits(as: string, message: string): string {
  return `<Elicit schema={s} as="${as}">${message}</Elicit>`;
}

/**
 * The diagnostic the document reported, wherever its region put it: rendered
 * into the output where the region prints, and the run's own failure where it
 * does not.
 */
function reported(result: Run): string {
  return result.failure ?? result.output;
}

describe("Answers: choosing by template", () => {
  it("answers a nested component's elicitation with no host provider installed", function* () {
    const workspace = yield* useWorkspace();
    yield* writeGate(workspace);

    const result = yield* run(
      workspace,
      [
        "<Answers>",
        '<Answer template="Approve {?what}?" value={{ decision: "approve" }} />',
        "",
        "<ReviewGate />",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("gate saw: approve");
  });

  it("matches anything when the matcher has no template", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer value={{ decision: "catch-all" }} />',
          "",
          elicits("v", "Anything at all"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: catch-all");
  });

  it("reads a multiline template from children", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer value={{ decision: "deployed" }}>',
          "Deploy {?service} to production?",
          "</Answer>",
          "",
          elicits("v", "Deploy api to production?"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: deployed");
  });

  /** `{?name}` constrains position but carries nothing into the answer. */
  it("uses a wildcard hole to constrain without binding", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Deploy {?service} to production?" value={{ decision: "yes" }} />',
          "",
          elicits("a", "Deploy api to production?"),
          "",
          "Got: {a.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: yes");
  });

  it("does not match when the literal text around a hole differs", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Deploy {?service} to production?" value={{ decision: "yes" }} />',
          "",
          elicits("a", "Deploy api to staging?"),
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("no matcher for this elicitation");
  });

  /** A `{binding}` in the prop form reaches the engine intact and constrains. */
  it("interpolates a binding in the template prop", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "```js eval",
          'const service = "api";',
          "```",
          "",
          "<Answers>",
          '<Answer template="Deploy {service} to production?" value={{ decision: "bound" }} />',
          "",
          elicits("a", "Deploy api to production?"),
          "",
          "Got: {a.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: bound");
  });

  it("does not match when the interpolated binding differs", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "```js eval",
          'const service = "worker";',
          "```",
          "",
          "<Answers>",
          '<Answer template="Deploy {service} to production?" value={{ decision: "bound" }} />',
          "",
          elicits("a", "Deploy api to production?"),
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("no matcher for this elicitation");
  });

  /** A string answer is JSON text like any other, so it is written quoted. */
  it("round-trips a string answer written as quoted JSON", function* () {
    const workspace = yield* useWorkspace();
    const stringSchema = '{"type":"string"}';

    const result = yield* run(
      workspace,
      [
        "```js eval",
        `const str = JSON.parse(${JSON.stringify(stringSchema)});`,
        "```",
        "",
        "<Answers>",
        `<Answer template="Approve?" value='"approve"' />`,
        "",
        '<Elicit schema={str} as="v">Approve?</Elicit>',
        "",
        "Got: {v}",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: approve");
  });

  it("reads a value written as captured JSON text", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          `<Answer template="Approve?" value='{"decision":"from-text"}' />`,
          "",
          elicits("v", "Approve?"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: from-text");
  });
});

describe("Answers: selection", () => {
  /**
   * First declared wins, and the consequence is the point: a broad template
   * above a narrow one shadows it permanently.
   */
  it("takes the first declared matching matcher", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="{?anything}" value={{ decision: "broad" }} />',
          '<Answer template="Approve the plan?" value={{ decision: "narrow" }} />',
          "",
          elicits("v", "Approve the plan?"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: broad");
  });

  it("lets a narrower matcher win when it is declared first", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Approve the plan?" value={{ decision: "narrow" }} />',
          '<Answer template="{?anything}" value={{ decision: "broad" }} />',
          "",
          elicits("a", "Approve the plan?"),
          elicits("b", "Something else"),
          "",
          "Got: {a.decision} then {b.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: narrow then broad");
  });

  /** A matcher is not consumed by answering: it answers every match it sees. */
  it("reuses one matcher across several elicitations", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Step {?n}?" value={{ decision: "same" }} />',
          "",
          elicits("a", "Step one?"),
          elicits("b", "Step two?"),
          elicits("c", "Step three?"),
          "",
          "Got: {a.decision} {b.decision} {c.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: same same same");
  });

  it("does not mind a matcher that never fires", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "used" }} />',
          '<Answer template="Never asked" value={{ decision: "unused" }} />',
          "",
          elicits("v", "Approve?"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: used");
  });

  it("still judges a matched value against the asking component's schema", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Approve?" value={{ wrong: true }} />',
          "",
          elicits("v", "Approve?"),
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("<Elicit />");
    expect(result.failure).toContain("failed its schema");
  });
});

describe("Answers: unmatched elicitations", () => {
  it("names the message and every template tried", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "a" }} />',
          '<Answer template="Reject?" value={{ decision: "b" }} />',
          "",
          elicits("v", "Something nobody wrote a matcher for"),
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("Something nobody wrote a matcher for");
    expect(result.failure).toContain('"Approve?"');
    expect(result.failure).toContain('"Reject?"');
  });

  it("passes an unmatched elicitation outward when delegate is set", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers delegate={true}>",
          '<Answer template="Approve?" value={{ decision: "scripted" }} />',
          "",
          elicits("a", "Approve?"),
          elicits("b", "The one a person answers"),
          "",
          "Got: {a.decision} then {b.decision}",
          "</Answers>",
          "",
        ].join("\n"),
      // deno-lint-ignore require-yield
      {
        outer: function* () {
          return { decision: "from-host" };
        },
      },
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: scripted then from-host");

    // The delegated request is the asking component's, unchanged — <Answers>
    // forwards it rather than re-describing it.
    expect(result.delegated).toHaveLength(1);
    expect(result.delegated[0].message).toContain("The one a person answers");
    expect(result.delegated[0].schema).toEqual(JSON.parse(SCHEMA));
  });

  it("does not reach the outer provider without delegate", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "a" }} />',
          "",
          elicits("v", "Not this one"),
          "</Answers>",
          "",
        ].join("\n"),
      // deno-lint-ignore require-yield
      {
        outer: function* () {
          return { decision: "from-host" };
        },
      },
    );

    expect(result.failure).toContain("no matcher for this elicitation");
    expect(result.delegated).toHaveLength(0);
  });
});

describe("Answers: nesting", () => {
  it("lets the nearest region answer first", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "outer" }} />',
          "",
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "inner" }} />',
          "",
          elicits("v", "Approve?"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: inner");
  });

  it("reaches the enclosing region when the inner one delegates", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Outer question?" value={{ decision: "from-outer" }} />',
          "",
          "<Answers delegate={true}>",
          '<Answer template="Inner question?" value={{ decision: "from-inner" }} />',
          "",
          elicits("a", "Inner question?"),
          elicits("b", "Outer question?"),
          "",
          "Got: {a.decision} then {b.decision}",
          "</Answers>",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: from-inner then from-outer");
  });

  it("stops at the inner region when it does not delegate", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="{?anything}" value={{ decision: "outer" }} />',
          "",
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "inner" }} />',
          "",
          elicits("v", "A question the inner region does not match"),
          "</Answers>",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("no matcher for this elicitation");
  });

  /** The region ends with its body, so a later sibling is not answered by it. */
  it("stops answering once its body is over", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="{?anything}" value={{ decision: "inside" }} />',
          "",
          elicits("a", "Inside?"),
          "</Answers>",
          "",
          elicits("b", "Outside?"),
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("no elicitation provider configured");
  });
});

describe("Answers: configuration printed errors", () => {
  it("refuses an <Answer> outside an <Answers>", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      '<Answer template="Approve?" value={{ decision: "a" }} />\n',
    );

    expect(reported(result)).toContain("<Answer> must be a direct child of <Answers>");
    expect(reported(result)).toContain("doc.md:1:1");
  });

  it("refuses an <Answers> with nothing to answer for", function* () {
    const workspace = yield* useWorkspace();

    const bodyless = yield* run(
      workspace,
      [
        "<Answers>",
        '<Answer template="Approve?" value={{ decision: "a" }} />',
        "</Answers>",
        "",
      ].join("\n"),
    );
    expect(reported(bodyless)).toContain("has no body to answer for");

    const selfClosing = yield* run(workspace, "<Answers />\n");
    expect(reported(selfClosing)).toContain("has no body to answer for");
  });

  it("refuses both template forms at once", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      [
        "<Answers>",
        '<Answer template="Approve?" value={{ decision: "a" }}>Also this</Answer>',
        "",
        "body",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(reported(result)).toContain(
      "accepts either a template prop or template children, not both",
    );
  });

  it("refuses a template that cannot be parsed", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      [
        "<Answers>",
        '<Answer template="{?a}{?b}" value={{ decision: "a" }} />',
        "",
        "body",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(reported(result)).toContain("adjacent capture holes");
  });

  it("refuses a matcher with no value", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      ["<Answers>", '<Answer template="Approve?" />', "", "body", "</Answers>", ""].join("\n"),
    );

    expect(reported(result)).toContain('requires a "value" prop');
  });

  /**
   * An expression template is never read, so without this it would silently
   * become a match-anything matcher — and first-wins plus reusable would turn
   * that into permanent shadowing of every matcher below it.
   */
  it("refuses a template written as an expression", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      [
        "```js eval",
        'const question = "Approve?";',
        "```",
        "",
        "<Answers>",
        '<Answer template={question} value={{ decision: "a" }} />',
        "",
        "body",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(reported(result)).toContain("template must be a literal string prop");
    expect(reported(result)).toContain("{binding} holes");
  });

  it("refuses a value that is not JSON", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      [
        "<Answers>",
        `<Answer template="Approve?" value='not json' />`,
        "",
        "body",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(reported(result)).toContain("value text is not JSON");
  });

  /**
   * `value={"approve"}` and `value="approve"` both arrive as the prop string
   * `approve`, which is not JSON. The printed error points at the spelling that
   * works rather than only reporting the parse failure.
   */
  it("points a bare string value at the JSON-quoted spelling", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      [
        "<Answers>",
        '<Answer template="Approve?" value={"approve"} />',
        "",
        "body",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(reported(result)).toContain("captured JSON text");
    expect(reported(result)).toContain(`value='\"approve\"'`);
  });

  /**
   * A malformed matcher stops the region before its body expands: a region that
   * cannot be trusted to answer should not run something that will ask.
   */
  it("does not expand the body when a matcher is malformed", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      [
        "<Answers>",
        '<Answer template="{?a}{?b}" value={{ decision: "a" }} />',
        "",
        "a body nobody should see",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(reported(result)).not.toContain("a body nobody should see");
  });
});

describe("Answers: reservation", () => {
  /**
   * Repository files named after both constructs, in the directory `run()`
   * searches — so the only thing keeping them out of the document is the names
   * being reserved (§5.3).
   *
   * Each body renders a marker and answers nothing. That makes standing in
   * observable from two directions at once: the marker reaches the output, and
   * the elicitation the region was supposed to answer goes unanswered.
   */
  function* writeStandIns(workspace: string): Operation<void> {
    yield* ensureDir(workspace);
    yield* writeTextFile(join(workspace, "Answers.md"), "REPOSITORY_ANSWERS\n");
    yield* writeTextFile(join(workspace, "Answer.md"), "REPOSITORY_ANSWER\n");
  }

  it("does not let a repository Answers.md stand in for the construct", function* () {
    const workspace = yield* useWorkspace();
    yield* writeStandIns(workspace);

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "supplied" }} />',
          "",
          elicits("v", "Approve?"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: supplied");
    expect(result.output).not.toContain("REPOSITORY_ANSWERS");
    expect(result.output).not.toContain("REPOSITORY_ANSWER");
  });

  /**
   * Membership in the reserved set, which nothing above reaches.
   *
   * Keeping a repository file out is the expansion loop's doing — it dispatches
   * both names before resolution runs, and would go on doing so if they were
   * dropped from the set. What the set uniquely decides is that a *registration*
   * cannot claim either name, so this is the assertion that fails if they are.
   */
  it("refuses a registration for either name", function* () {
    for (const name of ["Answers", "Answer"]) {
      let thrown: unknown;
      try {
        yield* scoped(() =>
          registerComponents([
            {
              name,
              origin: "a-host",
              // deno-lint-ignore require-yield
              *fn() {
                return "";
              },
              props: { type: "object", properties: {}, additionalProperties: false },
            },
          ]),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ComponentRegistrationError);
      expect(thrown instanceof Error ? thrown.message : "").toContain("structural syntax");
    }
  });

  it("does not let a repository Answer.md rescue a stray matcher", function* () {
    const workspace = yield* useWorkspace();
    yield* writeStandIns(workspace);

    const result = yield* run(
      workspace,
      '<Answer template="Approve?" value={{ decision: "a" }} />\n',
    );

    // A reserved name resolves to nothing else wherever it is written, so the
    // misplacement is still a printed error rather than a component that renders.
    expect(reported(result)).toContain("<Answer> must be a direct child of <Answers>");
    expect(result.output).not.toContain("REPOSITORY_ANSWER");
  });
});

describe("Answers: durability", () => {
  /**
   * A replayed elicitation never reaches a provider, so matchers see nothing.
   *
   * Proven by making the recorded answer disagree with what the matcher
   * supplies. The document's source is journaled, so editing the file changes
   * nothing on replay — the only way to tell "restored" from "matched again" is
   * for the two to differ, and for the recorded one to win.
   */
  it("restores the recorded answer rather than matching again", function* () {
    const workspace = yield* useWorkspace();
    const stream = new InMemoryStream();
    const source =
      SCHEMA_BLOCK +
      [
        "<Answers>",
        '<Answer template="Approve?" value={{ decision: "supplied" }} />',
        "",
        elicits("v", "Approve?"),
        "",
        "Got: {v.decision}",
        "</Answers>",
        "",
      ].join("\n");

    const live = yield* run(workspace, source, { stream });
    expect(live.output).toContain("Got: supplied");

    const replayed = yield* run(workspace, source, {
      stream: yield* withRecordedAnswer(yield* partial(stream), { decision: "restored" }),
    });

    expect(replayed.failure).toBe(undefined);
    expect(replayed.output).toContain("Got: restored");
  });
});

/**
 * `<Answers>` as child configuration (specs/testing-spec.md).
 *
 * The other placement. A direct declaration in an `<Execution host="run">`
 * prefix holds matchers alone, produces detached data, and is installed by
 * whoever assembled the child — so what is held here is the two halves core
 * owns: reading one, and answering from what was read.
 *
 * The harness that recognizes such a declaration is `@executablemd/testing`'s,
 * and it depends on core. So these install the recorder directly, which is what
 * that harness does with its own bookkeeping behind it.
 */
describe("Answers: child configuration", () => {
  /** What one document's declarations parsed to, and what refused them. */
  interface Declared {
    readonly output: string;
    readonly configurations: AnswerConfiguration[];
    readonly problems: string[];
  }

  /**
   * Read every `<Answers>` in `source` as a declaration.
   *
   * `declares` answers `"parse"` for whatever it is asked about, which is the
   * scan phase of a harness that reached exactly its own declaration prefix.
   */
  function declare(workspace: string, source: string): Operation<Declared> {
    return scoped(function* () {
      const path = join(workspace, "declared.md");
      yield* writeTextFile(path, source);
      yield* useTempFileCompiler();
      const configurations: AnswerConfiguration[] = [];
      const problems: string[] = [];
      yield* AnswersDeclaration.set({
        declares: () => "parse",
        record(_site: string, configuration: Result<AnswerConfiguration>): void {
          if (configuration.ok) {
            configurations.push(configuration.value);
            return;
          }
          problems.push(configuration.error.message);
        },
      });
      const output = yield* collect(
        yield* execute({ path, stream: new InMemoryStream(), includes: [workspace] }),
      );
      return { output: String(output), configurations, problems };
    });
  }

  it("reads matchers into detached data and renders nothing", function* () {
    const workspace = yield* useWorkspace();
    const declared = yield* declare(
      workspace,
      [
        "before",
        "",
        "<Answers>",
        `<Answer template="Approve {?what}?" value={{ decision: "approve" }} />`,
        `<Answer value={{ decision: "fallback" }} />`,
        "</Answers>",
        "",
        "after",
        "",
      ].join("\n"),
    );
    expect(declared.problems).toEqual([]);
    expect(declared.configurations.length).toBe(1);
    const [configuration] = declared.configurations;
    expect(configuration?.matchers.map((matcher) => matcher.template?.source)).toEqual([
      "Approve {?what}?",
      undefined,
    ]);
    expect(configuration?.matchers[0]?.value).toEqual({ decision: "approve" });
    expect(configuration?.bindings).toEqual({});
    // A declaration configures a child; the document it is written in shows
    // nothing where it stood.
    expect(declared.output).toContain("before");
    expect(declared.output).toContain("after");
    expect(declared.output).not.toContain("approve");
  });

  it("resolves a {binding} hole where the declaration is written", function* () {
    const workspace = yield* useWorkspace();
    const declared = yield* declare(
      workspace,
      [
        "```js eval",
        'const plan = "the rollout";',
        "```",
        "",
        "<Answers>",
        `<Answer template="Approve {plan}?" value={{ decision: "approve" }} />`,
        "</Answers>",
        "",
      ].join("\n"),
    );
    expect(declared.problems).toEqual([]);
    // The binding does not travel — the text it stood for does, so the matcher
    // matches what its author meant rather than what the child happens to bind.
    expect(declared.configurations[0]?.bindings).toEqual({ plan: "the rollout" });
  });

  const REFUSED: readonly { name: string; body: readonly string[]; says: string }[] = [
    {
      name: "delegating",
      body: [
        "<Answers delegate={true}>",
        `<Answer template="Approve?" value={{ decision: "a" }} />`,
        "</Answers>",
      ],
      says: "cannot delegate as child configuration",
    },
    {
      name: "empty",
      body: ["<Answers />"],
      says: "requires at least one <Answer> matcher",
    },
    {
      name: "carrying a body",
      body: [
        "<Answers>",
        `<Answer template="Approve?" value={{ decision: "a" }} />`,
        "",
        "prose",
        "</Answers>",
      ],
      says: "holds matchers alone",
    },
    {
      name: "holding a malformed matcher",
      body: ["<Answers>", `<Answer template="Approve?" />`, "</Answers>"],
      says: 'requires a "value" prop',
    },
    {
      name: "referencing a binding this document does not have",
      body: [
        "<Answers>",
        `<Answer template="Approve {missing}?" value={{ decision: "a" }} />`,
        "</Answers>",
      ],
      says: "not a bound string value here",
    },
  ];

  for (const refused of REFUSED) {
    it(`refuses a declaration that is ${refused.name}`, function* () {
      const workspace = yield* useWorkspace();
      const declared = yield* declare(workspace, `${refused.body.join("\n")}\n`);
      expect(declared.configurations).toEqual([]);
      expect(declared.problems.length).toBe(1);
      expect(declared.problems[0]).toContain(refused.says);
    });
  }

  it("answers a match from detached data, and never delegates one it misses", function* () {
    const workspace = yield* useWorkspace();
    const declared = yield* declare(
      workspace,
      [
        "<Answers>",
        `<Answer template="Approve the plan?" value={{ decision: "approve" }} />`,
        "</Answers>",
        "",
      ].join("\n"),
    );
    const [configuration] = declared.configurations;
    if (configuration === undefined) {
      throw new Error(`the declaration was refused: ${declared.problems.join(", ")}`);
    }

    /**
     * One document, run with a counting outer provider and this matcher set
     * installed nearer than it — the order the run profile installs them in.
     */
    function installed(source: string, options: { configured: boolean }): Operation<Run> {
      return run(workspace, source, {
        *outer(): Operation<unknown> {
          return { decision: "the form answered" };
        },
        ...(options.configured
          ? {
              *nearer(): Operation<void> {
                yield* installAnswerProvider(configuration);
              },
            }
          : {}),
      });
    }

    function asks(message: string): string {
      return [SCHEMA_BLOCK, elicits("verdict", message), "", "saw: {verdict.decision}", ""].join(
        "\n",
      );
    }

    const answered = yield* installed(asks("Approve the plan?"), { configured: true });
    expect(answered.failure).toBe(undefined);
    expect(answered.output).toContain("saw: approve");
    expect(answered.delegated).toEqual([]);

    const missed = yield* installed(asks("Approve something else?"), { configured: true });
    expect(missed.failure).toContain("has no matcher for this elicitation");
    // The whole of the claim: the outer provider was never asked, so an
    // unmatched request failed here rather than reaching the form behind it.
    expect(missed.delegated).toEqual([]);
    expect(missed.output).not.toContain("the form answered");

    // And that provider does answer when it is reached, so the case above is
    // about delegation rather than about an inert stub.
    const unconfigured = yield* installed(asks("Approve something else?"), { configured: false });
    expect(unconfigured.delegated.length).toBe(1);
    expect(unconfigured.output).toContain("saw: the form answered");
  });
});
