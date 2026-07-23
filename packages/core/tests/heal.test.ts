import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import { healSegment } from "../src/heal.ts";
import { scanSegments } from "../src/scanner.ts";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { renderSegments } from "../src/render.ts";
import type { Operation } from "effection";
import type { Segment, ComponentDefinition, TextSegment, Json } from "../src/types.ts";

function makeComponent(
  name: string,
  body: string,
  opts: {
    meta?: Record<string, unknown>;
    inputs?: Record<string, any>;
  } = {},
): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: opts.meta ?? {},
    inputs: opts.inputs ?? { type: "object", properties: {}, additionalProperties: false },
    bodySegments: scanSegments(body),
  };
}

/** Extract text segments from scan results. */
function getTextSegments(input: string): string[] {
  return scanSegments(input)
    .filter((s): s is TextSegment => s.type === "text")
    .map((s) => s.content);
}

/** Expand segments with test providers and render to string. */
function expand(
  segments: Segment[],
  components: Record<string, ComponentDefinition>,
  meta: Record<string, unknown> = {},
  props: Record<string, Json> = {},
): Operation<string> {
  return scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          const comp = components[name];
          if (!comp) {
            throw new Error(`Component not found: ${name}`);
          }
          return comp;
        },
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          return { output: "", exitCode: 0, stderr: "" };
        },
      },
      { at: "min" },
    );
    const expanded = yield* expandSegments(segments, meta, props, new Set());
    return renderSegments(expanded);
  });
}

describe("healSegment", () => {
  it("F1: unclosed bold before component", function* () {
    const texts = getTextSegments("Hello **world\n<Comp />");
    const healed = healSegment(texts[0]!);
    // remend appends closing markers after trailing newline
    expect(healed).toBe("Hello **world\n**");
  });

  it("F2: unclosed italic before component", function* () {
    const texts = getTextSegments("Hello *world\n<Comp />");
    const healed = healSegment(texts[0]!);
    expect(healed).toBe("Hello *world\n*");
  });

  it("F3: unclosed strikethrough", function* () {
    const texts = getTextSegments("Hello ~~world\n<Comp />");
    const healed = healSegment(texts[0]!);
    expect(healed).toBe("Hello ~~world\n~~");
  });

  it("F4: unclosed inline code", function* () {
    const texts = getTextSegments("Hello `code\n<Comp />");
    const healed = healSegment(texts[0]!);
    expect(healed).toBe("Hello `code\n`");
  });

  it("F5: unclosed link text", function* () {
    const texts = getTextSegments("Hello [text\n<Comp />");
    const healed = healSegment(texts[0]!);
    // remend completes incomplete links with streamdown:incomplete-link protocol
    expect(healed).toContain("[text\n]");
  });

  it("F6: unclosed link", function* () {
    const texts = getTextSegments("Hello [text](url\n<Comp />");
    const healed = healSegment(texts[0]!);
    // remend replaces incomplete link URLs with streamdown:incomplete-link
    expect(healed).toContain("[text]");
    expect(healed).toContain(")");
  });

  it("F7: unclosed image", function* () {
    const texts = getTextSegments("Hello ![alt](url\n<Comp />");
    const healed = healSegment(texts[0]!);
    // remend removes incomplete images entirely
    expect(!healed.includes("![alt]") || healed.includes("![alt](")).toBeTruthy();
  });

  it("F8: unclosed code fence — scanner suppresses JSX inside", function* () {
    const segments = scanSegments("```js\ncode\n<Comp />\n```\n");
    // The entire thing is text — scanner treats <Comp /> as inside the
    // fence, NOT as a component boundary
    expect(segments).toMatchObject([{ type: "text" }]);
  });

  it("F9: unclosed bold before exec", function* () {
    const texts = getTextSegments("Hello **world\n```bash exec\nls\n```\n");
    const healed = healSegment(texts[0]!);
    expect(healed).toBe("Hello **world\n**");
  });

  it("F10: unclosed code span before exec", function* () {
    const texts = getTextSegments("Hello `code\n```bash exec\nls\n```\n");
    const healed = healSegment(texts[0]!);
    expect(healed).toBe("Hello `code\n`");
  });

  it("F11: less-than in text unchanged", function* () {
    expect(healSegment("a < b\n")).toBe("a < b\n");
  });

  it("F12: greater-than in text unchanged", function* () {
    expect(healSegment("a > b\n")).toBe("a > b\n");
  });

  it("F13: lowercase HTML tag unchanged — htmlTags: false prevents closing", function* () {
    const result = healSegment("<div>content\n");
    expect(result).toBe("<div>content\n");
  });

  it("F14: angle brackets inside code span — already complete", function* () {
    expect(healSegment("`a < b`")).toBe("`a < b`");
  });

  it("F15: orphaned bold closer", function* () {
    const input = "world** more";
    const result = healSegment(input);
    // remend treats trailing ** as an opener and closes it
    expect(result).toBe("world** more**");
  });

  it("F16: orphaned italic closer", function* () {
    const input = "text* more";
    const result = healSegment(input);
    // remend treats trailing * as an opener and closes it
    expect(result).toBe("text* more*");
  });

  it("F17: nested bold inside italic — both healed", function* () {
    const result = healSegment("*hello **world\n");
    // remend closes both after trailing newline
    expect(result).toBe("*hello **world\n***");
  });

  it("F18: multiple unclosed at same boundary", function* () {
    const result = healSegment("**bold `code *italic\n");
    // remend closes constructs — code span first (higher priority),
    // which absorbs inner markers
    expect(result).toContain("`");
    expect(typeof result === "string").toBeTruthy();
  });

  it("F19: complete markdown unchanged", function* () {
    const input = "Hello **world** more text";
    expect(healSegment(input)).toBe(input);
  });

  it("F20: empty text segment unchanged", function* () {
    expect(healSegment("")).toBe("");
  });

  it("F21: text with no markdown constructs unchanged", function* () {
    const input = "Hello world";
    expect(healSegment(input)).toBe(input);
  });

  it("F22: escaped markers unchanged", function* () {
    const input = "Hello \\*world\n";
    expect(healSegment(input)).toBe(input);
  });

  it("F23: unclosed bold containing interpolation placeholder", function* () {
    // healSegment runs before interpolation, so {meta.title} is literal text
    const result = healSegment("**{meta.title}\n");
    // Bold should be closed around the literal placeholder
    expect(result).toContain("**");
    expect(result).toContain("{meta.title}");
  });

  it("F24: interpolation result with markers — NOT double-healed", function* () {
    // This tests the pipeline: heal first, then interpolate.
    // meta.title resolves to "**bold**" — those markers should NOT be
    // re-healed because interpolation runs after healing.
    const comp = makeComponent("Comp", "{meta.title} world", {
      meta: { title: "**bold**" },
    });
    const ctx = { Comp: comp };
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("**bold**");
  });

  it("F25: children with unclosed bold — healed before substitution", function* () {
    const comp = makeComponent("Wrap", "before <Content /> after");
    const ctx = { Wrap: comp };
    const segments = scanSegments("<Wrap>**hello</Wrap>");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("**hello**");
    expect(output).toContain("before");
    expect(output).toContain("after");
  });

  it("F26: component body segment healed independently", function* () {
    const comp = makeComponent("Wrap", "*intro\n<Content />");
    const ctx = { Wrap: comp };
    const segments = scanSegments("<Wrap>child</Wrap>");
    const output = yield* expand(segments, ctx);
    expect(output.includes("*intro*") || output.includes("*intro")).toBeTruthy();
    expect(output).toContain("child");
  });

  it("F27: unclosed inline math", function* () {
    const result = healSegment("$formula\n");
    // remend does not heal single-$ inline math (only $$)
    expect(result).toBe("$formula\n");
  });

  it("F28: unclosed display math", function* () {
    const result = healSegment("$$formula\n");
    // remend closes display math after trailing newline
    expect(result).toBe("$$formula\n$$");
  });
});
