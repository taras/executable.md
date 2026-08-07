import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { useEchoExec, useStubFs } from "@executablemd/runtime/test";
import { forEach } from "@effectionx/stream-helpers";
import { execute } from "../src/execute.ts";
import { beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import type { Operation } from "effection";

function* runDocument(
  files: Record<string, string>,
  props?: Record<string, Json>,
): Operation<OperationResult> {
  yield* useStubFs(files);
  yield* useEchoExec();
  const execution = yield* execute({ path: "root.md", stream: new InMemoryStream(), props });
  const output = yield* forEach(function* () {}, execution.output);
  const result = yield* execution;
  return { output, result };
}

interface OperationResult {
  output: string;
  result: { ok: boolean };
}

const ROOT_PROPS = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "    release:",
  "      type: object",
  "      properties:",
  "        version: { type: string }",
  "      required: [version]",
  "      additionalProperties: false",
  "  required: [name, release]",
  "  additionalProperties: false",
  "---",
].join("\n");

describe("props binding", () => {
  beforeAll(() => useTempFileCompiler());
  it("installs root props for text, eval, expression, and executable interpolation", function* () {
    const { output, result } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          "text={props.name} bare={name} dotted={props.release.version}",
          "",
          "```js eval",
          "return `eval=${props.name}`;",
          "```",
          "",
          "```bash exec",
          "echo {props.name}",
          "```",
          "",
        ].join("\n"),
      },
      { name: "Ada", release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(true);
    expect(output).toContain("text=Ada bare={name} dotted=1.2.3");
    expect(output).toContain("eval=Ada");
    expect(output).toContain("Ada");
  });

  it("keeps eval-created locals independent from props", function* () {
    const { output } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          "```js eval",
          'const name = "local";',
          "return `${name}/${props.name}`;",
          "```",
          "local={name} prop={props.name}",
          "",
        ].join("\n"),
      },
      { name: "Ada", release: { version: "1.2.3" } },
    );

    expect(output).toContain("local/Ada");
    expect(output).toContain("local=local prop=Ada");
  });

  it("does not begin body effects for invalid root props", function* () {
    const { output, result } = yield* runDocument(
      {
        "root.md": [ROOT_PROPS, "", "```bash exec", "echo BODY_EFFECT", "```", ""].join("\n"),
      },
      { name: 42, release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(false);
    expect(output).not.toContain("BODY_EFFECT");
  });

  it("uses caller props for projected content and callee props for authored content", function* () {
    const { output, result } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          '<Wrapper name="callee">',
          "projected={props.name}",
          "<Child value={props.name} />",
          "```bash exec",
          "echo {props.name}",
          "```",
          "</Wrapper>",
          "",
        ].join("\n"),
        "Wrapper.md": [
          "---",
          "props:",
          "  type: object",
          "  properties:",
          "    name: { type: string }",
          "  required: [name]",
          "  additionalProperties: false",
          "---",
          "authored={props.name}",
          "<Child value={props.name} />",
          "```js eval",
          'return yield* render("rendered={props.name}");',
          "```",
          "<Content />",
          "",
        ].join("\n"),
        "Child.md": [
          "---",
          "props:",
          "  type: object",
          "  properties:",
          "    value: { type: string }",
          "  required: [value]",
          "  additionalProperties: false",
          "---",
          "child={props.value}",
          "",
        ].join("\n"),
      },
      { name: "caller", release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(true);
    expect(output).toContain("authored=callee");
    expect(output).toContain("rendered=callee");
    expect(output).toContain("projected=caller");
    expect(output).toContain("child=caller");
    expect(output).toContain("caller");
    expect(output).not.toContain("ERROR");
  });

  it("restores the enclosing props binding after scoped and nested expansion", function* () {
    const { output, result } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          '<Each in={["shadow"]} let="props">{props}</Each>',
          "after={props.name}",
          '<Outer name="outer" />',
          "",
        ].join("\n"),
        "Outer.md": [
          "---",
          "props:",
          "  name: { type: string }",
          "required: [name]",
          "---",
          'outer={props.name}<Inner name="inner" />after={props.name}',
          "",
        ].join("\n"),
        "Inner.md": [
          "---",
          "props:",
          "  name: { type: string }",
          "required: [name]",
          "---",
          "inner={props.name}",
          "",
        ].join("\n"),
      },
      { name: "caller", release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(true);
    expect(output).toContain("shadow");
    expect(output).toContain("after=caller");
    expect(output).toContain("outer=outer");
    expect(output).toContain("inner=inner");
    expect(output).toContain("after=outer");
  });

  it("uses one validated object for the props binding and text interpolation", function* () {
    const { output, result } = yield* runDocument({
      "root.md": '<Mutator nested={{ value: "original" }} />\n',
      "Mutator.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    nested:",
        "      type: object",
        "      properties:",
        "        value: { type: string }",
        "      required: [value]",
        "      additionalProperties: false",
        "  required: [nested]",
        "  additionalProperties: false",
        "---",
        "```js eval",
        'props.nested.value = "mutated";',
        'return yield* render("{props.nested.value}");',
        "```",
        "",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    expect(output).toContain("mutated");
  });

  it("allows an authored props binding to shadow the namespace locally", function* () {
    const { output, result } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          '<Capture as="props">shadowed</Capture>{props} {props.name}',
          "",
        ].join("\n"),
      },
      { name: "caller", release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(true);
    expect(output).toContain("shadowed caller");
  });
});
