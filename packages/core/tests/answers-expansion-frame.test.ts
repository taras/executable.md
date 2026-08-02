/**
 * The expansion frame `<Answers>` renders through (spec §6.16.2, §5.3).
 *
 * `<Answers>` is dispatched by the expansion loop but renders its body — and
 * each `<Answer>`'s template children — through the *Api* form of
 * `expandSegments`, which resolves against a frame rather than taking the
 * expansion's state as arguments. `withExpansionFrame` is what publishes it.
 *
 * Every case below is written so the body it expands can only come out right if
 * the frame carries this expansion's own recursion: the cycle-detection hide
 * set, the block counter, and the interpolation inputs. Take the frame away and
 * they fail with "no active expansion"; give them a frame built from anything
 * else and they fail on what it carried.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type { CodeBlockContext, ComponentDefinition, EvalEnv, Json } from "../src/types.ts";

function makeComponent(
  name: string,
  body: string,
  meta: Record<string, unknown> = {},
  props?: Json,
): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta,
    props: (props as ComponentDefinition["props"]) ?? {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    bodySegments: scanSegments(body),
  };
}

function useTestComponents(
  components: Record<string, ComponentDefinition>,
  blocks?: CodeBlockContext[],
): Operation<void> {
  return Component.around(
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
      *applyModifiers([_modifiers, block], _next) {
        blocks?.push(block);
        return { output: "", exitCode: 0, stderr: "" };
      },
      env: () => ({ values: {} }),
    },
    { at: "min" },
  );
}

/**
 * Wrap `body` in a region with nothing to answer.
 *
 * An `<Answers>` with no matcher still installs its provider and still renders
 * its body through the frame, and no elicitation is raised here — so what these
 * observe is the expansion and not the matching.
 */
function region(body: string): string {
  return `<Answers>\n\n${body}\n\n</Answers>`;
}

function render(
  source: string,
  components: Record<string, ComponentDefinition> = {},
  options: {
    meta?: Record<string, unknown>;
    props?: Record<string, Json>;
    blocks?: CodeBlockContext[];
    env?: EvalEnv;
  } = {},
): Operation<string> {
  return scoped(function* () {
    yield* useTestComponents(components, options.blocks);
    if (options.env) {
      yield* Component.around({ env: () => options.env }, { at: "min" });
    }
    const expanded = yield* expandSegments(
      scanSegments(source),
      options.meta ?? {},
      options.props ?? {},
      new Set(),
    );
    return renderSegments(expanded);
  });
}

describe("Answers: the expansion frame its body renders through", () => {
  it("inherits the hide set, so a self-reference is a cycle and not runaway depth", function* () {
    const output = yield* render("<Recurse />", {
      Recurse: makeComponent("Recurse", region("<Recurse />")),
    });

    expect(output).toContain("Cycle detected: Recurse");
    expect(output).not.toContain("Maximum expansion depth");
  });

  it("does not leak one region's recursion state into its siblings", function* () {
    const components = {
      Recurse: makeComponent("Recurse", region("<Recurse />")),
    };

    const both = yield* render("<Recurse /><Recurse />", components);
    const single = yield* render("<Recurse />", components);

    expect(both).toBe(single + single);
  });

  it("shares the block counter, so ids stay unique across a region", function* () {
    const blocks: CodeBlockContext[] = [];
    const source = [
      "```bash exec",
      "one",
      "```",
      "",
      "<Answers>",
      "",
      "```bash exec",
      "two",
      "```",
      "",
      "</Answers>",
      "",
      "```bash exec",
      "three",
      "```",
      "",
    ].join("\n");

    yield* render(source, {}, { blocks });

    const ids = blocks.map((block) => block.blockId);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the frame's meta and props interpolating inside a region", function* () {
    const output = yield* render('<Card label="x" />', {
      Card: makeComponent(
        "Card",
        region("{meta.title} / {props.label}"),
        { title: "Card" },
        {
          type: "object",
          properties: { label: { type: "string" } },
          additionalProperties: false,
        },
      ),
    });

    expect(output).toContain("Card / x");
  });

  it("recurses through nested regions", function* () {
    const output = yield* render(region(region("inner")));

    expect(output).toContain("inner");
  });

  /**
   * The second call site: a matcher's template children go through the same
   * operation, so an interpolation in one resolves against the frame too.
   *
   * A built template is never rendered, so it is read here through the one
   * channel that quotes it — a parse failure. The prop interpolates to a pair of
   * adjacent capture holes, which is ambiguous and refused, and the diagnostic
   * repeats the source it refused. An expansion that had not interpolated would
   * have handed `parseTemplate` the literal `{props.label}`, which parses
   * cleanly as a binding hole and reports nothing at all.
   */
  it("expands a matcher's template children through the same frame", function* () {
    const output = yield* render('<Card label="{?a}{?b}" />', {
      Card: makeComponent(
        "Card",
        [
          "<Answers>",
          '<Answer value={{ decision: "ok" }}>Review {props.label}</Answer>',
          "",
          "BODY",
          "</Answers>",
        ].join("\n"),
        {},
        { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
      ),
    });

    expect(output).toContain('"Review {?a}{?b}"');
    // A region whose matchers are malformed does not expand its body (§6.16.2).
    expect(output).not.toContain("BODY");
  });
});
