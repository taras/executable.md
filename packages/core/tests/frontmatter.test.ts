import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  // B4: Simple frontmatter (meta only, no props)
  it("B4: simple frontmatter — meta keys except props", function* () {
    const result = parseFrontmatter({
      emoji: "wave",
      title: "Hello",
    });
    expect(result.meta).toEqual({ emoji: "wave", title: "Hello" });
    expect(result.props).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  // B5: Typed meta definitions
  it("B5: typed meta definitions resolve defaults", function* () {
    const result = parseFrontmatter({
      meta: {
        model: { type: "string", enum: ["gpt-4", "claude-3"], default: "gpt-4" },
        temperature: { type: "number", default: 0.7 },
      },
      props: { type: "object", properties: {}, additionalProperties: false },
    });
    expect(result.meta).toMatchObject({ model: "gpt-4", temperature: 0.7 });
  });

  // B14: No props key — closed empty-object schema
  it("B14: no props key — closed empty-object schema", function* () {
    const result = parseFrontmatter({ color: "blue" });
    expect(result.props).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(result.meta["color"]).toBe("blue");
  });

  it("passes a declared props schema through verbatim", function* () {
    const schema = {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" } },
      },
      required: ["files"],
      additionalProperties: false,
    };
    const result = parseFrontmatter({ props: schema });
    expect(result.props).toEqual(schema);
  });

  it("accepts a draft-07 $schema dialect", function* () {
    const result = parseFrontmatter({
      props: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    expect(result.props["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("rejects a non-draft-07 $schema dialect", function* () {
    expect(() =>
      parseFrontmatter({
        props: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
        },
      }),
    ).toThrow("draft-07");
  });

  it("rejects a non-object props value", function* () {
    expect(() => parseFrontmatter({ props: "not-a-schema" })).toThrow("JSON object");
  });

  it("rejects an array props value", function* () {
    expect(() => parseFrontmatter({ props: [1, 2, 3] })).toThrow("JSON object");
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
    expect(parseFrontmatter(null).props).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(parseFrontmatter(undefined).meta).toEqual({});
  });

  it("meta with non-typed values under meta key", function* () {
    const result = parseFrontmatter({
      meta: { color: "blue", count: 42 },
      props: { type: "object", properties: {}, additionalProperties: false },
    });
    expect(result.meta).toMatchObject({ color: "blue", count: 42 });
  });
});

describe("parseFrontmatter — full-form classification", () => {
  it('a "type" key selects the full form', function* () {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(parseFrontmatter({ props: schema }).props).toEqual(schema);
  });

  it('a "$schema" key selects the full form without a type', function* () {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", properties: {} };
    // Returned unchanged; the missing root type is the compiler's to report.
    expect(parseFrontmatter({ props: schema }).props).toEqual(schema);
  });

  it("a malformed full declaration is not read as a property map", function* () {
    const schema = { type: "array", items: { type: "string" } };
    const { props } = parseFrontmatter({ props: schema });
    expect(props).toEqual(schema);
    expect(props["properties"]).toBeUndefined();
  });

  it('the full form declares properties named "type" and "$schema"', function* () {
    const schema = {
      type: "object",
      properties: { type: { type: "string" }, $schema: { type: "string" } },
      additionalProperties: false,
    };
    expect(parseFrontmatter({ props: schema }).props).toEqual(schema);
  });
});

describe("parseFrontmatter — concise props", () => {
  const CONCISE = {
    required: ["name"],
    props: {
      name: { type: "string" },
      loud: { type: "boolean", default: false },
    },
  };

  const FULL = {
    props: {
      type: "object",
      properties: {
        name: { type: "string" },
        loud: { type: "boolean", default: false },
      },
      required: ["name"],
      additionalProperties: false,
    },
  };

  it("B16: a props map normalizes to a closed object schema", function* () {
    expect(parseFrontmatter(CONCISE).props).toEqual(FULL.props);
  });

  it("the concise and full spellings declare the same schema", function* () {
    expect(parseFrontmatter(CONCISE).props).toEqual(parseFrontmatter(FULL).props);
  });

  it("omits required when the frontmatter declares none", function* () {
    const { props } = parseFrontmatter({ props: { name: { type: "string" } } });
    expect(props).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    });
    expect("required" in props).toBe(false);
  });

  it("an empty props map is the empty closed schema", function* () {
    expect(parseFrontmatter({ props: {} }).props).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("accepts boolean property schemas", function* () {
    const { props } = parseFrontmatter({ props: { anything: true, impossible: false } });
    expect(props["properties"]).toEqual({ anything: true, impossible: false });
  });

  it("B17: top-level required enters the schema, not the metadata", function* () {
    const result = parseFrontmatter({
      title: "Greeting",
      required: ["name"],
      props: { name: { type: "string" } },
    });
    expect(result.props["required"]).toEqual(["name"]);
    expect(result.meta).toEqual({ title: "Greeting" });
  });

  it("returns a fresh schema on every parse", function* () {
    const first = parseFrontmatter(CONCISE).props;
    const second = parseFrontmatter(CONCISE).props;
    expect(first).not.toBe(second);
    expect(first["properties"]).not.toBe(second["properties"]);
  });

  it("does not mutate the frontmatter it parsed", function* () {
    const frontmatter = { required: ["name"], props: { name: { type: "string" } } };
    parseFrontmatter(frontmatter);
    expect(frontmatter).toEqual({ required: ["name"], props: { name: { type: "string" } } });
  });

  it("B18: rejects top-level required alongside a full schema", function* () {
    expect(() =>
      parseFrontmatter({ required: ["name"], props: { type: "object", properties: {} } }),
    ).toThrow("alongside a full");
  });

  it("rejects required without props", function* () {
    expect(() => parseFrontmatter({ required: ["name"] })).toThrow('"required" without "props"');
  });

  // `inputs` is ordinary metadata, not a compatibility alias for `props`, so a
  // document declaring it is left with no declared props at all.
  it("treats a full `inputs` schema as ordinary metadata, not a props declaration", function* () {
    const declared = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };
    const result = parseFrontmatter({ inputs: declared });
    expect(result.meta["inputs"]).toEqual(declared);
    expect(result.props).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  // Top-level `required` remains reserved, so this fails during parsing rather
  // than degrading quietly the way a full `inputs` schema does.
  it("rejects a concise `inputs` map declared with a top-level `required`", function* () {
    expect(() =>
      parseFrontmatter({ inputs: { name: { type: "string" } }, required: ["name"] }),
    ).toThrow('"required" without "props"');
  });

  it("rejects a required name that no prop declares", function* () {
    expect(() =>
      parseFrontmatter({ required: ["email"], props: { name: { type: "string" } } }),
    ).toThrow('names "email"');
  });

  it("rejects a required list that is not an array of strings", function* () {
    expect(() => parseFrontmatter({ required: "name", props: { name: {} } })).toThrow(
      "must be an array",
    );
    expect(() => parseFrontmatter({ required: [1], props: { name: {} } })).toThrow("as strings");
  });

  it("rejects a property definition that is not a schema", function* () {
    expect(() => parseFrontmatter({ props: { name: "string" } })).toThrow(
      "JSON Schema object or boolean",
    );
    expect(() => parseFrontmatter({ props: { name: ["string"] } })).toThrow(
      "JSON Schema object or boolean",
    );
    expect(() => parseFrontmatter({ props: { name: null } })).toThrow(
      "JSON Schema object or boolean",
    );
  });
});
