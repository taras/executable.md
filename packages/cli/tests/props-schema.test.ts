/**
 * Tier PS — the Zod adapter against Ajv (specs/root-document-inputs-spec.md).
 *
 * `z.fromJSONSchema()` is semi-experimental, so the behavior the CLI
 * depends on is pinned here rather than assumed. Ajv remains authoritative
 * for whole-object validation; these compare the two only where the
 * adapter has to agree with it.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { validateProps } from "@executablemd/core";
import type { InputSchema } from "@executablemd/core";
import { z } from "zod";

type JsonSchemaInput = Parameters<typeof z.fromJSONSchema>[0];

function isJsonSchemaInput(value: unknown): value is JsonSchemaInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeOf(schema: InputSchema, target: "draft-7" | "draft-2020-12" = "draft-7") {
  if (!isJsonSchemaInput(schema)) {
    throw new Error("expected an object schema");
  }
  const root = z.fromJSONSchema(schema, { defaultTarget: target });
  const shape = (root as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) {
    throw new Error("expected an object schema");
  }
  return shape;
}

const SCALARS: InputSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    num: { type: "number" },
    int: { type: "integer" },
    flag: { type: "boolean" },
    choice: { enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string" } },
    nums: { type: "array", items: { type: "number" } },
    either: { anyOf: [{ type: "string" }, { type: "number" }] },
    any_of: { anyOf: [{ type: "string" }, { type: "number" }] },
    one_of: { oneOf: [{ type: "string" }, { type: "boolean" }] },
    nothing: { type: "null" },
    anything: {},
    open: { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
    closed: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
  },
  additionalProperties: false,
};

describe("Tier PS — JSON Schema to Standard Schema", () => {
  it("PS1: converts every scalar form the contract names", function* () {
    const shape = shapeOf(SCALARS);
    expect(Object.keys(shape).sort()).toEqual(
      [
        "any_of",
        "anything",
        "closed",
        "choice",
        "either",
        "flag",
        "int",
        "nothing",
        "num",
        "nums",
        "one_of",
        "open",
        "tags",
        "text",
      ].sort(),
    );
    expect(shape.text.safeParse("007").success).toBe(true);
    expect(shape.num.safeParse(12).success).toBe(true);
    expect(shape.int.safeParse(1.5).success).toBe(false);
    expect(shape.flag.safeParse(false).success).toBe(true);
    expect(shape.choice.safeParse("a").success).toBe(true);
    expect(shape.choice.safeParse("c").success).toBe(false);
    expect(shape.nums.safeParse([1, 2]).success).toBe(true);
    expect(shape.nothing.safeParse(null).success).toBe(true);
    expect(shape.anything.safeParse({ deep: { x: 1 } }).success).toBe(true);
    expect(shape.any_of.safeParse("12").success).toBe(true);
    expect(shape.one_of.safeParse(true).success).toBe(true);
  });

  it("PS2: text is not coerced — a number-only property rejects its string form", function* () {
    const shape = shapeOf(SCALARS);
    expect(shape.num.safeParse("12").success).toBe(false);
    expect(shape.flag.safeParse("false").success).toBe(false);
    expect(shape.nums.safeParse(["1", "2"]).success).toBe(false);
    // Which is why transport text is decoded before validation, and why a
    // union keeps the string: both interpretations validate.
    expect(shape.either.safeParse("12")).toEqual({ success: true, data: "12" });
  });

  it("PS3: required and optional are the schema's, not Zod's", function* () {
    const schema: InputSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(() => validateProps("x", {}, schema)).toThrow(/required property 'a'/);
    expect(validateProps("x", { a: "1" }, schema)).toEqual({ a: "1" });
  });

  it("PS4: local references resolve — draft-7 uses definitions", function* () {
    const schema: InputSchema = {
      type: "object",
      properties: { user: { $ref: "#/definitions/user" } },
      definitions: {
        user: { type: "object", properties: { name: { type: "string" } } },
      },
    };
    const shape = shapeOf(schema);
    expect(shape.user.safeParse({ name: "Ada" }).success).toBe(true);
    expect(validateProps("x", { user: { name: "Ada" } }, schema)).toEqual({
      user: { name: "Ada" },
    });
  });

  it("PS5: $defs needs the 2020-12 target, while Ajv resolves either pointer", function* () {
    const schema: InputSchema = {
      type: "object",
      properties: { user: { $ref: "#/$defs/user" } },
      $defs: { user: { type: "object", properties: { name: { type: "string" } } } },
    };
    expect(() => shapeOf(schema, "draft-7")).toThrow(/Reference not found/);
    expect(shapeOf(schema, "draft-2020-12").user.safeParse({ name: "Ada" }).success).toBe(true);
    expect(validateProps("x", { user: { name: "Ada" } }, schema)).toEqual({
      user: { name: "Ada" },
    });
  });

  it("PS6: Zod would strip and default nested values, so its output is never kept", function* () {
    const schema: InputSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { name: { type: "string" }, role: { type: "string", default: "member" } },
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    };
    const shape = shapeOf(schema);
    // Zod applies the nested default...
    expect(shape.user.safeParse({ name: "Ada" })).toEqual({
      success: true,
      data: { name: "Ada", role: "member" },
    });
    // ...whereas Ajv is the layer entitled to do so.
    expect(validateProps("x", { user: { name: "Ada" } }, schema)).toEqual({
      user: { name: "Ada", role: "member" },
    });
  });

  it("PS7: a strict nested object rejects unknown keys, so the adapter loosens them for Ajv", function* () {
    const shape = shapeOf(SCALARS);
    expect(shape.closed.safeParse({ a: "x", extra: 1 }).success).toBe(false);
    expect(shape.open.safeParse({ a: "x", extra: 1 })).toEqual({
      success: true,
      data: { a: "x", extra: 1 },
    });
    expect(() => validateProps("x", { closed: { a: "y", extra: 1 } }, SCALARS)).toThrow(
      /must NOT have additional properties/,
    );
  });
});
