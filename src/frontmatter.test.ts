import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, normalizeInputDef, inferType } from "./frontmatter.ts";

describe("parseFrontmatter", () => {
  // B4: Simple frontmatter (meta only, no inputs)
  it("B4: simple frontmatter — meta keys except inputs", () => {
    const result = parseFrontmatter({
      emoji: "wave",
      title: "Hello",
    });
    assert.deepEqual(result.meta, { emoji: "wave", title: "Hello" });
    assert.deepEqual(result.inputs, {});
  });

  // B5: Typed meta definitions
  it("B5: typed meta definitions resolve defaults", () => {
    const result = parseFrontmatter({
      meta: {
        model: { type: "string", enum: ["gpt-4", "claude-3"], default: "gpt-4" },
        temperature: { type: "number", default: 0.7 },
      },
      inputs: {},
    });
    assert.equal(result.meta["model"], "gpt-4");
    assert.equal(result.meta["temperature"], 0.7);
  });

  // B6: Shorthand input — value as default
  it("B6: shorthand input — greeting: Hello", () => {
    const result = parseFrontmatter({
      inputs: {
        greeting: "Hello",
      },
    });
    const input = result.inputs["greeting"]!;
    assert.equal(input.type, "string");
    assert.equal(input.default, "Hello");
    assert.equal(input.required, false);
  });

  // B7: Full input definition
  it("B7: full input definition — name: { type: string, required: true }", () => {
    const result = parseFrontmatter({
      inputs: {
        name: { type: "string", required: true },
      },
    });
    const input = result.inputs["name"]!;
    assert.equal(input.type, "string");
    assert.equal(input.required, true);
    assert.equal(input.default, undefined);
  });

  // B8: Null shorthand — required, no default
  it("B8: null shorthand — required, type any, no default", () => {
    const result = parseFrontmatter({
      inputs: {
        name: null,
      },
    });
    const input = result.inputs["name"]!;
    assert.equal(input.type, "any");
    assert.equal(input.required, true);
    assert.equal(input.default, undefined);
  });

  // B14: No inputs key — empty inputs
  it("B14: no inputs key — empty inputs record", () => {
    const result = parseFrontmatter({
      color: "blue",
    });
    assert.deepEqual(result.inputs, {});
    assert.equal(result.meta["color"], "blue");
  });

  it("shorthand number default", () => {
    const result = parseFrontmatter({
      inputs: { count: 0 },
    });
    const input = result.inputs["count"]!;
    assert.equal(input.type, "number");
    assert.equal(input.default, 0);
    assert.equal(input.required, false);
  });

  it("shorthand boolean default", () => {
    const result = parseFrontmatter({
      inputs: { verbose: false },
    });
    const input = result.inputs["verbose"]!;
    assert.equal(input.type, "boolean");
    assert.equal(input.default, false);
    assert.equal(input.required, false);
  });

  it("shorthand array default", () => {
    const result = parseFrontmatter({
      inputs: { tags: ["alpha", "beta"] },
    });
    const input = result.inputs["tags"]!;
    assert.equal(input.type, "array");
    assert.deepEqual(input.default, ["alpha", "beta"]);
  });

  it("full definition with enum", () => {
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
    assert.equal(input.type, "string");
    assert.deepEqual(input.enum, ["gpt-4", "claude-3", "llama-3"]);
    assert.equal(input.default, "gpt-4");
    assert.equal(input.required, false);
  });

  it("full definition with description", () => {
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
    assert.equal(input.description, "LLM temperature parameter");
  });

  it("implied required — no default, required not explicitly set", () => {
    const result = parseFrontmatter({
      inputs: {
        name: { type: "string" },
      },
    });
    const input = result.inputs["name"]!;
    assert.equal(input.required, true);
  });

  it("not required — has default, required not explicitly set", () => {
    const result = parseFrontmatter({
      inputs: {
        greeting: { type: "string", default: "Hello" },
      },
    });
    const input = result.inputs["greeting"]!;
    assert.equal(input.required, false);
  });

  it("meta with non-typed values under meta key", () => {
    const result = parseFrontmatter({
      meta: {
        color: "blue",
        count: 42,
      },
      inputs: {},
    });
    assert.equal(result.meta["color"], "blue");
    assert.equal(result.meta["count"], 42);
  });
});

describe("normalizeInputDef", () => {
  it("null → required, type any", () => {
    const result = normalizeInputDef(null);
    assert.equal(result.type, "any");
    assert.equal(result.required, true);
  });

  it("string shorthand", () => {
    const result = normalizeInputDef("Hello");
    assert.equal(result.type, "string");
    assert.equal(result.default, "Hello");
    assert.equal(result.required, false);
  });

  it("object with type key → full definition", () => {
    const result = normalizeInputDef({
      type: "number",
      default: 42,
    });
    assert.equal(result.type, "number");
    assert.equal(result.default, 42);
    assert.equal(result.required, false);
  });
});

describe("inferType", () => {
  it("string", () => assert.equal(inferType("hello"), "string"));
  it("number", () => assert.equal(inferType(42), "number"));
  it("boolean", () => assert.equal(inferType(true), "boolean"));
  it("array", () => assert.equal(inferType([1, 2]), "array"));
  it("object", () => assert.equal(inferType({ a: 1 }), "object"));
  it("undefined", () => assert.equal(inferType(undefined), "any"));
});
