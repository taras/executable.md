import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { DeclarationError, parseDeclaration } from "../src/declaration.ts";
import { SchemaCompileError } from "../src/compile.ts";
import type { Json, JsonObject } from "../src/json.ts";

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    confirmed: { type: "boolean" },
    notes: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
};

const REVIEW_UI_SCHEMA = {
  "ui:order": ["decision", "confirmed", "notes"],
  notes: { "ui:widget": "textarea" },
};

function asObject(value: Json | undefined): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value;
}

function failure(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the declaration to be refused");
}

describe("declaration: both spellings", () => {
  it("normalizes a structured schema and its captured text identically", function* () {
    const structured = parseDeclaration(REVIEW_SCHEMA);
    const captured = parseDeclaration(JSON.stringify(REVIEW_SCHEMA));

    expect(captured.schema).toEqual(structured.schema);
    expect(captured.schema).toEqual(REVIEW_SCHEMA);
  });

  it("normalizes a structured uiSchema and its captured text identically", function* () {
    const structured = parseDeclaration(REVIEW_SCHEMA, REVIEW_UI_SCHEMA);
    const captured = parseDeclaration(REVIEW_SCHEMA, JSON.stringify(REVIEW_UI_SCHEMA));

    expect(captured.uiSchema).toEqual(structured.uiSchema);
    expect(captured.uiSchema).toEqual(REVIEW_UI_SCHEMA);
  });

  it("reads an absent uiSchema as absent rather than empty", function* () {
    expect(parseDeclaration(REVIEW_SCHEMA).uiSchema).toBe(undefined);
    expect("uiSchema" in parseDeclaration(REVIEW_SCHEMA)).toBe(false);
  });

  it("does not alias the caller's value: the normalized schema is its own object", function* () {
    const source = { type: "object", properties: { a: { type: "string" } } };
    const declaration = parseDeclaration(source);

    expect(declaration.schema).toEqual(source);
    expect(declaration.schema).not.toBe(source);
  });
});

describe("declaration: refusals", () => {
  it("refuses malformed schema text", function* () {
    expect(failure(() => parseDeclaration("{ not json")).message).toContain(
      "schema text is not JSON",
    );
  });

  it("refuses malformed uiSchema text", function* () {
    expect(failure(() => parseDeclaration(REVIEW_SCHEMA, "{ not json")).message).toContain(
      "uiSchema text is not JSON",
    );
  });

  it("refuses a non-object root in either spelling", function* () {
    for (const value of ["[]", "42", '"text"', "null", "true"]) {
      expect(failure(() => parseDeclaration(value)).message).toContain(
        "schema must be a JSON object",
      );
    }
    for (const value of [[], 42, null, true]) {
      expect(failure(() => parseDeclaration(value)).message).toContain(
        "schema must be a JSON object",
      );
    }
  });

  it("refuses a structured value that is not JSON", function* () {
    const circular: Record<string, unknown> = { type: "object" };
    circular.self = circular;

    const nonJson: unknown[] = [
      { type: "object", properties: () => true },
      { type: "object", nested: { deep: undefined } },
      { type: "object", when: new Date(0) },
      { type: "object", size: Number.NaN },
      { type: "object", tag: Symbol("tag") },
      circular,
    ];

    for (const value of nonJson) {
      expect(failure(() => parseDeclaration(value))).toBeInstanceOf(DeclarationError);
    }
  });

  it("refuses an asynchronous schema", function* () {
    const error = failure(() => parseDeclaration({ $async: true, type: "object" }));

    expect(error).toBeInstanceOf(DeclarationError);
    expect(error.message).toContain("must not be asynchronous");
  });

  it("refuses a schema draft-07 does not describe", function* () {
    for (const invalid of [{ type: "not-a-type" }, { type: "string", minLength: "long" }]) {
      const error = failure(() => parseDeclaration(invalid));

      expect(error).toBeInstanceOf(DeclarationError);
      expect(error.message).toContain("not a valid draft-07 JSON Schema");
    }
  });

  it("refuses an external reference and names #192", function* () {
    const external = [
      { type: "object", properties: { a: { $ref: "https://example.test/s.json" } } },
      { type: "object", properties: { a: { $ref: "./sibling.json" } } },
      { type: "object", properties: { a: { $ref: "other.json#/definitions/x" } } },
      { definitions: { deep: { items: [{ $ref: "file:///abs.json" }] } } },
    ];

    for (const schema of external) {
      const error = failure(() => parseDeclaration(schema));

      expect(error).toBeInstanceOf(DeclarationError);
      expect(error.message).toContain("outside the supplied schema");
      expect(error.message).toContain("#192");
    }
  });

  /**
   * The scan does not track schema position, so a `$ref` used as a literal value
   * is refused too. Recorded rather than hidden: a schema that would have worked
   * is turned away, which is the safe direction and the reason the trade-off is
   * stated in `declaration.ts`.
   */
  it("refuses a $ref used as data, not as a reference", function* () {
    for (const schema of [
      { type: "object", properties: { a: { const: { $ref: "https://example.test/x" } } } },
      { type: "object", properties: { a: { enum: [{ $ref: "https://example.test/x" }] } } },
    ]) {
      expect(failure(() => parseDeclaration(schema))).toBeInstanceOf(DeclarationError);
    }
  });

  it("accepts a schema property named $ref", function* () {
    const declaration = parseDeclaration({
      type: "object",
      properties: { $ref: { type: "string" } },
    });

    expect(asObject(declaration.schema.properties)["$ref"]).toEqual({ type: "string" });
  });

  /**
   * Ajv reports an unreachable external reference and a mistyped local pointer
   * with the same message, so a local pointer must not be reported as the
   * deferred external case.
   */
  it("does not blame #192 for a local pointer that cannot resolve", function* () {
    const declaration = parseDeclaration({
      type: "object",
      properties: { a: { $ref: "#/definitions/missing" } },
    });

    expect(declaration.schema).toBeDefined();
  });
});

describe("declaration: what refusal precedes", () => {
  /**
   * Every refusal above is a `DeclarationError`, and compilation raises
   * `SchemaCompileError`. A refused declaration therefore never reaches the
   * compiler — which is what will keep it from reaching a port, a browser, or the
   * journal once those exist.
   */
  it("refuses in parsing, before anything compiles", function* () {
    for (const schema of [
      "{ not json",
      "[]",
      { $async: true, type: "object" },
      { type: "not-a-type" },
      { type: "object", properties: { a: { $ref: "https://example.test/s.json" } } },
    ]) {
      const error = failure(() => parseDeclaration(schema));

      expect(error).toBeInstanceOf(DeclarationError);
      expect(error).not.toBeInstanceOf(SchemaCompileError);
    }
  });

  it("accepts a local reference", function* () {
    const declaration = parseDeclaration({
      type: "object",
      properties: { note: { $ref: "#/definitions/note" } },
      definitions: { note: { type: "string" } },
    });

    expect(declaration.schema.definitions).toEqual({ note: { type: "string" } });
  });
});

describe("declaration: normalization is the same everywhere", () => {
  /**
   * `__proto__` is an ordinary JSON key and a legal schema property name, but
   * `object[key] = value` reaches `Object.prototype`'s inherited setter for it.
   * What that does differs by engine — V8 replaces the prototype and drops the
   * key, JavaScriptCore likewise, Deno keeps it — so a declaration carrying one
   * would normalize differently per runtime, and the object PR 5 fingerprints for
   * the journal would differ with it.
   */
  it("keeps a __proto__ key as an ordinary property", function* () {
    const declaration = parseDeclaration(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    );
    const properties = declaration.schema.properties;

    expect(Object.keys(declaration.schema)).toEqual(["type", "properties"]);
    expect(Object.keys(asObject(properties))).toEqual(["__proto__"]);
    expect(asObject(properties)["__proto__"]).toEqual({ type: "string" });
  });

  it("leaves the normalized object an ordinary object", function* () {
    const declaration = parseDeclaration('{"__proto__":{"reached":true},"type":"object"}');

    expect(Object.getPrototypeOf(declaration.schema)).toBe(Object.prototype);
    expect(Object.keys(declaration.schema)).toEqual(["__proto__", "type"]);
    expect("reached" in {}).toBe(false);
  });

  it("normalizes a __proto__ key identically from text and structure", function* () {
    const structured = parseDeclaration({
      type: "object",
      properties: JSON.parse('{"__proto__":{"type":"string"}}'),
    });
    const captured = parseDeclaration(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    );

    expect(Object.keys(asObject(captured.schema.properties))).toEqual(
      Object.keys(asObject(structured.schema.properties)),
    );
  });
});

describe("declaration: uiSchema is not a schema", () => {
  /**
   * RJSF configuration is not JSON Schema, and a strict draft-07 validator
   * rejects most of it. Each of these would be refused if `uiSchema` were
   * compiled the way `schema` is, so each one passing is the evidence that it
   * is not.
   */
  it("accepts a uiSchema that is not a valid JSON Schema", function* () {
    const declaration = parseDeclaration(REVIEW_SCHEMA, {
      "ui:order": ["decision", "*"],
      type: "not-a-type",
    });

    expect(declaration.uiSchema).toEqual({ "ui:order": ["decision", "*"], type: "not-a-type" });
  });

  it("accepts a uiSchema carrying $async", function* () {
    const declaration = parseDeclaration(REVIEW_SCHEMA, { $async: true, "ui:order": ["decision"] });

    expect(declaration.uiSchema).toEqual({ $async: true, "ui:order": ["decision"] });
  });

  it("accepts a uiSchema carrying an external reference", function* () {
    const declaration = parseDeclaration(REVIEW_SCHEMA, {
      $ref: "https://example.test/ui.json",
    });

    expect(declaration.uiSchema).toEqual({ $ref: "https://example.test/ui.json" });
  });

  it("carries RJSF directives through untouched", function* () {
    const uiSchema = {
      "ui:order": ["decision", "notes"],
      "ui:submitButtonOptions": { norender: false, submitText: "Send" },
      notes: { "ui:widget": "textarea", "ui:options": { rows: 4 } },
    };

    expect(parseDeclaration(REVIEW_SCHEMA, uiSchema).uiSchema).toEqual(uiSchema);
  });
});
