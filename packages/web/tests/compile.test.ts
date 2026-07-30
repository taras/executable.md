import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { compileForm, SchemaCompileError } from "../src/compile.ts";
import { parseDeclaration } from "../src/declaration.ts";
import { resolveHelper } from "../client/helpers.ts";
import type { Json, JsonObject } from "../src/json.ts";
import { rootValidator, runValidatorScript } from "./validator-script.ts";

/**
 * One schema reaching every axis the two validators could disagree on: a format
 * that must not be asserted, a length bound that reaches `ucs2length`, an object
 * enum that reaches `equal`, an integer that must not be coerced, a property with
 * a default that must not be inserted, a closed object, and a local reference.
 */
const AXES_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    email: { type: "string", format: "email" },
    notes: { type: "string", maxLength: 5 },
    count: { type: "integer" },
    shape: { enum: [{ kind: "a" }, { kind: "b" }] },
    tone: { type: "string", default: "neutral" },
    author: { $ref: "#/definitions/person" },
  },
  definitions: {
    person: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  required: ["decision"],
  additionalProperties: false,
};

function compileAxes(): ReturnType<typeof compileForm> {
  return compileForm(parseDeclaration(AXES_SCHEMA));
}

/** Every case, with the verdict both validators must reach. */
const CASES: Array<{ name: string; data: JsonObject; valid: boolean }> = [
  { name: "a minimal valid submission", data: { decision: "approve" }, valid: true },
  { name: "a value outside the enum", data: { decision: "maybe" }, valid: false },
  { name: "a missing required property", data: {}, valid: false },
  // Formats are disabled on both sides, so this is valid despite the format.
  { name: "a malformed email", data: { decision: "approve", email: "not-an-email" }, valid: true },
  { name: "a string past maxLength", data: { decision: "approve", notes: "abcdef" }, valid: false },
  { name: "a string within maxLength", data: { decision: "approve", notes: "abcde" }, valid: true },
  { name: "an integer as text", data: { decision: "approve", count: "3" }, valid: false },
  { name: "an integer as a number", data: { decision: "approve", count: 3 }, valid: true },
  {
    name: "an object enum member",
    data: { decision: "approve", shape: { kind: "b" } },
    valid: true,
  },
  {
    name: "an object outside the enum",
    data: { decision: "approve", shape: { kind: "c" } },
    valid: false,
  },
  { name: "an unexpected property", data: { decision: "approve", surprise: 1 }, valid: false },
  {
    name: "a local reference satisfied",
    data: { decision: "approve", author: { name: "A" } },
    valid: true,
  },
  { name: "a local reference violated", data: { decision: "approve", author: {} }, valid: false },
];

function clone(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value));
}

describe("compile: the server validator", () => {
  it("agrees with every case", function* () {
    const { validate } = compileAxes();

    for (const testCase of CASES) {
      expect(validate(clone(testCase.data))).toBe(testCase.valid);
    }
  });

  it("never mutates what it validates", function* () {
    const { validate } = compileAxes();

    for (const testCase of CASES) {
      const data = clone(testCase.data);
      const before = JSON.stringify(data);
      validate(data);

      expect(JSON.stringify(data)).toBe(before);
    }
  });

  it("inserts no default, removes no additional property, coerces nothing", function* () {
    const { validate } = compileAxes();

    // `tone` has a schema default; `surprise` is additional and rejected.
    const data: JsonObject = { decision: "approve", count: "3", surprise: 1 };
    expect(validate(data)).toBe(false);
    expect(data).toEqual({ decision: "approve", count: "3", surprise: 1 });
    expect("tone" in data).toBe(false);
  });

  it("collects every error rather than stopping at the first", function* () {
    const { validate } = compileAxes();

    expect(validate({ decision: "maybe", count: "3", notes: "abcdef" })).toBe(false);
    expect(validate.errors?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("compile: the browser validator, executed", () => {
  it("registers a working validator through the real bridge", function* () {
    const compiled = compileAxes();
    const registration = yield* runValidatorScript(compiled.validatorScript);

    expect(registration.schema).toEqual(AXES_SCHEMA);
    expect(Object.keys(registration.validateFns).length).toBe(1);
  });

  it("reaches the same verdict as the server on every case", function* () {
    const compiled = compileAxes();
    const registration = yield* runValidatorScript(compiled.validatorScript);
    const browser = rootValidator(registration);

    for (const testCase of CASES) {
      const browserData = clone(testCase.data);
      const serverData = clone(testCase.data);

      const browserValid = browser(browserData);
      const serverValid = compiled.validate(serverData);

      expect({ case: testCase.name, browserValid, serverValid }).toEqual({
        case: testCase.name,
        browserValid: testCase.valid,
        serverValid: testCase.valid,
      });
    }
  });

  it("never mutates what it validates", function* () {
    const compiled = compileAxes();
    const registration = yield* runValidatorScript(compiled.validatorScript);
    const browser = rootValidator(registration);

    for (const testCase of CASES) {
      const data = clone(testCase.data);
      const before = JSON.stringify(data);
      browser(data);

      expect(JSON.stringify(data)).toBe(before);
    }
  });

  it("collects every error, as the server does", function* () {
    const compiled = compileAxes();
    const registration = yield* runValidatorScript(compiled.validatorScript);
    const browser = rootValidator(registration);

    const data: JsonObject = { decision: "maybe", count: "3", notes: "abcdef" };
    expect(browser(clone(data))).toBe(false);
    expect(compiled.validate(clone(data))).toBe(false);
    expect(browser.errorCount()).toBe(compiled.validate.errors?.length ?? 0);
    expect(browser.errorCount()).toBeGreaterThanOrEqual(3);
  });

  it("receives the uiSchema unchanged and never validates against it", function* () {
    // Not a valid JSON Schema, and it carries a reference that would be refused
    // if it were compiled as one. Arriving intact is the proof it was not.
    const uiSchema = {
      "ui:order": ["decision", "*"],
      type: "not-a-type",
      $ref: "https://example.test/ui.json",
      notes: { "ui:widget": "textarea" },
    };
    const compiled = compileForm(parseDeclaration(AXES_SCHEMA, uiSchema));
    const registration = yield* runValidatorScript(compiled.validatorScript);

    expect(registration.uiSchema).toEqual(uiSchema);
  });

  it("passes no uiSchema when the declaration has none", function* () {
    const registration = yield* runValidatorScript(compileAxes().validatorScript);

    expect(registration.uiSchema).toBe(undefined);
  });
});

describe("compile: what the generated script is allowed to reach", () => {
  it("requests only the two approved runtime helpers", function* () {
    const compiled = compileAxes();
    const registration = yield* runValidatorScript(compiled.validatorScript);

    // The axes schema reaches both: `maxLength` needs `ucs2length` and the object
    // enum needs `equal`. A schema that reached neither would prove nothing.
    expect([...registration.requestedHelpers].sort()).toEqual([
      "ajv/dist/runtime/equal",
      "ajv/dist/runtime/ucs2length",
    ]);
  });

  it("resolves each requested helper to a callable function", function* () {
    for (const id of ["ajv/dist/runtime/equal", "ajv/dist/runtime/ucs2length"]) {
      expect(typeof resolveHelper(id).default).toBe("function");
    }
  });

  it("refuses a helper the compiler never asks for", function* () {
    expect(() => resolveHelper("ajv/dist/runtime/uri")).toThrow("disallowed helper");
    expect(() => resolveHelper("node:fs")).toThrow("disallowed helper");
  });

  it("carries no dynamic code path", function* () {
    const { validatorScript } = compileAxes();

    expect(/\beval\s*\(/.test(validatorScript)).toBe(false);
    expect(/\bnew\s+Function\b/.test(validatorScript)).toBe(false);
    expect(validatorScript.includes("import(")).toBe(false);
  });

  it("resolves every require through the bridge and nothing else", function* () {
    const { validatorScript } = compileAxes();

    // One `require` is defined, and it delegates to the bridge.
    expect(validatorScript).toContain("return bridge.resolveHelper(id);");
    for (const match of validatorScript.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      expect(["ajv/dist/runtime/equal", "ajv/dist/runtime/ucs2length"]).toContain(match[1]);
    }
  });

  it("embeds author text as an inert JSON literal", function* () {
    // `<` and the two line separators are what could change how a literal parses.
    // The proof is not the escaping itself but that the script still executes and
    // the text arrives byte-for-byte.
    const title = "close </script> and \u2028 and \u2029";
    const compiled = compileForm(
      parseDeclaration({ type: "object", properties: { a: { type: "string" } }, title }),
    );

    expect(compiled.validatorScript).toContain("\\u003c");

    const registration = yield* runValidatorScript(compiled.validatorScript);
    expect(registration.schema.title).toBe(title);
  });
});

describe("compile: refusals", () => {
  it("refuses a local pointer that cannot resolve", function* () {
    const declaration = parseDeclaration({
      type: "object",
      properties: { a: { $ref: "#/definitions/missing" } },
    });

    expect(() => compileForm(declaration)).toThrow(SchemaCompileError);
  });

  /**
   * Declaration parsing refuses `$async` first, so reaching the compiler's own
   * check means constructing the declaration directly.
   */
  it("refuses a schema that compiles to an asynchronous validator", function* () {
    expect(() => compileForm({ schema: { $async: true, type: "object" } })).toThrow(
      SchemaCompileError,
    );
  });
});

describe("compile: what the browser and the fingerprint see", () => {
  it("carries the normalized declaration through unchanged", function* () {
    const uiSchema = { "ui:order": ["decision", "*"] };
    const declaration = parseDeclaration(JSON.stringify(AXES_SCHEMA), JSON.stringify(uiSchema));
    const compiled = compileForm(declaration);

    expect(compiled.schema).toEqual(AXES_SCHEMA);
    expect(compiled.uiSchema).toEqual(uiSchema);
  });

  it("embeds only JSON in the script", function* () {
    const compiled = compileAxes();
    const registration = yield* runValidatorScript(compiled.validatorScript);
    const roundTripped: Json = JSON.parse(JSON.stringify(compiled.schema));

    expect(registration.schema).toEqual(roundTripped);
  });
});
