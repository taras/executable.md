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

  it("rejects a non-object frontmatter root", function* () {
    expect(() => parseFrontmatter("nope")).toThrow("JSON object");
    expect(() => parseFrontmatter([1, 2])).toThrow("JSON object");
    expect(() => parseFrontmatter(42)).toThrow("JSON object");
  });

  it("rejects a non-JSON value anywhere in the frontmatter", function* () {
    expect(() => parseFrontmatter({ meta: { handler: () => {} } })).toThrow("function");
    expect(() => parseFrontmatter({ title: 1 / 0 })).toThrow("non-finite");
  });

  it("rejects a sparse array in the frontmatter", function* () {
    const holed = ["x"];
    holed[2] = "y";
    expect(() => parseFrontmatter({ tags: holed })).toThrow("missing array element");
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

describe("parseFrontmatter — full-form classification", () => {
  it('a "type" key selects the full form', function* () {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(parseFrontmatter({ inputs: schema }).inputs).toEqual(schema);
  });

  it('a "$schema" key selects the full form without a type', function* () {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", properties: {} };
    // Returned unchanged; the missing root type is the compiler's to report.
    expect(parseFrontmatter({ inputs: schema }).inputs).toEqual(schema);
  });

  it("a malformed full declaration is not read as a property map", function* () {
    const schema = { type: "array", items: { type: "string" } };
    const { inputs } = parseFrontmatter({ inputs: schema });
    expect(inputs).toEqual(schema);
    expect(inputs["properties"]).toBeUndefined();
  });

  it('the full form declares properties named "type" and "$schema"', function* () {
    const schema = {
      type: "object",
      properties: { type: { type: "string" }, $schema: { type: "string" } },
      additionalProperties: false,
    };
    expect(parseFrontmatter({ inputs: schema }).inputs).toEqual(schema);
  });
});

describe("parseFrontmatter — concise inputs", () => {
  const CONCISE = {
    required: ["name"],
    inputs: {
      name: { type: "string" },
      loud: { type: "boolean", default: false },
    },
  };

  const FULL = {
    inputs: {
      type: "object",
      properties: {
        name: { type: "string" },
        loud: { type: "boolean", default: false },
      },
      required: ["name"],
      additionalProperties: false,
    },
  };

  it("B16: an inputs map normalizes to a closed object schema", function* () {
    expect(parseFrontmatter(CONCISE).inputs).toEqual(FULL.inputs);
  });

  it("the concise and full spellings declare the same schema", function* () {
    expect(parseFrontmatter(CONCISE).inputs).toEqual(parseFrontmatter(FULL).inputs);
  });

  it("omits required when the frontmatter declares none", function* () {
    const { inputs } = parseFrontmatter({ inputs: { name: { type: "string" } } });
    expect(inputs).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    });
    expect("required" in inputs).toBe(false);
  });

  it("an empty inputs map is the empty closed schema", function* () {
    expect(parseFrontmatter({ inputs: {} }).inputs).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("accepts boolean property schemas", function* () {
    const { inputs } = parseFrontmatter({ inputs: { anything: true, impossible: false } });
    expect(inputs["properties"]).toEqual({ anything: true, impossible: false });
  });

  it("B17: top-level required enters the schema, not the metadata", function* () {
    const result = parseFrontmatter({
      title: "Greeting",
      required: ["name"],
      inputs: { name: { type: "string" } },
    });
    expect(result.inputs["required"]).toEqual(["name"]);
    expect(result.meta).toEqual({ title: "Greeting" });
  });

  it("returns a fresh schema on every parse", function* () {
    const first = parseFrontmatter(CONCISE).inputs;
    const second = parseFrontmatter(CONCISE).inputs;
    expect(first).not.toBe(second);
    expect(first["properties"]).not.toBe(second["properties"]);
  });

  it("does not mutate the frontmatter it parsed", function* () {
    const frontmatter = { required: ["name"], inputs: { name: { type: "string" } } };
    parseFrontmatter(frontmatter);
    expect(frontmatter).toEqual({ required: ["name"], inputs: { name: { type: "string" } } });
  });

  it("B18: rejects top-level required alongside a full schema", function* () {
    expect(() =>
      parseFrontmatter({ required: ["name"], inputs: { type: "object", properties: {} } }),
    ).toThrow("alongside a full");
  });

  it("rejects required without inputs", function* () {
    expect(() => parseFrontmatter({ required: ["name"] })).toThrow('"required" without "inputs"');
  });

  it("rejects a required name that no input declares", function* () {
    expect(() =>
      parseFrontmatter({ required: ["email"], inputs: { name: { type: "string" } } }),
    ).toThrow('names "email"');
  });

  it("rejects a required list that is not an array of strings", function* () {
    expect(() => parseFrontmatter({ required: "name", inputs: { name: {} } })).toThrow(
      "must be an array",
    );
    expect(() => parseFrontmatter({ required: [1], inputs: { name: {} } })).toThrow("as strings");
  });

  it("rejects a property definition that is not a schema", function* () {
    expect(() => parseFrontmatter({ inputs: { name: "string" } })).toThrow(
      "JSON Schema object or boolean",
    );
    expect(() => parseFrontmatter({ inputs: { name: ["string"] } })).toThrow(
      "JSON Schema object or boolean",
    );
    expect(() => parseFrontmatter({ inputs: { name: null } })).toThrow(
      "JSON Schema object or boolean",
    );
  });
});
