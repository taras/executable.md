/**
 * `Component.expandSegments` — the recursion a claiming handler gets.
 *
 * Every case here runs through one pass-through extension whose only work is
 * `yield* Component.operations.expandSegments(element.children)`, so any
 * difference from ordinary expansion is attributable to that operation: the
 * frame it binds to must carry the interpolation inputs, the cycle-detection
 * hide set, and the block counter of the expansion that offered the element.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type {
  CodeBlockContext,
  ComponentDefinition,
  EvalEnv,
  Json,
  Segment,
} from "../src/types.ts";

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
    },
    { at: "min" },
  );
}

function useTestEnv(testEnv: EvalEnv): Operation<void> {
  return Component.around({ env: () => testEnv }, { at: "min" });
}

/**
 * Claim `<Passthrough>` and expand its children through the contextual
 * operation — the engine would produce the same segments itself, so any
 * divergence is the frame binding's.
 */
function usePassthrough(): Operation<void> {
  return Component.around({
    *expand([element], next) {
      if (element.name === "Passthrough") {
        return { segments: yield* Component.operations.expandSegments(element.children) };
      }
      return yield* next(element);
    },
  });
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
    yield* useTestEnv(options.env ?? { values: {} });
    yield* usePassthrough();
    const expanded = yield* expandSegments(
      scanSegments(source),
      options.meta ?? {},
      options.props ?? {},
      new Set(),
    );
    return renderSegments(expanded);
  });
}

describe("Component.expandSegments", () => {
  it("inherits the hide set, so a self-reference is a cycle and not runaway depth", function* () {
    const output = yield* render("<Loop />", {
      Loop: makeComponent("Loop", "<Passthrough><Loop /></Passthrough>"),
    });
    expect(output).toContain("Cycle detected: Loop");
    expect(output).not.toContain("Maximum expansion depth");
  });

  it("does not leak one element's recursion state into its siblings", function* () {
    const components = { Loop: makeComponent("Loop", "<Passthrough><Loop /></Passthrough>") };
    const both = yield* render("<Loop /><Loop />", components);
    const single = yield* render("<Loop />", components);
    expect(both).toBe(single + single);
  });

  it("shares the block counter, so ids stay unique across a claimed element", function* () {
    const blocks: CodeBlockContext[] = [];
    const source = [
      "```bash exec",
      "one",
      "```",
      "",
      "<Passthrough>",
      "",
      "```bash exec",
      "two",
      "```",
      "",
      "</Passthrough>",
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

  it("keeps the frame's meta and props interpolating inside a claimed element", function* () {
    const output = yield* render('<Card label="x" />', {
      Card: makeComponent(
        "Card",
        "<Passthrough>{meta.title} / {props.label}</Passthrough>",
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

  it("recurses through nested claimed elements", function* () {
    const output = yield* scoped(function* () {
      yield* useTestComponents({});
      yield* useTestEnv({ values: {} });
      yield* Component.around({
        *expand([element], next) {
          if (element.name === "Shout") {
            const inner = yield* Component.operations.expandSegments(element.children);
            return { segments: [{ type: "text", content: renderSegments(inner).toUpperCase() }] };
          }
          return yield* next(element);
        },
      });
      const expanded = yield* expandSegments(
        scanSegments("<Shout>hi <Shout>there</Shout></Shout>"),
        {},
        {},
        new Set(),
      );
      return renderSegments(expanded);
    });
    expect(output).toBe("HI THERE");
  });

  it("keeps caller bindings on children projected through <Content />", function* () {
    const projected: Array<Record<string, unknown> | undefined> = [];
    const output = yield* scoped(function* () {
      yield* useTestComponents({ Wrap: makeComponent("Wrap", "<Content />") });
      yield* useTestEnv({ values: { who: "caller" } });
      yield* usePassthrough();
      yield* Component.around({
        // deno-lint-ignore require-yield
        *expand([element], next) {
          if (element.name === "Probe") {
            projected.push(element.projectedEnv?.values);
            return { segments: [{ type: "text", content: "probed" } as Segment] };
          }
          return yield* next(element);
        },
      });
      // The engine tags projected children with the caller's bindings; the
      // handler's own recursion must hand them on to what it expands.
      const expanded = yield* expandSegments(
        scanSegments("<Wrap><Passthrough><Probe /></Passthrough></Wrap>"),
        {},
        {},
        new Set(),
      );
      return renderSegments(expanded);
    });
    expect(output).toContain("probed");
    expect(projected).toEqual([{ who: "caller" }]);
  });

  it("has no active expansion for ordinary work between elements", function* () {
    // A modifier chain runs mid-expansion but claims nothing: the frame belongs
    // to the offer, so a code block executing right after one cannot recurse
    // with it.
    let message = "";
    const source = ["<Passthrough>done</Passthrough>", "", "```bash exec", "one", "```", ""].join(
      "\n",
    );
    yield* scoped(function* () {
      yield* useTestComponents({});
      yield* useTestEnv({ values: {} });
      yield* usePassthrough();
      yield* Component.around(
        {
          *applyModifiers(_args, _next) {
            try {
              yield* Component.operations.expandSegments([]);
            } catch (error) {
              message = error instanceof Error ? error.message : String(error);
            }
            return { output: "", exitCode: 0, stderr: "" };
          },
        },
        { at: "min" },
      );
      yield* expandSegments(scanSegments(source), {}, {}, new Set());
    });
    expect(message).toContain("no active expansion");
  });

  it("has no active expansion outside a claimed element", function* () {
    let message = "";
    yield* scoped(function* () {
      yield* useTestComponents({});
      yield* useTestEnv({ values: {} });
      // A completed expansion leaves nothing behind: the frame is restored on
      // the way out, so a later call is answered by the default, not by it.
      yield* expandSegments(scanSegments("plain text"), {}, {}, new Set());
      try {
        yield* Component.operations.expandSegments([]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toContain("no active expansion");
  });
});
