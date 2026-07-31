import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { join } from "node:path";

import {
  journaled,
  journalEvents,
  journalKinds,
  REVIEW_SCHEMA,
  runWebFormDoc,
  useLocalFixture,
  writeFile,
} from "./component-support.ts";

const SCHEMA_BLOCK = [
  "```js eval",
  `const reviewSchema = ${JSON.stringify(REVIEW_SCHEMA)};`,
  "```",
].join("\n");

function document(body: string, props = "schema={reviewSchema}"): string {
  return [SCHEMA_BLOCK, "", `<WebForm ${props} as="response">`, body, "</WebForm>", ""].join("\n");
}

describe("WebForm: what a document gets", () => {
  it("binds the validated response and renders nothing", function* () {
    const run = yield* runWebFormDoc(
      [
        document("# Review required\n\nDecide."),
        "```js eval",
        "output(JSON.stringify(response));",
        "```",
      ].join("\n"),
      { answer: { decision: "approve", note: "fine" } },
    );

    expect(run.completion.ok).toBe(true);
    // The captured value, and no trace of the form around it.
    expect(run.output).toContain('"decision":"approve"');
    expect(run.output).toContain('"note":"fine"');
    expect(run.output.includes("127.0.0.1")).toBe(false);
    expect(run.output.includes("Review required")).toBe(false);
  });

  it("is answered through its own live server", function* () {
    const run = yield* runWebFormDoc(document("Decide."), {
      answer: { decision: "reject" },
    });

    expect(run.completion.ok).toBe(true);
    expect(run.effects.served).toBe(1);
    expect(run.effects.opened.length).toBe(1);
    expect(run.effects.responded.length).toBe(1);
    // Opener and responder were handed the same live URL.
    expect(run.effects.opened[0]).toBe(run.effects.responded[0]);
    expect(run.effects.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]{43}\/$/);
  });

  it("prints the URL a person can use", function* () {
    const run = yield* runWebFormDoc(document("Decide."), { answer: { decision: "approve" } });

    const url = run.effects.opened[0];
    expect(run.effects.printed.some((line) => line.includes(url))).toBe(true);
  });

  it("resolves an expression-valued uiSchema through core", function* () {
    const source = [
      "```js eval",
      `const reviewSchema = ${JSON.stringify(REVIEW_SCHEMA)};`,
      'const reviewUi = { "ui:order": ["decision", "note"] };',
      "```",
      "",
      '<WebForm schema={reviewSchema} uiSchema={reviewUi} as="response">',
      "Decide.",
      "</WebForm>",
      "",
      "```js eval",
      "output(String(response.decision));",
      "```",
    ].join("\n");

    const run = yield* runWebFormDoc(source, { answer: { decision: "approve" } });

    expect(run.completion.ok).toBe(true);
    expect(run.output).toContain("approve");
  });
});

describe("WebForm: nothing happens before the question is ready", () => {
  /**
   * The ordering that matters most. A body that failed means the person was never
   * going to be asked, so a port, a printed URL, a browser, or a journal entry
   * would all be work done for a question that does not exist.
   *
   * The document itself survives here, and that is the engine's doing rather than
   * this component's: an eval failure inside content is settled by the ambient
   * collect policy into a diagnostic before `content()` returns, so `<WebForm>`
   * is handed a body that already failed and never reaches its live work. What
   * this asserts is the consequence — the diagnostic reached the document and
   * nothing was served.
   */
  it("causes no live effect when its content fails", function* () {
    const source = [
      SCHEMA_BLOCK,
      "",
      '<WebForm schema={reviewSchema} as="response">',
      "```js eval",
      'throw new Error("the body failed");',
      "```",
      "</WebForm>",
    ].join("\n");

    const run = yield* runWebFormDoc(source, { answer: { decision: "approve" } });

    expect(run.output).toContain("the body failed");
    expect(run.effects.served).toBe(0);
    expect(run.effects.opened).toEqual([]);
    expect(run.effects.responded).toEqual([]);
    expect(run.effects.printed).toEqual([]);
    // No entry at all, not merely no successful one: a durable operation that
    // began and failed would leave an `err` event, and that is still work done
    // for a question nobody was ever asked.
    expect(yield* journalEvents(run.stream, "web_form")).toEqual([]);
  });

  it("causes no live effect when the schema cannot be used", function* () {
    const unusable: [string, string][] = [
      ["not JSON", '<WebForm schema="{ not json" as="r">x</WebForm>'],
      ["not an object", '<WebForm schema="[]" as="r">x</WebForm>'],
      ["not draft-07", '<WebForm schema={{ type: "not-a-type" }} as="r">x</WebForm>'],
      [
        "an external reference",
        '<WebForm schema={{ type: "object", properties: { a: { $ref: "https://x.test/s.json" } } }} as="r">x</WebForm>',
      ],
      // The discriminating one, and the only one that reaches the compiler. The
      // meta-schema has nothing to say about whether a pointer resolves, so this
      // is valid draft-07 and still unusable — which makes it the case that fails
      // if compilation moves back inside the durable operation.
      [
        "a pointer that resolves to nothing",
        `<WebForm schema='{"type":"object","properties":{"a":{"$ref":"#/definitions/missing"}}}' as="r">x</WebForm>`,
      ],
    ];

    for (const [label, source] of unusable) {
      const run = yield* runWebFormDoc(source, { answer: { decision: "approve" } });

      expect({ label, ok: run.completion.ok }).toEqual({ label, ok: false });
      expect({ label, served: run.effects.served }).toEqual({ label, served: 0 });
      expect({ label, opened: run.effects.opened }).toEqual({ label, opened: [] });
      expect({ label, responded: run.effects.responded }).toEqual({ label, responded: [] });
      expect({ label, printed: run.effects.printed }).toEqual({ label, printed: [] });
      // Every durable yield, not the successful ones: an operation that began and
      // failed leaves an `err` event, and that is still work done for a question
      // nobody was ever asked.
      expect({ label, events: yield* journalEvents(run.stream, "web_form") }).toEqual({
        label,
        events: [],
      });
    }
  });

  /** Unmarked, so #251's default applies: the failure is the document's. */
  it("fails the document rather than collecting", function* () {
    const run = yield* runWebFormDoc(
      '<WebForm schema="[]" as="response">Decide.</WebForm>\n\nafter\n',
      { answer: { decision: "approve" } },
    );

    expect(run.completion.ok).toBe(false);
    // Nothing after it ran, which a collected diagnostic would have allowed.
    expect(run.output.includes("after")).toBe(false);
  });
});

describe("WebForm: durability", () => {
  it("journals the validated response and no transport detail", function* () {
    const run = yield* runWebFormDoc(document("Decide."), {
      answer: { decision: "approve", note: "recorded" },
    });

    const records = yield* journaled(run.stream, "web_form");
    expect(records).toEqual([{ decision: "approve", note: "recorded" }]);

    // Ports, tokens, and URLs appear nowhere in the stream.
    const serialized = JSON.stringify(yield* run.stream.readAll());
    expect(serialized.includes("127.0.0.1")).toBe(false);
    expect(serialized.includes("/f/")).toBe(false);
    expect(serialized).toContain("web_form");
    expect(yield* journalKinds(run.stream)).toContain("web_form");
  });

  it("replays the recorded response with no live effect at all", function* () {
    const stream = new InMemoryStream();
    const source = document("Decide.");

    const first = yield* runWebFormDoc(source, {
      answer: { decision: "approve", note: "first run" },
      stream,
    });
    expect(first.completion.ok).toBe(true);
    expect(first.effects.served).toBe(1);

    // The same journal again: the answer comes back, and nothing is asked.
    const replay = yield* runWebFormDoc(source, { stream });

    expect(replay.completion.ok).toBe(true);
    expect(replay.effects.served).toBe(0);
    expect(replay.effects.opened).toEqual([]);
    expect(replay.effects.responded).toEqual([]);
    // Nobody is asked again, so nobody is shown a URL again either.
    expect(replay.effects.printed).toEqual([]);
  });

  it("restores the response into the document on replay", function* () {
    const stream = new InMemoryStream();
    const source = [
      document("Decide."),
      "```js eval",
      "output(String(response.note));",
      "```",
    ].join("\n");

    yield* runWebFormDoc(source, { answer: { decision: "approve", note: "kept" }, stream });
    const replay = yield* runWebFormDoc(source, { stream });

    expect(replay.completion.ok).toBe(true);
    expect(replay.output).toContain("kept");
    expect(replay.effects.responded).toEqual([]);
  });
});

describe("WebForm: a repository file outranks the registration", () => {
  /**
   * Registered rather than reserved, so a repository writing its own `WebForm`
   * gets its own. Nothing about a schema-backed form is a language or security
   * invariant a package should keep for itself.
   *
   * Real files rather than a stubbed filesystem: a `.ts` component is `import()`ed
   * from a real path, so a stub can resolve its name and then fail to load it.
   */
  it("prefers a repository WebForm.md", function* () {
    const dir = yield* useLocalFixture();
    yield* writeFile(join(dir, "WebForm.md"), "the repository's own form\n");
    const doc = join(dir, "README.md");
    yield* writeFile(doc, "<WebForm />\n");

    const run = yield* runWebFormDoc(doc, { realFiles: true, componentDirs: [dir] });

    expect(run.output).toContain("the repository's own form");
    // The registered default never ran, so nothing was served.
    expect(run.effects.served).toBe(0);
  });

  it("prefers a repository WebForm.ts", function* () {
    const dir = yield* useLocalFixture();
    yield* writeFile(
      join(dir, "WebForm.ts"),
      ["export default function* () {", '  return "the repository\'s own function";', "}", ""].join(
        "\n",
      ),
    );
    const doc = join(dir, "README.md");
    yield* writeFile(doc, "<WebForm />\n");

    const run = yield* runWebFormDoc(doc, { realFiles: true, componentDirs: [dir] });

    expect(run.output).toContain("the repository's own function");
    expect(run.effects.served).toBe(0);
  });
});
