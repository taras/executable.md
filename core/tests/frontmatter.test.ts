import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  // B4: Simple frontmatter (meta only, no inputs)
  it("B4: simple frontmatter — meta keys except inputs", function* () {
    const result = parseFrontmatter({
      emoji: "wave",
      title: "Hello",
    });
    expect(result.meta).toEqual({ emoji: "wave", title: "Hello" });
    expect(result.inputs).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  // B5: Typed meta definitions
  it("B5: typed meta definitions resolve defaults", function* () {
    const result = parseFrontmatter({
      meta: {
        model: { type: "string", enum: ["gpt-4", "claude-3"], default: "gpt-4" },
        temperature: { type: "number", default: 0.7 },
      },
      inputs: { type: "object", properties: {}, additionalProperties: false },
    });
    expect(result.meta).toMatchObject({ model: "gpt-4", temperature: 0.7 });
  });

  // B14: No inputs key — closed empty-object schema
  it("B14: no inputs key — closed empty-object schema", function* () {
    const result = parseFrontmatter({ color: "blue" });
    expect(result.inputs).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(result.meta["color"]).toBe("blue");
  });

  it("passes a declared input schema through verbatim", function* () {
    const schema = {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" } },
      },
      required: ["files"],
      additionalProperties: false,
    };
    const result = parseFrontmatter({ inputs: schema });
    expect(result.inputs).toEqual(schema);
  });

  it("accepts a draft-07 $schema dialect", function* () {
    const result = parseFrontmatter({
      inputs: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    expect(result.inputs["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("rejects a non-draft-07 $schema dialect", function* () {
    expect(() =>
      parseFrontmatter({
        inputs: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
        },
      }),
    ).toThrow("draft-07");
  });

  it("rejects a non-object inputs value", function* () {
    expect(() => parseFrontmatter({ inputs: "not-a-schema" })).toThrow("JSON object");
  });

  it("rejects an array inputs value", function* () {
    expect(() => parseFrontmatter({ inputs: [1, 2, 3] })).toThrow("JSON object");
  });

  it("rejects a non-mapping frontmatter root", function* () {
    expect(() => parseFrontmatter("nope")).toThrow("frontmatter must be a mapping");
    expect(() => parseFrontmatter([1, 2])).toThrow("frontmatter must be a mapping");
  });

  it("treats null/undefined frontmatter as empty", function* () {
    expect(parseFrontmatter(null).inputs).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(parseFrontmatter(undefined).meta).toEqual({});
  });

  it("meta with non-typed values under meta key", function* () {
    const result = parseFrontmatter({
      meta: { color: "blue", count: 42 },
      inputs: { type: "object", properties: {}, additionalProperties: false },
    });
    expect(result.meta).toMatchObject({ color: "blue", count: 42 });
  });
});
