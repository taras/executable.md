import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { ephemeral } from "@executablemd/durable-streams";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { useContent } from "../src/content-context.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { DocumentationError } from "../src/errors.ts";
import type { ComponentDefinition, FunctionComponentDefinition, Segment } from "../src/types.ts";

interface CaptureRun {
  segments: Segment[];
  output: string;
}

const OPEN_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

function component(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `${name}.md`,
    meta: {},
    inputs: OPEN_SCHEMA,
    bodySegments: scanSegments(body),
  };
}

// Renders its children through useContent(), which is the path that turns
// child segments into a string before `as` can inspect them.
function echoComponent(name: string): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    path: `${name}.ts`,
    inputs: OPEN_SCHEMA,
    *fn(_props) {
      return yield* ephemeral(useContent());
    },
  };
}

// An unresolvable component is the cheapest way to plant an ErrorSegment
// inside a captured subtree: the import failure is reported by the body's own
// consumer boundary, so it reaches the capture as a segment.
const BAD = "<Missing />";

interface RunOptions {
  throwing?: boolean;
  components?: Record<string, string>;
  functions?: string[];
  values?: Record<string, unknown>;
}

function run(source: string, opts: RunOptions = {}): Operation<CaptureRun> {
  return scoped(function* () {
    const markdown = opts.components ?? {};
    const functions = opts.functions ?? [];
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          if (functions.includes(name)) {
            return echoComponent(name);
          }
          if (name in markdown) {
            return component(name, markdown[name]);
          }
          throw new Error(`Component not found: ${name}`);
        },
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          return { output: "mock output\n", exitCode: 0, stderr: "" };
        },
      },
      { at: "min" },
    );
    const values: Record<string, unknown> = opts.values ?? {};
    yield* Component.around({ env: () => ({ values }) }, { at: "min" });
    if (opts.throwing) {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *raise([error], _next) {
          throw new DocumentationError(error);
        },
      });
    }
    const segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
    return { segments, output: renderSegments(segments) };
  });
}

function errors(segments: Segment[]): Segment[] {
  return segments.filter((segment) => segment.type === "error");
}

describe("capture error propagation", () => {
  it("CE1: a captured <Each> preserves body errors under a collecting policy", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run(`<Each in={[1, 2]} let="n" as="cap">${BAD}</Each>`, { values });

    expect(errors(result.segments)).toHaveLength(2);
    expect(result.output).toContain("ERROR");
    expect("cap" in values).toBe(false);
  });

  it("CE2: a throwing policy aborts a captured <Each> before storing the binding", function* () {
    const values: Record<string, unknown> = {};
    let thrown: unknown;
    try {
      yield* run(`<Each in={[1]} let="n" as="cap">${BAD}</Each>`, { throwing: true, values });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in values).toBe(false);
  });

  it("CE3: a successful <Each> capture is unchanged", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Each in={[1, 2]} let="n" as="cap">n={n};</Each>INLINE', {
      values,
    });

    expect(result.output).toBe("INLINE");
    expect(values.cap).toBe("n=1;n=2;");
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE4: a captured component preserves body errors under a collecting policy", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Bad as="cap" />', { components: { Bad: BAD }, values });

    expect(errors(result.segments)).toHaveLength(1);
    expect(result.output).toContain("ERROR");
    expect("cap" in values).toBe(false);
  });

  it("CE5: a throwing policy aborts a captured component before storing the binding", function* () {
    const values: Record<string, unknown> = {};
    let thrown: unknown;
    try {
      yield* run('<Bad as="cap" />', { components: { Bad: BAD }, throwing: true, values });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in values).toBe(false);
  });

  it("CE6: a successful component capture is unchanged", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Good as="cap" />INLINE', {
      components: { Good: "hello" },
      values,
    });

    expect(result.output).toBe("INLINE");
    expect(values.cap).toBe("hello");
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE7: a captured function component preserves content errors", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run(`<Echo as="cap">${BAD}</Echo>AFTER`, {
      functions: ["Echo"],
      values,
    });

    expect(errors(result.segments)).toHaveLength(1);
    expect(result.output).toContain("ERROR");
    expect(result.output).toContain("AFTER");
    expect("cap" in values).toBe(false);
  });

  it("CE8: a throwing policy aborts a captured function component", function* () {
    const values: Record<string, unknown> = {};
    let thrown: unknown;
    try {
      yield* run(`<Echo as="cap">${BAD}</Echo>`, {
        functions: ["Echo"],
        throwing: true,
        values,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in values).toBe(false);
  });

  it("CE9: a successful function component capture is unchanged", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Echo as="cap">body</Echo>INLINE', {
      functions: ["Echo"],
      values,
    });

    expect(result.output).toBe("INLINE");
    expect(values.cap).toBe("body");
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE10: an uncaptured function component renders content errors inline", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run(`<Echo>${BAD}</Echo>AFTER`, { functions: ["Echo"], values });

    expect(result.output).toContain("ERROR");
    expect(result.output).toContain("AFTER");
  });
});
