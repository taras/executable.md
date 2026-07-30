import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { DeclarationError, parseDeclaration } from "../src/declaration.ts";
import { compileForm, SchemaCompileError } from "../src/compile.ts";
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

function asObject(value: Json | JsonObject | undefined): JsonObject {
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

  it("refuses an external reference at every schema position", function* () {
    const external: Array<[string, unknown]> = [
      [
        "properties",
        { type: "object", properties: { a: { $ref: "https://example.test/s.json" } } },
      ],
      ["items", { type: "array", items: { $ref: "./sibling.json" } }],
      ["tuple items", { type: "array", items: [{ $ref: "other.json#/definitions/x" }] }],
      ["allOf", { allOf: [{ $ref: "file:///abs.json" }] }],
      ["definitions", { definitions: { d: { $ref: "https://example.test/d.json" } } }],
      ["additionalProperties", { type: "object", additionalProperties: { $ref: "./a.json" } }],
      ["if", { if: { $ref: "./i.json" } }],
      ["contains", { type: "array", contains: { $ref: "./c.json" } }],
      ["dependencies schema", { type: "object", dependencies: { a: { $ref: "./d.json" } } }],
    ];

    for (const [position, schema] of external) {
      const error = failure(() => parseDeclaration(schema));

      expect({ position, kind: error.name }).toEqual({ position, kind: "DeclarationError" });
      expect(error.message).toContain("outside the supplied schema");
      expect(error.message).toContain("#192");
    }
  });

  /**
   * `const`, `enum`, `default`, and `examples` hold arbitrary JSON. An object in
   * one of them is a value to match, not a subschema, and Ajv never resolves a
   * `$ref` there — so neither does the preflight. Compiling each one is what
   * shows the acceptance is real rather than a deferred failure.
   */
  it("accepts a $ref that is data rather than a reference", function* () {
    const data: Array<[string, unknown]> = [
      [
        "const",
        { type: "object", properties: { a: { const: { $ref: "https://example.test/v" } } } },
      ],
      [
        "enum",
        { type: "object", properties: { a: { enum: [{ $ref: "https://example.test/v" }] } } },
      ],
      [
        "default",
        { type: "object", properties: { a: { default: { $ref: "http://example.test/v" } } } },
      ],
    ];

    for (const [position, schema] of data) {
      const compiled = compileForm(parseDeclaration(schema));

      expect({ position, compiled: typeof compiled.validate }).toEqual({
        position,
        compiled: "function",
      });
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

describe("declaration: __proto__ in a schema position", () => {
  /**
   * Ajv builds its internal tables from schema keys by assignment, so this one
   * name does not survive. `properties: { "__proto__": … }` compiles and then a
   * submission carrying that key is judged as though the property were never
   * declared; `dependencies` compiles and never applies; `required` is refused by
   * strict mode. Rather than claim a support that is not there, the declaration is
   * refused before anything compiles.
   */
  it("refuses __proto__ wherever a schema declares it as a name", function* () {
    const unsupported: Array<{ kind: string; path: string; text: string }> = [
      {
        kind: "property",
        path: "#/properties",
        text: '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
      },
      {
        kind: "property",
        path: "#/properties/o/properties",
        text: '{"type":"object","properties":{"o":{"type":"object","properties":{"__proto__":{"type":"string"}}}}}',
      },
      {
        kind: "required property",
        path: "#/required",
        text: '{"type":"object","properties":{"a":{"type":"string"}},"required":["__proto__"]}',
      },
      {
        kind: "dependency",
        path: "#/dependencies",
        text: '{"type":"object","dependencies":{"__proto__":["a"]}}',
      },
      {
        kind: "property dependency",
        path: "#/dependencies/a",
        text: '{"type":"object","dependencies":{"a":["__proto__"]}}',
      },
      {
        kind: "definition",
        path: "#/definitions",
        text: '{"definitions":{"__proto__":{"type":"string"}}}',
      },
      {
        kind: "pattern property",
        path: "#/patternProperties",
        text: '{"type":"object","patternProperties":{"__proto__":{"type":"string"}}}',
      },
    ];

    for (const { kind, path, text } of unsupported) {
      const error = failure(() => parseDeclaration(text));

      expect({ path, name: error.name }).toEqual({ path, name: "DeclarationError" });
      expect(error.message).toContain(`"__proto__" as a ${kind} at ${path}`);
    }
  });

  it("refuses before anything compiles", function* () {
    const error = failure(() =>
      parseDeclaration('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
    );

    expect(error).toBeInstanceOf(DeclarationError);
    expect(error).not.toBeInstanceOf(SchemaCompileError);
  });

  /** The same string as data is read by nothing, so it is left alone. */
  it("accepts __proto__ as data or descriptive text", function* () {
    const accepted: unknown[] = [
      JSON.parse('{"type":"object","properties":{"a":{"const":{"__proto__":1}}}}'),
      JSON.parse('{"type":"object","properties":{"a":{"enum":[{"__proto__":1}]}}}'),
      { type: "object", title: "how __proto__ behaves", description: "mentions __proto__" },
    ];

    for (const schema of accepted) {
      expect(typeof compileForm(parseDeclaration(schema)).validate).toBe("function");
    }
  });
});

describe("declaration: the JSON parser keeps every key", () => {
  /**
   * `uiSchema` is data all the way through — never compiled, never read as a
   * schema — so `__proto__` is legal there and must survive. It is also what
   * proves the parser normalizes with `defineProperty`: plain assignment reaches
   * `Object.prototype`'s inherited setter for that key, which on Node and Bun
   * replaces the prototype and drops the key while Deno keeps it, so the same
   * declaration would normalize differently per runtime.
   */
  it("keeps an own __proto__ key in a uiSchema", function* () {
    const declaration = parseDeclaration(
      { type: "object" },
      '{"__proto__":{"ui:widget":"hidden"},"ui:order":["a"]}',
    );
    const uiSchema = asObject(declaration.uiSchema);

    expect(Object.keys(uiSchema)).toEqual(["__proto__", "ui:order"]);
    expect(Object.prototype.hasOwnProperty.call(uiSchema, "__proto__")).toBe(true);
    expect(uiSchema["__proto__"]).toEqual({ "ui:widget": "hidden" });
  });

  it("leaves the normalized object an ordinary object", function* () {
    const declaration = parseDeclaration({ type: "object" }, '{"__proto__":{"reached":true}}');

    expect(Object.getPrototypeOf(asObject(declaration.uiSchema))).toBe(Object.prototype);
    expect("reached" in {}).toBe(false);
  });

  it("normalizes an own __proto__ key identically from text and structure", function* () {
    const structured = parseDeclaration(
      { type: "object" },
      JSON.parse('{"__proto__":{"ui:widget":"hidden"}}'),
    );
    const captured = parseDeclaration({ type: "object" }, '{"__proto__":{"ui:widget":"hidden"}}');

    expect(Object.keys(asObject(captured.uiSchema))).toEqual(
      Object.keys(asObject(structured.uiSchema)),
    );
    expect(captured.uiSchema).toEqual(structured.uiSchema);
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
