/**
 * Tier RP — root document properties (specs/root-document-inputs-spec.md).
 *
 * The root receives props on the same contract as an imported component:
 * validated and defaulted before any body effect, then available through
 * `{props.name}`, bare binding interpolation, and eval blocks.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { forEach } from "@effectionx/stream-helpers";
import { execute } from "../src/execute.ts";
import { inspectDocument } from "../src/inspect.ts";

const GREETING = [
  "---",
  "inputs:",
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
  "inputs:",
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

const NO_INPUTS = "PLAIN_MARKER\n";

const GREETING_CONCISE = [
  "---",
  "required: [name]",
  "",
  "inputs:",
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
  "inputs:",
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

function* runPath(path: string, props?: Record<string, Json>) {
  const execution = yield* execute({ path, stream: new InMemoryStream(), props });
  const output = yield* forEach(function* () {}, execution.output);
  const result = yield* execution;
  return { output, result };
}

function* runDoc(files: Record<string, string>, path: string, props?: Record<string, Json>) {
  yield* useStubFs(files);
  return yield* runPath(path, props);
}

describe("Tier RP — root document properties", () => {
  it("RP1: supplied props reach interpolation and bare bindings", function* () {
    const { output, result } = yield* runDoc({ "hello.md": GREETING }, "hello.md", {
      name: "Ada",
      loud: true,
    });
    expect(result.ok).toBe(true);
    expect(output).toContain("Hello, Ada!");
    expect(output).toContain("loud=true");
    expect(output).toContain("bare=Ada");
  });

  it("RP2: schema defaults apply to the root", function* () {
    const { output } = yield* runDoc({ "hello.md": GREETING }, "hello.md", { name: "Ada" });
    expect(output).toContain("loud=false");
  });

  it("RP3: a missing required property prevents every body effect", function* () {
    const { output, result } = yield* runDoc({ "doc.md": SIDE_EFFECT }, "doc.md", {});
    expect(result.ok).toBe(false);
    expect(output).not.toContain("SIDE_EFFECT_MARKER");
  });

  it("RP4: an invalid property prevents every body effect", function* () {
    const { output, result } = yield* runDoc({ "doc.md": SIDE_EFFECT }, "doc.md", { name: 12 });
    expect(result.ok).toBe(false);
    expect(output).not.toContain("SIDE_EFFECT_MARKER");
  });

  it("RP5: an undeclared property is rejected by the root schema", function* () {
    const { result } = yield* runDoc({ "doc.md": SIDE_EFFECT }, "doc.md", {
      name: "Ada",
      nope: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("RP6: a document without inputs keeps its existing behavior", function* () {
    const { output, result } = yield* runDoc({ "plain.md": NO_INPUTS }, "plain.md");
    expect(result.ok).toBe(true);
    expect(output).toContain("PLAIN_MARKER");
  });
});

describe("Tier RI — document inspection", () => {
  it("RI1: inspection returns the declared schema", function* () {
    yield* useStubFs({ "hello.md": GREETING });
    const info = yield* inspectDocument({ path: "hello.md" });
    expect(info.path).toBe("hello.md");
    expect(info.inputs).toMatchObject({
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
        "inputs:",
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
    expect(info.inputs).toMatchObject({ required: ["name"] });
  });

  it("RI3: a document without inputs inspects to the empty schema", function* () {
    yield* useStubFs({ "plain.md": NO_INPUTS });
    const info = yield* inspectDocument({ path: "plain.md" });
    expect(info.inputs).toMatchObject({ type: "object", properties: {} });
  });

  it("RI4: an invalid schema fails inspection just as it fails execution", function* () {
    yield* useStubFs({
      "bad.md": ["---", "inputs:", "  type: array", "---", "", "body", ""].join("\n"),
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

  it("RI6: inspection and execution agree on which roots are markdown", function* () {
    // Execution parses any non-TypeScript root as markdown, so inspection
    // must not require a `.md` suffix.
    const names = ["README", "notes.markdown", "doc.md"];
    yield* useStubFs(Object.fromEntries(names.map((name) => [name, GREETING])));

    for (const name of names) {
      const info = yield* inspectDocument({ path: name });
      expect(info.inputs).toMatchObject({ required: ["name"] });

      const execution = yield* execute({
        path: name,
        stream: new InMemoryStream(),
        props: { name: "Ada" },
      });
      const output = yield* forEach(function* () {}, execution.output);
      const result = yield* execution;
      expect(result.ok).toBe(true);
      expect(output).toContain("Hello, Ada!");
    }
  });
});

describe("Tier RS — concise input declarations", () => {
  it("RS1: a concise root receives props and applies defaults", function* () {
    const { output, result } = yield* runDoc({ "hello.md": GREETING_CONCISE }, "hello.md", {
      name: "Ada",
    });
    expect(result.ok).toBe(true);
    expect(output).toContain("Hello, Ada!");
    expect(output).toContain("loud=false");
    expect(output).toContain("bare=Ada");
  });

  it("RS2: the concise and full spellings behave identically", function* () {
    yield* useStubFs({ "concise.md": GREETING_CONCISE, "full.md": GREETING });
    const concise = yield* runPath("concise.md", { name: "Ada", loud: true });
    const full = yield* runPath("full.md", { name: "Ada", loud: true });
    expect(concise.output).toBe(full.output);
  });

  it("RS3: a missing required property prevents every body effect", function* () {
    const { output, result } = yield* runDoc({ "hello.md": GREETING_CONCISE }, "hello.md", {});
    expect(result.ok).toBe(false);
    expect(output).not.toContain("Hello");
  });

  it("RS4: the implicit closed object rejects an undeclared property", function* () {
    const { result } = yield* runDoc({ "hello.md": GREETING_CONCISE }, "hello.md", {
      name: "Ada",
      nope: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("RS5: object defaults fill recursively", function* () {
    const { output, result } = yield* runDoc({ "nested.md": NESTED_CONCISE }, "nested.md", {});
    expect(result.ok).toBe(true);
    expect(output).toContain("port=8080");
  });

  it("RS6: an imported concise component validates props like the root", function* () {
    yield* useStubFs({
      "supplied.md": '<Greeting name="Ada" />\n',
      "omitted.md": "<Greeting />\n",
      "Greeting.md": GREETING_CONCISE,
    });
    const supplied = yield* runPath("supplied.md");
    expect(supplied.result.ok).toBe(true);
    expect(supplied.output).toContain("Hello, Ada!");

    // A component's prop failure is collected into the output rather than
    // aborting the run, so the diagnostic is the observable, not the status.
    const omitted = yield* runPath("omitted.md");
    expect(omitted.output).toContain("Prop validation failed for <Greeting />");
    expect(omitted.output).toContain("must have required property 'name'");
    expect(omitted.output).not.toContain("Hello, ");
  });

  it("RS7: inspection returns the normalized schema", function* () {
    yield* useStubFs({ "hello.md": GREETING_CONCISE });
    const info = yield* inspectDocument({ path: "hello.md" });
    expect(info.inputs).toMatchObject({
      type: "object",
      required: ["name"],
      additionalProperties: false,
    });
    expect(info.meta).toEqual({});
  });
});
