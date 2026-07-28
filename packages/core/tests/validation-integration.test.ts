import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { asText } from "./helpers.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { compilePropsSchema } from "../src/validate.ts";
import type { ComponentDefinition, EvalEnv, Json, Segment } from "../src/types.ts";

function markdownComponent(name: string, props: Record<string, Json>): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: {},
    props,
    bodySegments: scanSegments("body"),
  };
}

function expandRaw(
  source: string,
  components: Record<string, ComponentDefinition>,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          const component = components[name];
          if (!component) {
            throw new Error(`Component not found: ${name}`);
          }
          return component;
        },
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          return { output: "", exitCode: 0, stderr: "" };
        },
        env: (): EvalEnv => ({ values: {} }),
      },
      { at: "min" },
    );
    return yield* expandSegments(scanSegments(source), {}, {}, new Set());
  });
}

describe("prop-validation error segment", () => {
  it("carries a structured { componentName, errors } cause", function* () {
    const strict = markdownComponent("Strict", {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    });
    const segments = yield* expandRaw('<Strict n="x" />', { Strict: strict });
    const error = segments.find((segment) => segment.type === "error");
    expect(error).toBeDefined();
    if (error && error.type === "error") {
      expect(error.source).toBe("Strict");
      expect(error.cause).toMatchObject({ componentName: "Strict" });
      expect(JSON.stringify(error.cause)).toContain("must be number");
    }
  });

  it("emits an ErrorSegment without cause for a non-validation error", function* () {
    const open = markdownComponent("Ok", {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    // An invalid `as` binding fails via an ordinary Error, not PropValidationError.
    const segments = yield* expandRaw('<Ok as="not-valid" />', { Ok: open });
    const error = segments.find((segment) => segment.type === "error");
    expect(error).toBeDefined();
    if (error && error.type === "error") {
      expect(error.message).toContain('"as"');
      expect(error.message).toContain("identifier");
      expect("cause" in error).toBe(false);
    }
  });
});

// A full `inputs` schema parses — `inputs` lands in meta — so the failure
// surfaces later, when a caller passes a prop the component does not declare.
describe("`inputs` is not a compatibility alias for `props`", () => {
  it("a component declaring `inputs` declares no props", function* () {
    yield* useStubFs({
      "README.md": '<Legacy name="world" />\n',
      "Legacy.md": [
        "---",
        "inputs:",
        "  type: object",
        "  properties:",
        "    name: { type: string }",
        "  additionalProperties: false",
        "---",
        "Hello, {props.name}",
        "",
      ].join("\n"),
    });
    let message = "";
    try {
      message = asText(
        yield* collect(yield* execute({ path: "README.md", stream: new InMemoryStream() })),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Prop validation failed");
  });
});

describe("definition-loading rejects invalid props schemas", () => {
  it("rejects an async schema at the Markdown load boundary", function* () {
    yield* useStubFs({
      "README.md": "<Bad />\n",
      "Bad.md": [
        "---",
        "props:",
        "  $async: true",
        "  type: object",
        "  properties: {}",
        "  additionalProperties: false",
        "---",
        "body",
        "",
      ].join("\n"),
    });
    let message = "";
    try {
      message = asText(
        yield* collect(yield* execute({ path: "README.md", stream: new InMemoryStream() })),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("async");
  });

  it("rejects a reserved-name schema at the Markdown load boundary", function* () {
    yield* useStubFs({
      "README.md": "<Bad />\n",
      "Bad.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    slot: { type: string }",
        "  additionalProperties: false",
        "---",
        "body",
        "",
      ].join("\n"),
    });
    let message = "";
    try {
      message = asText(
        yield* collect(yield* execute({ path: "README.md", stream: new InMemoryStream() })),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("reserved");
  });

  it("rejects a reserved name declared through a props map", function* () {
    yield* useStubFs({
      "README.md": "<Bad />\n",
      "Bad.md": ["---", "props:", "  slot: { type: string }", "---", "body", ""].join("\n"),
    });
    let message = "";
    try {
      message = asText(
        yield* collect(yield* execute({ path: "README.md", stream: new InMemoryStream() })),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Normalization runs first, so the contract still sees `slot` under
    // `properties`.
    expect(message).toContain("reserved");
  });
});

describe("the root-object contract applies to the normalized schema", () => {
  it("reports a non-object root type", function* () {
    const { props } = parseFrontmatter({ props: { type: "array", items: { type: "string" } } });
    expect(() => compilePropsSchema(props)).toThrow('type: "object"');
  });

  it("reports a missing root type behind a draft-07 dialect", function* () {
    const { props } = parseFrontmatter({
      props: { $schema: "http://json-schema.org/draft-07/schema#", properties: {} },
    });
    expect(() => compilePropsSchema(props)).toThrow('type: "object"');
  });

  it("compiles a normalized props map", function* () {
    const { props } = parseFrontmatter({
      required: ["name"],
      props: { name: { type: "string" } },
    });
    expect(() => compilePropsSchema(props)).not.toThrow();
  });
});
