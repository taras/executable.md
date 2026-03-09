import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { parseFrontmatter, normalizeInputDef, inferType } from "./frontmatter.ts";

describe("parseFrontmatter", () => {
  // B4: Simple frontmatter (meta only, no inputs)
  it("B4: simple frontmatter — meta keys except inputs", function*() {
    const result = parseFrontmatter({
      emoji: "wave",
      title: "Hello",
    });
    expect(result.meta).toEqual({ emoji: "wave", title: "Hello" });
    expect(result.inputs).toEqual({});
  });

  // B5: Typed meta definitions
  it("B5: typed meta definitions resolve defaults", function*() {
    const result = parseFrontmatter({
      meta: {
        model: { type: "string", enum: ["gpt-4", "claude-3"], default: "gpt-4" },
        temperature: { type: "number", default: 0.7 },
      },
      inputs: {},
    });
    expect(result.meta).toMatchObject({ model: "gpt-4", temperature: 0.7 });
  });

  // B6: Shorthand input — value as default
  it("B6: shorthand input — greeting: Hello", function*() {
    const result = parseFrontmatter({
      inputs: {
        greeting: "Hello",
      },
    });
    const input = result.inputs["greeting"]!;
    expect(input).toMatchObject({ type: "string", default: "Hello", required: false });
  });

  // B7: Full input definition
  it("B7: full input definition — name: { type: string, required: true }", function*() {
    const result = parseFrontmatter({
      inputs: {
        name: { type: "string", required: true },
      },
    });
    const input = result.inputs["name"]!;
    expect(input).toMatchObject({ type: "string", required: true });
    expect(input.default).toBeUndefined();
  });

  // B8: Null shorthand — required, no default
  it("B8: null shorthand — required, type any, no default", function*() {
    const result = parseFrontmatter({
      inputs: {
        name: null,
      },
    });
    const input = result.inputs["name"]!;
    expect(input).toMatchObject({ type: "any", required: true });
    expect(input.default).toBeUndefined();
  });

  // B14: No inputs key — empty inputs
  it("B14: no inputs key — empty inputs record", function*() {
    const result = parseFrontmatter({
      color: "blue",
    });
    expect(result.inputs).toEqual({});
    expect(result.meta["color"]).toBe("blue");
  });

  it("shorthand number default", function*() {
    const result = parseFrontmatter({
      inputs: { count: 0 },
    });
    const input = result.inputs["count"]!;
    expect(input).toMatchObject({ type: "number", default: 0, required: false });
  });

  it("shorthand boolean default", function*() {
    const result = parseFrontmatter({
      inputs: { verbose: false },
    });
    const input = result.inputs["verbose"]!;
    expect(input).toMatchObject({ type: "boolean", default: false, required: false });
  });

  it("shorthand array default", function*() {
    const result = parseFrontmatter({
      inputs: { tags: ["alpha", "beta"] },
    });
    const input = result.inputs["tags"]!;
    expect(input.type).toBe("array");
    expect(input.default).toEqual(["alpha", "beta"]);
  });

  it("full definition with enum", function*() {
    const result = parseFrontmatter({
      inputs: {
        model: {
          type: "string",
          enum: ["gpt-4", "claude-3", "llama-3"],
          default: "gpt-4",
        },
      },
    });
    const input = result.inputs["model"]!;
    expect(input).toMatchObject({ type: "string", default: "gpt-4", required: false });
    expect(input.enum).toEqual(["gpt-4", "claude-3", "llama-3"]);
  });

  it("full definition with description", function*() {
    const result = parseFrontmatter({
      inputs: {
        temperature: {
          type: "number",
          default: 0.7,
          description: "LLM temperature parameter",
        },
      },
    });
    const input = result.inputs["temperature"]!;
    expect(input.description).toBe("LLM temperature parameter");
  });

  it("implied required — no default, required not explicitly set", function*() {
    const result = parseFrontmatter({
      inputs: {
        name: { type: "string" },
      },
    });
    const input = result.inputs["name"]!;
    expect(input.required).toBe(true);
  });

  it("not required — has default, required not explicitly set", function*() {
    const result = parseFrontmatter({
      inputs: {
        greeting: { type: "string", default: "Hello" },
      },
    });
    const input = result.inputs["greeting"]!;
    expect(input.required).toBe(false);
  });

  it("meta with non-typed values under meta key", function*() {
    const result = parseFrontmatter({
      meta: {
        color: "blue",
        count: 42,
      },
      inputs: {},
    });
    expect(result.meta).toMatchObject({ color: "blue", count: 42 });
  });
});

describe("normalizeInputDef", () => {
  it("null → required, type any", function*() {
    const result = normalizeInputDef(null);
    expect(result).toMatchObject({ type: "any", required: true });
  });

  it("string shorthand", function*() {
    const result = normalizeInputDef("Hello");
    expect(result).toMatchObject({ type: "string", default: "Hello", required: false });
  });

  it("object with type key → full definition", function*() {
    const result = normalizeInputDef({
      type: "number",
      default: 42,
    });
    expect(result).toMatchObject({ type: "number", default: 42, required: false });
  });
});

describe("inferType", () => {
  it("string", function*() { expect(inferType("hello")).toBe("string"); });
  it("number", function*() { expect(inferType(42)).toBe("number"); });
  it("boolean", function*() { expect(inferType(true)).toBe("boolean"); });
  it("array", function*() { expect(inferType([1, 2])).toBe("array"); });
  it("object", function*() { expect(inferType({ a: 1 })).toBe("object"); });
  it("undefined", function*() { expect(inferType(undefined)).toBe("any"); });
});
