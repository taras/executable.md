/**
 * Tier RP — root document properties (specs/root-document-props-spec.md).
 *
 * The root receives props on the same contract as an imported component:
 * validated and defaulted before any body effect, then available through
 * `{props.name}`, bare binding interpolation, and eval blocks.
 */
import { captureTestJournal } from "../../test-support/failure-journal.ts";
import { journalCases } from "../../test-support/journal-cases.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { forEach } from "@effectionx/stream-helpers";
import { execute } from "../src/execute.ts";
import { inspectDocument } from "../src/inspect.ts";

const GREETING = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name:",
  "      type: string",
  "      description: Person to greet",
  "    loud:",
  "      type: boolean",
  "      default: false",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  "Hello, {props.name}! loud={props.loud} bare={name}",
  "",
].join("\n");

const SIDE_EFFECT = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  "SIDE_EFFECT_MARKER {props.name}",
  "",
].join("\n");

const NO_PROPS = "PLAIN_MARKER\n";

const GREETING_CONCISE = [
  "---",
  "required: [name]",
  "",
  "props:",
  "  name:",
  "    type: string",
  "    description: Person to greet",
  "  loud:",
  "    type: boolean",
  "    default: false",
  "---",
  "",
  "Hello, {props.name}! loud={props.loud} bare={name}",
  "",
].join("\n");

const NESTED_CONCISE = [
  "---",
  "props:",
  "  server:",
  "    type: object",
  "    properties:",
  "      port: { type: number, default: 8080 }",
  "    default: {}",
  "---",
  "",
  "port={props.server.port}",
  "",
].join("\n");

function* runPath(path: string, props?: Record<string, Json>, stream = new InMemoryStream()) {
  const execution = yield* execute({ path, stream, props });
  const output = yield* forEach(function* () {}, execution.output);
  const result = yield* execution;
  return { output, result };
}

function* runDoc(
  files: Record<string, string>,
  path: string,
  props?: Record<string, Json>,
  stream?: InMemoryStream,
) {
  yield* useStubFs(files);
  return yield* runPath(path, props, stream);
}

const OWNER = "packages/core/tests/root-props.test.ts";
const rootCase = journalCases(OWNER);

describe("Tier RP — root document properties", () => {
  rootCase(
    "RP1: supplied props reach interpolation without bare prop bindings",
    "hello.md",
    function* (stream) {
      const { output, result } = yield* runDoc(
        { "hello.md": GREETING },
        "hello.md",
        {
          name: "Ada",
          loud: true,
        },
        stream,
      );
      expect(result.ok).toBe(true);
      expect(output).toContain("Hello, Ada!");
      expect(output).toContain("loud=true");
      expect(output).toContain("bare={name}");
    },
  );

  rootCase("RP2: schema defaults apply to the root", "hello.md", function* (stream) {
    const { output } = yield* runDoc({ "hello.md": GREETING }, "hello.md", { name: "Ada" }, stream);
    expect(output).toContain("loud=false");
  });

  rootCase(
    "RP3: a missing required property prevents every body effect",
    "doc.md",
    function* (stream) {
      const { output, result } = yield* runDoc({ "doc.md": SIDE_EFFECT }, "doc.md", {}, stream);
      expect(result.ok).toBe(false);
      expect(output).not.toContain("SIDE_EFFECT_MARKER");
    },
  );

  rootCase("RP4: an invalid property prevents every body effect", "doc.md", function* (stream) {
    const { output, result } = yield* runDoc(
      { "doc.md": SIDE_EFFECT },
      "doc.md",
      { name: 12 },
      stream,
    );
    expect(result.ok).toBe(false);
    expect(output).not.toContain("SIDE_EFFECT_MARKER");
  });

  rootCase(
    "RP5: an undeclared property is rejected by the root schema",
    "doc.md",
    function* (stream) {
      const { result } = yield* runDoc(
        { "doc.md": SIDE_EFFECT },
        "doc.md",
        {
          name: "Ada",
          nope: 1,
        },
        stream,
      );
      expect(result.ok).toBe(false);
    },
  );

  rootCase(
    "RP6: a document without props keeps its existing behavior",
    "plain.md",
    function* (stream) {
      const { output, result } = yield* runDoc(
        { "plain.md": NO_PROPS },
        "plain.md",
        undefined,
        stream,
      );
      expect(result.ok).toBe(true);
      expect(output).toContain("PLAIN_MARKER");
    },
  );
});

describe("Tier RI — document inspection", () => {
  it("RI1: inspection returns the declared schema", function* () {
    yield* useStubFs({ "hello.md": GREETING });
    const info = yield* inspectDocument({ path: "hello.md" });
    expect(info.path).toBe("hello.md");
    expect(info.props).toMatchObject({
      type: "object",
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("RI2: inspection produces no body effects", function* () {
    // The body imports a component that does not exist and requires a
    // property nothing supplies, so expanding or validating it would
    // fail. Inspection returns the schema regardless.
    yield* useStubFs({
      "doc.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    name: { type: string }",
        "  required: [name]",
        "  additionalProperties: false",
        "---",
        "",
        "<Missing />",
        "",
      ].join("\n"),
    });
    const info = yield* inspectDocument({ path: "doc.md" });
    expect(info.props).toMatchObject({ required: ["name"] });
  });

  it("RI3: a document without props inspects to the empty schema", function* () {
    yield* useStubFs({ "plain.md": NO_PROPS });
    const info = yield* inspectDocument({ path: "plain.md" });
    expect(info.props).toMatchObject({ type: "object", properties: {} });
  });

  it("RI4: an invalid schema fails inspection just as it fails execution", function* () {
    yield* useStubFs({
      "bad.md": ["---", "props:", "  type: array", "---", "", "body", ""].join("\n"),
    });
    let failed = false;
    try {
      yield* inspectDocument({ path: "bad.md" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it("RI5: a function-component root is rejected", function* () {
    yield* useStubFs({ "thing.ts": "export default function* () {}" });
    let failed = false;
    try {
      yield* inspectDocument({ path: "thing.ts" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  const extensions = "RI6: inspection and execution agree on which roots are markdown";
  it(extensions, function* () {
    // Execution parses any non-TypeScript root as markdown, so inspection
    // must not require a `.md` suffix.
    const names = ["README", "notes.markdown", "doc.md"];
    yield* useStubFs(Object.fromEntries(names.map((name) => [name, GREETING])));

    for (const name of names) {
      const info = yield* inspectDocument({ path: name });
      expect(info.props).toMatchObject({ required: ["name"] });

      yield* captureTestJournal({ owner: OWNER, name: extensions }, name, function* (stream) {
        const execution = yield* execute({
          path: name,
          stream,
          props: { name: "Ada" },
        });
        const output = yield* forEach(function* () {}, execution.output);
        const result = yield* execution;
        expect(result.ok).toBe(true);
        expect(output).toContain("Hello, Ada!");
      });
    }
  });
});

describe("Tier RS — concise props declarations", () => {
  rootCase(
    "RS1: a concise root receives props and applies defaults",
    "hello.md",
    function* (stream) {
      const { output, result } = yield* runDoc(
        { "hello.md": GREETING_CONCISE },
        "hello.md",
        {
          name: "Ada",
        },
        stream,
      );
      expect(result.ok).toBe(true);
      expect(output).toContain("Hello, Ada!");
      expect(output).toContain("loud=false");
      expect(output).toContain("bare={name}");
    },
  );

  const comparison = "RS2: the concise and full spellings behave identically";
  it(comparison, function* () {
    yield* useStubFs({ "concise.md": GREETING_CONCISE, "full.md": GREETING });
    const label = { owner: OWNER, name: comparison };
    yield* captureTestJournal(label, "concise.md", function* (conciseStream) {
      const concise = yield* runPath("concise.md", { name: "Ada", loud: true }, conciseStream);
      yield* captureTestJournal(label, "full.md", function* (fullStream) {
        const full = yield* runPath("full.md", { name: "Ada", loud: true }, fullStream);
        expect(concise.output).toBe(full.output);
      });
    });
  });

  rootCase(
    "RS3: a missing required property prevents every body effect",
    "hello.md",
    function* (stream) {
      const { output, result } = yield* runDoc(
        { "hello.md": GREETING_CONCISE },
        "hello.md",
        {},
        stream,
      );
      expect(result.ok).toBe(false);
      expect(output).not.toContain("Hello");
    },
  );

  rootCase(
    "RS4: the implicit closed object rejects an undeclared property",
    "hello.md",
    function* (stream) {
      const { result } = yield* runDoc(
        { "hello.md": GREETING_CONCISE },
        "hello.md",
        {
          name: "Ada",
          nope: 1,
        },
        stream,
      );
      expect(result.ok).toBe(false);
    },
  );

  rootCase("RS5: object defaults fill recursively", "nested.md", function* (stream) {
    const { output, result } = yield* runDoc(
      { "nested.md": NESTED_CONCISE },
      "nested.md",
      {},
      stream,
    );
    expect(result.ok).toBe(true);
    expect(output).toContain("port=8080");
  });

  const imported = "RS6: an imported concise component validates props like the root";
  it(imported, function* () {
    yield* useStubFs({
      "supplied.md": '<Greeting name="Ada" />\n',
      "omitted.md": "<Greeting />\n",
      "Greeting.md": GREETING_CONCISE,
    });
    const label = { owner: OWNER, name: imported };
    yield* captureTestJournal(label, "supplied.md", function* (stream) {
      const supplied = yield* runPath("supplied.md", undefined, stream);
      expect(supplied.result.ok).toBe(true);
      expect(supplied.output).toContain("Hello, Ada!");
    });
    yield* captureTestJournal(label, "omitted.md", function* (stream) {
      // Nothing recovers the component's prop failure, so it is the run's own
      // outcome and the component renders nothing.
      const omitted = yield* runPath("omitted.md", undefined, stream);
      expect(omitted.result.ok).toBe(false);
      const reported = omitted.result.ok ? "" : omitted.result.error.message;
      expect(reported).toContain("Prop validation failed for <Greeting />");
      expect(reported).toContain("must have required property 'name'");
      expect(omitted.output).not.toContain("Hello, ");
    });
  });

  it("RS7: inspection returns the normalized schema", function* () {
    yield* useStubFs({ "hello.md": GREETING_CONCISE });
    const info = yield* inspectDocument({ path: "hello.md" });
    expect(info.props).toMatchObject({
      type: "object",
      required: ["name"],
      additionalProperties: false,
    });
    expect(info.meta).toEqual({});
  });
});
