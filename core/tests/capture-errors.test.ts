import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { DocumentationError } from "../src/errors.ts";
import type { ComponentDefinition, Segment } from "../src/types.ts";

interface CaptureRun {
  segments: Segment[];
  output: string;
  env: Record<string, unknown>;
}

function component(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `${name}.md`,
    meta: {},
    inputs: { type: "object", properties: {}, additionalProperties: false },
    bodySegments: scanSegments(body),
  };
}

// An unresolvable component is the cheapest way to plant an ErrorSegment
// inside a captured subtree: the import failure is reported by the body's own
// consumer boundary, so it reaches the capture as a segment.
const BAD = "<Missing />";

function run(
  source: string,
  opts: { throwing?: boolean; components?: Record<string, string> } = {},
): Operation<CaptureRun> {
  return scoped(function* () {
    const definitions = opts.components ?? {};
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          if (name in definitions) {
            return component(name, definitions[name]);
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
    const testEnv = { values: {} as Record<string, unknown> };
    yield* Component.around({ env: () => testEnv }, { at: "min" });
    if (opts.throwing) {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *raise([error], _next) {
          throw new DocumentationError(error);
        },
      });
    }
    const segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
    return { segments, output: renderSegments(segments), env: testEnv.values };
  });
}

function errors(segments: Segment[]): Segment[] {
  return segments.filter((segment) => segment.type === "error");
}

describe("capture error propagation", () => {
  it("CE1: a captured <Each> preserves body errors under a collecting policy", function* () {
    const result = yield* run(`<Each in={[1, 2]} let="n" as="cap">${BAD}</Each>`);

    expect(errors(result.segments)).toHaveLength(2);
    expect(result.output).toContain("ERROR");
  });

  it("CE2: a captured <Each> containing an error leaves its binding unset", function* () {
    const result = yield* run(`<Each in={[1, 2]} let="n" as="cap">${BAD}</Each>`);

    expect("cap" in result.env).toBe(false);
  });

  it("CE3: a throwing policy aborts a captured <Each> before storing the binding", function* () {
    let thrown: unknown;
    let env: Record<string, unknown> = {};
    try {
      const result = yield* run(`<Each in={[1]} let="n" as="cap">${BAD}</Each>`, {
        throwing: true,
      });
      env = result.env;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in env).toBe(false);
  });

  it("CE4: a successful <Each> capture is unchanged", function* () {
    const result = yield* run('<Each in={[1, 2]} let="n" as="cap">n={n};</Each>INLINE');

    expect(result.output).toBe("INLINE");
    expect(result.env.cap).toBe("n=1;n=2;");
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE5: a captured component preserves body errors under a collecting policy", function* () {
    const result = yield* run('<Bad as="cap" />', { components: { Bad: BAD } });

    expect(errors(result.segments)).toHaveLength(1);
    expect(result.output).toContain("ERROR");
    expect("cap" in result.env).toBe(false);
  });

  it("CE6: a throwing policy aborts a captured component before storing the binding", function* () {
    let thrown: unknown;
    let env: Record<string, unknown> = {};
    try {
      const result = yield* run('<Bad as="cap" />', {
        components: { Bad: BAD },
        throwing: true,
      });
      env = result.env;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in env).toBe(false);
  });

  it("CE7: a successful component capture is unchanged", function* () {
    const result = yield* run('<Good as="cap" />INLINE', { components: { Good: "hello" } });

    expect(result.output).toBe("INLINE");
    expect(result.env.cap).toBe("hello");
    expect(errors(result.segments)).toHaveLength(0);
  });
});
