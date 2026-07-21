import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import {
  compileInputSchema,
  InputSchemaError,
  PropValidationError,
  validateProps,
} from "../src/validate.ts";
import type { Json } from "../src/types.ts";

function closed(properties: Record<string, Json>, required?: string[]): Record<string, Json> {
  return {
    type: "object",
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  };
}

describe("compileInputSchema — root-input contract", () => {
  it("rejects a root schema that is not type: object", function* () {
    expect(() => compileInputSchema({})).toThrow(InputSchemaError);
    expect(() => compileInputSchema({ type: "array" })).toThrow('type: "object"');
  });

  it("rejects reserved slot/as as declared properties", function* () {
    expect(() => compileInputSchema(closed({ slot: { type: "string" } }))).toThrow("reserved");
    expect(() => compileInputSchema(closed({ as: { type: "string" } }))).toThrow("reserved");
  });

  it("rejects a malformed schema via Ajv meta-validation", function* () {
    expect(() => compileInputSchema(closed({ n: { type: "not-a-type" } }))).toThrow(
      InputSchemaError,
    );
  });

  it("rejects an async schema before compiling", function* () {
    expect(() =>
      compileInputSchema({
        $async: true,
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    ).toThrow("async");
  });

  it("rejects a remote/unresolved $ref at compile time", function* () {
    expect(() =>
      compileInputSchema(closed({ x: { $ref: "https://example.com/schema.json" } })),
    ).toThrow(InputSchemaError);
  });

  it("compiles duplicate $id schemas independently (addUsedSchema: false)", function* () {
    const a = { $id: "https://example.com/dup", ...closed({ a: { type: "string" } }) };
    const b = { $id: "https://example.com/dup", ...closed({ b: { type: "number" } }) };
    expect(() => compileInputSchema(a)).not.toThrow();
    expect(() => compileInputSchema(b)).not.toThrow();
  });
});

describe("validateProps — canonical validation", () => {
  it("accepts required props and rejects when missing", function* () {
    const schema = closed({ files: { type: "array", items: { type: "string" } } }, ["files"]);
    expect(validateProps("C", { files: ["a"] }, schema)).toEqual({ files: ["a"] });
    expect(() => validateProps("C", {}, schema)).toThrow("must have required property");
  });

  it("validates a scalar array's element type", function* () {
    const schema = closed({ files: { type: "array", items: { type: "string" } } }, ["files"]);
    try {
      validateProps("C", { files: ["a", 2] }, schema);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PropValidationError);
      if (error instanceof PropValidationError) {
        expect(error.issues.some((i) => i.instancePath === "/files/1")).toBe(true);
        expect(error.issues.some((i) => i.message.includes("must be string"))).toBe(true);
      }
    }
  });

  it("validates arrays of structured objects with required keys and additionalProperties", function* () {
    const row = {
      type: "object",
      properties: { symbol: { type: "string" }, line: { type: "number" } },
      required: ["symbol"],
      additionalProperties: false,
    };
    const schema = closed({ rows: { type: "array", items: row } }, ["rows"]);
    expect(validateProps("C", { rows: [{ symbol: "x", line: 1 }] }, schema)).toEqual({
      rows: [{ symbol: "x", line: 1 }],
    });
    expect(() => validateProps("C", { rows: [{ line: 1 }] }, schema)).toThrow(
      "must have required property",
    );
    expect(() => validateProps("C", { rows: [{ symbol: "x", extra: 1 }] }, schema)).toThrow(
      "must NOT have additional properties",
    );
  });

  it("rejects additional (undeclared) top-level props", function* () {
    expect(() => validateProps("C", { nope: 1 }, closed({}))).toThrow(
      "must NOT have additional properties",
    );
  });

  it("rejects an invalid enum value", function* () {
    const schema = closed({ level: { type: "string", enum: ["info", "warn"] } });
    expect(() => validateProps("C", { level: "bad" }, schema)).toThrow(
      "must be equal to one of the allowed values",
    );
  });

  it("enforces nested enum constraints", function* () {
    const row = {
      type: "object",
      properties: { level: { type: "string", enum: ["info", "warn"] } },
      required: ["level"],
      additionalProperties: false,
    };
    const schema = closed({ rows: { type: "array", items: row } }, ["rows"]);
    expect(() => validateProps("C", { rows: [{ level: "bad" }] }, schema)).toThrow(
      "must be equal to one of the allowed values",
    );
  });

  it("allows unconstrained {} and true nested schemas", function* () {
    const schema = closed({ anything: {}, whatever: true });
    expect(validateProps("C", { anything: [1, { a: 2 }], whatever: "x" }, schema)).toEqual({
      anything: [1, { a: 2 }],
      whatever: "x",
    });
  });
});

describe("validateProps — defaults", () => {
  it("fills object-property defaults recursively without synthesizing a missing parent", function* () {
    const schema = closed({
      cfg: {
        type: "object",
        properties: { x: { type: "number", default: 5 } },
        additionalProperties: false,
      },
    });
    expect(validateProps("C", { cfg: {} }, schema)).toEqual({ cfg: { x: 5 } });
    expect(validateProps("C", {}, schema)).toEqual({});
  });

  it("extends an array from tuple-item defaults (Ajv behavior)", function* () {
    const schema = closed({
      pair: {
        type: "array",
        items: [
          { type: "string", default: "a" },
          { type: "string", default: "b" },
        ],
        minItems: 2,
        additionalItems: false,
      },
    });
    expect(validateProps("C", { pair: [] }, schema)).toEqual({ pair: ["a", "b"] });
    expect(validateProps("C", { pair: ["x"] }, schema)).toEqual({ pair: ["x", "b"] });

    const caller: Record<string, Json> = { pair: [] };
    expect(validateProps("C", caller, schema)).toEqual({ pair: ["a", "b"] });
    expect(caller).toEqual({ pair: [] });
  });

  it("never mutates the caller's props object", function* () {
    const schema = closed({
      greeting: { type: "string", default: "Hello" },
      cfg: {
        type: "object",
        properties: { x: { type: "number", default: 5 } },
        default: {},
        additionalProperties: false,
      },
    });
    const caller: Record<string, Json> = {};
    const result = validateProps("C", caller, schema);
    expect(result).toEqual({ greeting: "Hello", cfg: { x: 5 } });
    expect(caller).toEqual({});
  });
});

describe("validateProps — structured cause & error normalization", () => {
  it("exposes normalized, JSON-safe issues with precise instance paths", function* () {
    const schema = closed({ n: { type: "number" } }, ["n"]);
    try {
      validateProps("Widget", { n: "no" }, schema);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PropValidationError);
      if (error instanceof PropValidationError) {
        expect(error.componentName).toBe("Widget");
        expect(error.errors.length).toBeGreaterThan(0);
        const issue = error.issues.find((i) => i.instancePath === "/n");
        expect(issue).toBeDefined();
        expect(issue?.keyword).toBe("type");
        expect(() => JSON.stringify(error.issues)).not.toThrow();
      }
    }
  });

  it("readable errors name the precise nested property; cause.errors keep raw Ajv paths", function* () {
    const row = {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
      additionalProperties: false,
    };
    const schema = closed({ rows: { type: "array", items: row } }, ["rows"]);

    try {
      validateProps("C", { rows: [{}] }, schema);
      throw new Error("should have thrown");
    } catch (error) {
      if (!(error instanceof PropValidationError)) {
        throw error;
      }
      expect(error.errors.some((m) => m.includes('"/rows/0/symbol"'))).toBe(true);
      expect(
        error.issues.some((i) => i.instancePath === "/rows/0" && i.keyword === "required"),
      ).toBe(true);
    }

    try {
      validateProps("C", { rows: [{ symbol: "x", extra: 1 }] }, schema);
      throw new Error("should have thrown");
    } catch (error) {
      if (!(error instanceof PropValidationError)) {
        throw error;
      }
      expect(error.errors.some((m) => m.includes('"/rows/0/extra"'))).toBe(true);
      expect(
        error.issues.some(
          (i) => i.instancePath === "/rows/0" && i.keyword === "additionalProperties",
        ),
      ).toBe(true);
    }
  });

  it("escapes JSON Pointer tokens (/ and ~) in required and additionalProperties paths", function* () {
    try {
      validateProps("C", {}, closed({ "a/b~c": { type: "string" } }, ["a/b~c"]));
      throw new Error("should have thrown");
    } catch (error) {
      if (!(error instanceof PropValidationError)) {
        throw error;
      }
      expect(error.errors.some((m) => m.includes('"/a~1b~0c"'))).toBe(true);
      const issue = error.issues.find((i) => i.keyword === "required");
      expect(issue?.instancePath).toBe("");
      expect(issue?.params).toMatchObject({ missingProperty: "a/b~c" });
    }

    try {
      validateProps("C", { "a/b~c": 1 }, closed({}));
      throw new Error("should have thrown");
    } catch (error) {
      if (!(error instanceof PropValidationError)) {
        throw error;
      }
      expect(error.errors.some((m) => m.includes('"/a~1b~0c"'))).toBe(true);
      expect(error.issues.find((i) => i.keyword === "additionalProperties")?.params).toMatchObject({
        additionalProperty: "a/b~c",
      });
    }
  });

  it("normalizes failure-safe when Ajv omits message or supplies non-JSON params", function* () {
    const error = new PropValidationError("C", [
      {
        keyword: "custom",
        instancePath: "/a",
        schemaPath: "#/a",
        params: { fn: () => {}, nested: { ok: 1 } },
        message: undefined,
      },
    ]);
    expect(error.issues[0]?.message).toBe("");
    expect(error.issues[0]?.params).toEqual({});
    expect(() => JSON.stringify(error.issues)).not.toThrow();
  });

  it("treats format as an annotation, not an assertion", function* () {
    const schema = closed({ email: { type: "string", format: "email" } });
    expect(validateProps("C", { email: "not-an-email" }, schema)).toEqual({
      email: "not-an-email",
    });
  });

  it("validates a local $ref", function* () {
    const schema = {
      type: "object",
      properties: { x: { $ref: "#/definitions/pos" } },
      definitions: { pos: { type: "number", minimum: 0 } },
      additionalProperties: false,
    };
    expect(validateProps("C", { x: 5 }, schema)).toEqual({ x: 5 });
    expect(() => validateProps("C", { x: -1 }, schema)).toThrow(PropValidationError);
  });
});
