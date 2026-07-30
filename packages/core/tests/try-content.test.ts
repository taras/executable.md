/**
 * Tier TR — content that reports instead of replacing (spec §5.1.2).
 *
 * `content()` is the failure boundary: content that fails replaces the
 * invocation. `tryContent()` is for a component that renders something *in
 * place of* the failure — a test report — and so needs what rendered before the
 * stop as well as why it stopped.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Component, tryContent } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import type {
  EvalEnv,
  FunctionComponentDefinition,
  Json,
  PartialContent,
  Segment,
} from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

function component(name: string, fn: () => Operation<Json>): FunctionComponentDefinition {
  return { kind: "function", name, props: NO_PROPS, fn };
}

function run(
  source: string,
  definitions: Record<string, FunctionComponentDefinition>,
): Operation<Segment[]> {
  return scoped(function* () {
    const env: EvalEnv = { values: {} };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          const definition = definitions[name];
          if (!definition) {
            throw new Error(`Cannot resolve component: ${name}`);
          }
          return definition;
        },
      },
      { at: "min" },
    );
    return yield* expandSegments(scanSegments(source), {}, {}, new Set());
  });
}

describe("Tier TR — tryContent", () => {
  it("TR1: content that finishes reports its text and no failure", function* () {
    let seen: PartialContent | undefined;
    const definitions = {
      Report: component("Report", function* () {
        seen = yield* tryContent();
        return seen.text;
      }),
    };

    yield* run("<Report>\nhello\n</Report>\n", definitions);

    expect(seen?.text).toContain("hello");
    expect(seen?.failure).toBeUndefined();
  });

  it("TR2: an error the content collected is part of the text, not a failure", function* () {
    let seen: PartialContent | undefined;
    const definitions = {
      Report: component("Report", function* () {
        seen = yield* tryContent();
        return seen.text;
      }),
    };

    // The ambient policy collects, so the missing component settles into a
    // diagnostic where it was written — exactly as it does outside a component.
    yield* run("<Report>\nbefore\n\n<Missing />\n\nafter\n</Report>\n", definitions);

    expect(seen?.failure).toBeUndefined();
    expect(seen?.text).toContain("before");
    expect(seen?.text).toContain("Cannot resolve component: Missing");
    expect(seen?.text).toContain("after");
  });

  // The case `content()` cannot express, and the reason this exists: a
  // component that turns raised segments into throws — as `<Test>` does — stops
  // its body partway, and still needs what came before.
  it("TR3: content stopped by a throw reports what rendered before it", function* () {
    let seen: PartialContent | undefined;
    const definitions = {
      Report: component("Report", function* () {
        yield* Component.around({
          // deno-lint-ignore require-yield
          *raise([segment]) {
            throw new Error(`stopped: ${segment.message}`);
          },
        });
        seen = yield* tryContent();
        return seen.text;
      }),
    };

    const segments = yield* run(
      "<Report>\n\nRENDERED\n\n<Missing />\n\nUNREACHED\n</Report>\n",
      definitions,
    );

    expect(seen?.failure).toBeInstanceOf(Error);
    expect((seen?.failure as Error).message).toContain("stopped:");
    // What the body produced before the throw survives…
    expect(seen?.text).toContain("RENDERED");
    // …and what came after it does not.
    expect(seen?.text).not.toContain("UNREACHED");
    // The component rendered its own report from that text.
    expect(renderSegments(segments)).toContain("RENDERED");
  });

  it("TR4: a self-closing invocation reports empty text and no failure", function* () {
    let seen: PartialContent | undefined;
    const definitions = {
      Report: component("Report", function* () {
        seen = yield* tryContent();
        return "done";
      }),
    };

    yield* run("<Report />\n", definitions);

    expect(seen?.text).toBe("");
    expect(seen?.failure).toBeUndefined();
  });

  it("TR5: it is not available outside a function component invocation", function* () {
    let message = "";
    yield* scoped(function* () {
      try {
        yield* tryContent();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("not inside a function component invocation");
  });
});
