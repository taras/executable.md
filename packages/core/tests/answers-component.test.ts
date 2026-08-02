/**
 * `<Answers>` and `<Answer>` (spec §6.16.2).
 *
 * `Answers.test.md` covers the authoring contract in Markdown. These cover what
 * a document cannot construct or observe about itself: a component that elicits
 * internally, an outer provider watching what was delegated to it, a journal
 * whose recorded answer disagrees with the matcher, and the configuration
 * diagnostics.
 *
 * Two failure shapes appear here and they are not interchangeable. A
 * configuration mistake is a raised `ErrorSegment`, settled under the ambient
 * policy — at a document root that means it lands in the rendered output. An
 * unmatched elicitation is a thrown provider failure, which fails the run. The
 * helpers below keep both observable.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collect } from "../src/collect.ts";
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

    try {
      const output = yield* collect(
        yield* execute({
          path,
          stream: options.stream ?? new InMemoryStream(),
          componentDirs: [workspace],
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

/** The document's own diagnostics, as the ambient policy rendered them. */
function diagnostics(result: Run): string {
  return result.output;
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

describe("Answers: configuration diagnostics", () => {
  it("refuses an <Answer> outside an <Answers>", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      '<Answer template="Approve?" value={{ decision: "a" }} />\n',
    );

    expect(diagnostics(result)).toContain("<Answer> must be a direct child of <Answers>");
    expect(diagnostics(result)).toContain("doc.md:1:1");
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
    expect(diagnostics(bodyless)).toContain("has no body to answer for");

    const selfClosing = yield* run(workspace, "<Answers />\n");
    expect(diagnostics(selfClosing)).toContain("has no body to answer for");
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

    expect(diagnostics(result)).toContain(
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

    expect(diagnostics(result)).toContain("adjacent capture holes");
  });

  it("refuses a matcher with no value", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      ["<Answers>", '<Answer template="Approve?" />', "", "body", "</Answers>", ""].join("\n"),
    );

    expect(diagnostics(result)).toContain('requires a "value" prop');
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

    expect(diagnostics(result)).toContain("template must be a literal string prop");
    expect(diagnostics(result)).toContain("{binding} holes");
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

    expect(diagnostics(result)).toContain("value text is not JSON");
  });

  /**
   * `value={"approve"}` and `value="approve"` both arrive as the prop string
   * `approve`, which is not JSON. The diagnostic points at the spelling that
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

    expect(diagnostics(result)).toContain("captured JSON text");
    expect(diagnostics(result)).toContain(`value='\"approve\"'`);
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

    expect(diagnostics(result)).not.toContain("a body nobody should see");
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
    // misplacement is still a diagnostic rather than a component that renders.
    expect(diagnostics(result)).toContain("<Answer> must be a direct child of <Answers>");
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
