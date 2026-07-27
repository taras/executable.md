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

function* runDoc(files: Record<string, string>, path: string, props?: Record<string, Json>) {
  yield* useStubFs(files);
  const execution = yield* execute({ path, stream: new InMemoryStream(), props });
  const output = yield* forEach(function* () {}, execution.output);
  const result = yield* execution;
  return { output, result };
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

  it("RI5: a non-markdown root is rejected", function* () {
    yield* useStubFs({ "thing.ts": "export default function* () {}" });
    let failed = false;
    try {
      yield* inspectDocument({ path: "thing.ts" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
