/**
 * `<Answers>` (spec §6.16.2).
 *
 * `Answers.test.md` covers the authoring contract in Markdown. These cover what
 * a document cannot construct or observe about itself: a component that elicits
 * internally, an outer provider watching what was delegated to it, a journal
 * whose recorded answer disagrees with the region, and the failures —
 * `<Answers>` and `<Elicit>` are both unmarked, so they throw rather than
 * raising segments `<AssertThrows>` could catch.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collect } from "../src/collect.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import type { ElicitationRequest } from "../src/elicitation-api.ts";
import { execute } from "../src/execute.ts";
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
 * passed outward" and "the elicitation was answered here" look the same from
 * the document's side.
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
      '<Elicit schema={gateSchema} as="verdict">Review this and decide.</Elicit>',
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

function elicits(as: string, body: string = "Approve?"): string {
  return `<Elicit schema={s} as="${as}">${body}</Elicit>`;
}

describe("Answers: supplying values", () => {
  it("answers a nested component's elicitation with no host provider installed", function* () {
    const workspace = yield* useWorkspace();
    yield* writeGate(workspace);

    const result = yield* run(
      workspace,
      ['<Answers values={[{ decision: "approve" }]}>', "<ReviewGate />", "</Answers>", ""].join(
        "\n",
      ),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("gate saw: approve");
  });

  it("reads values as captured JSON text", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          `<Answers values='[{"decision":"from-text"}]'>`,
          elicits("v"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: from-text");
  });

  it("consumes values in order", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          '<Answers values={[{ decision: "one" }, { decision: "two" }]}>',
          elicits("a"),
          elicits("b"),
          "",
          "Got: {a.decision} then {b.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: one then two");
  });

  /** Laxer than `scriptElicitations()` on purpose: this is a production construct. */
  it("allows values the body never asked for", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          '<Answers values={[{ decision: "used" }, { decision: "spare" }]}>',
          elicits("v"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: used");
  });

  it("still judges a value against the asking component's schema", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        ["<Answers values={[{ wrong: true }]}>", elicits("v"), "</Answers>", ""].join("\n"),
    );

    expect(result.failure).toContain("<Elicit />");
    expect(result.failure).toContain("failed its schema");
  });
});

describe("Answers: running out", () => {
  it("fails with a counted diagnostic by default", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          '<Answers values={[{ decision: "one" }]}>',
          elicits("a"),
          elicits("b"),
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("no value for elicitation 2");
    expect(result.failure).toContain("1 provided, 1 consumed");
  });

  it("passes an unanswered elicitation outward when delegate is set", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          '<Answers values={[{ decision: "scripted" }]} delegate={true}>',
          elicits("a"),
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
      SCHEMA_BLOCK + ["<Answers values={[]}>", elicits("a"), "</Answers>", ""].join("\n"),
      // deno-lint-ignore require-yield
      {
        outer: function* () {
          return { decision: "from-host" };
        },
      },
    );

    expect(result.failure).toContain("no value for elicitation 1");
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
          '<Answers values={[{ decision: "outer" }]}>',
          '<Answers values={[{ decision: "inner" }]}>',
          elicits("v"),
          "",
          "Got: {v.decision}",
          "</Answers>",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.output).toContain("Got: inner");
  });

  it("continues into the enclosing region's values when the inner delegates", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          '<Answers values={[{ decision: "outer-1" }, { decision: "outer-2" }]}>',
          '<Answers values={[{ decision: "inner-1" }]} delegate={true}>',
          elicits("a"),
          elicits("b"),
          elicits("c"),
          "",
          "Got: {a.decision}, {b.decision}, {c.decision}",
          "</Answers>",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("Got: inner-1, outer-1, outer-2");
  });

  it("stops at the inner region when it does not delegate", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          '<Answers values={[{ decision: "outer" }]}>',
          "<Answers values={[]}>",
          elicits("v"),
          "</Answers>",
          "</Answers>",
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("no value for elicitation 1");
  });

  /** The region ends with the body, so a later sibling is not answered by it. */
  it("stops answering once its body is over", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      SCHEMA_BLOCK +
        [
          '<Answers values={[{ decision: "inside" }, { decision: "unused" }]}>',
          elicits("a"),
          "</Answers>",
          "",
          elicits("b"),
          "",
        ].join("\n"),
    );

    expect(result.failure).toContain("no elicitation provider configured");
  });
});

describe("Answers: what it refuses", () => {
  it("reports a malformed values list before the body expands", function* () {
    const workspace = yield* useWorkspace();
    const marker = join(workspace, "expanded.txt");

    const result = yield* run(
      workspace,
      [
        '<Answers values={{ not: "an array" }}>',
        "",
        "```js eval",
        `Deno.writeTextFileSync(${JSON.stringify(marker)}, "expanded");`,
        "```",
        "",
        "</Answers>",
        "",
      ].join("\n"),
    );

    expect(result.failure).toContain("values must be a JSON array");
    expect(yield* exists(marker)).toBe(false);
  });

  it("reports values text that is not JSON", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      ["<Answers values='not json'>", "body", "</Answers>", ""].join("\n"),
    );

    expect(result.failure).toContain("values text is not JSON");
  });
});

describe("Answers: durability", () => {
  /**
   * A replayed elicitation never reaches a provider, so a region does not have
   * to keep describing a question that will not be asked again.
   *
   * Proven by making the recorded answer differ from what the region supplies.
   * The document's source is journaled, so editing the file changes nothing on
   * replay — the only way to tell "restored" from "answered again" is for the
   * two to disagree, and for the recorded one to win.
   */
  it("restores the recorded answer rather than consuming a value", function* () {
    const workspace = yield* useWorkspace();
    const stream = new InMemoryStream();
    const source =
      SCHEMA_BLOCK +
      [
        '<Answers values={[{ decision: "supplied" }]}>',
        elicits("v"),
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
