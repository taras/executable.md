import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { useEchoExec, useStubFs } from "@executablemd/runtime/test";
import { forEach } from "@effectionx/stream-helpers";
import { execute } from "../src/execute.ts";
import { beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import type { Operation, Result } from "effection";
import { Stdio } from "@effectionx/process";

function* runDocument(
  files: Record<string, string>,
  props?: Record<string, Json>,
): Operation<OperationResult> {
  yield* useStubFs(files);
  yield* useEchoExec();
  // An interpolated command writes to the reader, not into the document
  // (#441), so a claim about what a block received reads the display.
  let displayed = "";
  const decoder = new TextDecoder();
  yield* Stdio.around({
    *stdout([bytes]) {
      displayed += decoder.decode(bytes);
    },
  });
  const execution = yield* execute({ path: "root.md", stream: new InMemoryStream(), props });
  const output = yield* forEach(function* () {}, execution.output);
  const result = yield* execution;
  return { output, displayed, result };
}

interface OperationResult {
  output: string;
  /** What the document's foreground commands displayed. */
  displayed: string;
  result: Result<Json>;
}

const ROOT_PROPS = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "    declaredOnly: { type: string }",
  "    tags:",
  "      type: array",
  "      items: { type: string }",
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
    const { output, displayed, result } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          "text={props.name} bare={name} dotted={props.release.version} tags={props.tags} missing={props.release.missing} escaped=\\{props.name}",
          "",
          "```js eval",
          "return `eval=${props.name} dotted=${props.release.version} bare=${typeof declaredOnly}`;",
          "```",
          "",
          "```bash exec",
          "echo {props.name}/{props.release.version}",
          "```",
          "",
        ].join("\n"),
      },
      { name: "Ada", declaredOnly: "field", tags: ["a", "b"], release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(true);
    expect(output).toContain(
      "text=Ada bare={name} dotted=1.2.3 tags=a, b missing= escaped={props.name}",
    );
    expect(output).toContain("eval=Ada dotted=1.2.3 bare=undefined");
    expect(displayed).toContain("Ada/1.2.3");
  });

  it("keeps eval-created locals independent from props", function* () {
    const { output, displayed } = yield* runDocument(
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
    const { output, displayed, result } = yield* runDocument(
      {
        "root.md": [ROOT_PROPS, "", "```bash exec", "echo BODY_EFFECT", "```", ""].join("\n"),
      },
      { name: 42, release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(false);
    expect(output).not.toContain("BODY_EFFECT");
  });

  it("uses caller props for projected content and callee props for authored content", function* () {
    const { output, displayed, result } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          "```js eval",
          'const label = "caller";',
          "```",
          '<Wrapper name="callee" forwarded={props.name}>',
          "projected={props.name}",
          "projected-label={label}",
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
          "    forwarded: { type: string }",
          "  required: [name, forwarded]",
          "  additionalProperties: false",
          "---",
          "```js eval",
          'const label = "callee";',
          "```",
          "authored={props.name} forwarded={props.forwarded} authored-label={label}",
          "```js eval",
          "return `component-eval=${props.name}`;",
          "```",
          "```bash exec",
          "echo authored-exec={props.name}",
          "```",
          "<Child value={props.name} />",
          "```js eval",
          'return yield* render("rendered={props.name} label={label}");',
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
    expect(output).toContain("forwarded=caller");
    expect(output).toContain("authored-label=callee");
    expect(output).toContain("component-eval=callee");
    expect(displayed).toContain("authored-exec=callee");
    expect(output).toContain("rendered=callee label=callee");
    expect(output).toContain("projected=caller");
    expect(output).toContain("projected-label=callee");
    expect(output).toContain("child=caller");
    expect(output).toContain("caller");
    expect(output).not.toContain("ERROR");
  });

  it("restores the enclosing props binding after scoped and nested expansion", function* () {
    const { output, displayed, result } = yield* runDocument(
      {
        "root.md": [
          ROOT_PROPS,
          "",
          '<Each in={[{ name: "shadow" }]} let="props">text={props.name}',
          "```js eval",
          "return `eval=${props.name}`;",
          "```",
          "```bash exec",
          "echo exec={props.name}",
          "```",
          "</Each>",
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
    expect(output).toContain("text=shadow");
    expect(output).toContain("eval=shadow");
    expect(displayed).toContain("exec=shadow");
    expect(output).toContain("after=caller");
    expect(output).toContain("outer=outer");
    expect(output).toContain("inner=inner");
    expect(output).toContain("after=outer");
  });

  it("uses one validated object for the props binding and text interpolation", function* () {
    const { output, displayed, result } = yield* runDocument({
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

  it("uses defaults before root and Markdown-component body effects", function* () {
    const { output, displayed, result } = yield* runDocument({
      "root.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    name: { type: string, default: root-default }",
        "  additionalProperties: false",
        "---",
        "root-text={props.name}",
        "```bash exec",
        "echo root-effect={props.name}",
        "```",
        "<Defaulted />",
        "",
      ].join("\n"),
      "Defaulted.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    name: { type: string, default: component-default }",
        "  additionalProperties: false",
        "---",
        "component-text={props.name}",
        "```bash exec",
        "echo component-effect={props.name}",
        "```",
        "",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    expect(output).toContain("root-text=root-default");
    expect(displayed).toContain("root-effect=root-default");
    expect(output).toContain("component-text=component-default");
    expect(displayed).toContain("component-effect=component-default");
  });

  it("does not begin a Markdown-component body effect for invalid props", function* () {
    const { output, displayed, result } = yield* runDocument({
      "root.md": "<Invalid name={42} />\n",
      "Invalid.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    name: { type: string }",
        "  required: [name]",
        "  additionalProperties: false",
        "---",
        "```bash exec",
        "echo INVALID_BODY_EFFECT",
        "```",
        "body={props.name}",
        "",
      ].join("\n"),
    });

    // Rejected before the body, and nothing recovers it, so it ends the run.
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("Invalid");
    expect(displayed).not.toContain("INVALID_BODY_EFFECT");
    expect(output).not.toContain("INVALID_BODY_EFFECT");
    expect(output).not.toContain("body=");
  });

  it("uses one shadowed props binding for text, eval, and exec, then restores it", function* () {
    const { output, displayed, result } = yield* runDocument(
      {
        "root.md": [ROOT_PROPS, "", "<Shadow />", "after={props.name}", ""].join("\n"),
        "Shadow.md": [
          "---",
          "props:",
          "  type: object",
          "  properties: {}",
          "  additionalProperties: false",
          "---",
          "```js eval",
          'const props = { name: "shadow" };',
          "return `eval=${props.name}`;",
          "```",
          "text={props.name}",
          "```js eval",
          "return `after-eval=${props.name}`;",
          "```",
          "```bash exec",
          "echo exec={props.name}",
          "```",
          "",
        ].join("\n"),
      },
      { name: "caller", release: { version: "1.2.3" } },
    );

    expect(result.ok).toBe(true);
    expect(output).toContain("eval=shadow");
    expect(output).toContain("after-eval=shadow");
    expect(output).toContain("text=shadow");
    expect(displayed).toContain("exec=shadow");
    expect(output).toContain("after=caller");
  });

  it("allows an authored props binding to shadow the namespace locally", function* () {
    const { output, displayed, result } = yield* runDocument(
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
    expect(output).toContain("shadowed");
    expect(output).not.toContain("caller");
  });
});
