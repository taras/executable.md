/**
 * Integration coverage for prop validation at the expansion and
 * definition-loading boundaries: the structured `cause` on a raised error
 * segment, and rejection of async / reserved-name schemas when a component is
 * loaded (both the Markdown and function-component boundaries).
 */

import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import type { ComponentDefinition, EvalEnv, Json, Segment } from "../src/types.ts";

function markdownComponent(name: string, inputs: Record<string, Json>): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: {},
    inputs,
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

  it("omits cause for a non-validation error (unknown prop path still validates)", function* () {
    const open = markdownComponent("Ok", {
      type: "object",
      properties: { n: { type: "number" } },
      additionalProperties: false,
    });
    const segments = yield* expandRaw("<Ok />", { Ok: open });
    // No props, no required → clean expansion, no error segment.
    expect(segments.some((segment) => segment.type === "error")).toBe(false);
  });
});

describe("definition-loading rejects invalid input schemas", () => {
  it("rejects an async schema at the Markdown load boundary", function* () {
    yield* useStubFs({
      "README.md": "<Bad />\n",
      "Bad.md": [
        "---",
        "inputs:",
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
      message = yield* collect(
        yield* execute({ docPath: "README.md", stream: new InMemoryStream() }),
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
        "inputs:",
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
      message = yield* collect(
        yield* execute({ docPath: "README.md", stream: new InMemoryStream() }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("reserved");
  });
});
