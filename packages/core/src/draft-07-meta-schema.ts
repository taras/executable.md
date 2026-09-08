/**
 * The draft-07 meta-schema, as published.
 *
 * A response schema is admitted by validating it against this, the way the
 * compiler this replaced admitted one with `validateSchema: true`. Carrying it
 * here rather than fetching it is the only way a run's owner can admit a schema
 * at all: it resolves no references and reaches no network.
 *
 * Transcribed from <https://json-schema.org/draft-07/schema>. Its own `$id` and
 * `$schema` are kept so a schema that declares `"$schema": "…draft-07/schema#"`
 * is describing this exact document.
 */

import type { Json } from "./types.ts";

export const DRAFT_07_META_SCHEMA: Json = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "http://json-schema.org/draft-07/schema#",
  title: "Core schema meta-schema",
  definitions: {
    schemaArray: { type: "array", minItems: 1, items: { $ref: "#" } },
    nonNegativeInteger: { type: "integer", minimum: 0 },
    nonNegativeIntegerDefault0: {
      allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }],
    },
    simpleTypes: {
      enum: ["array", "boolean", "integer", "null", "number", "object", "string"],
    },
    stringArray: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      default: [],
    },
  },
  type: ["object", "boolean"],
  properties: {
    $id: { type: "string", format: "uri-reference" },
    $schema: { type: "string", format: "uri" },
    $ref: { type: "string", format: "uri-reference" },
    $comment: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    default: true,
    readOnly: { type: "boolean", default: false },
    writeOnly: { type: "boolean", default: false },
    examples: { type: "array", items: true },
    multipleOf: { type: "number", exclusiveMinimum: 0 },
    maximum: { type: "number" },
    exclusiveMaximum: { type: "number" },
    minimum: { type: "number" },
    exclusiveMinimum: { type: "number" },
    maxLength: { $ref: "#/definitions/nonNegativeInteger" },
    minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
    pattern: { type: "string", format: "regex" },
    additionalItems: { $ref: "#" },
    items: { anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }], default: true },
    maxItems: { $ref: "#/definitions/nonNegativeInteger" },
    minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
    uniqueItems: { type: "boolean", default: false },
    contains: { $ref: "#" },
    maxProperties: { $ref: "#/definitions/nonNegativeInteger" },
    minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
    required: { $ref: "#/definitions/stringArray" },
    additionalProperties: { $ref: "#" },
    definitions: { type: "object", additionalProperties: { $ref: "#" }, default: {} },
    properties: { type: "object", additionalProperties: { $ref: "#" }, default: {} },
    patternProperties: {
      type: "object",
      additionalProperties: { $ref: "#" },
      propertyNames: { format: "regex" },
      default: {},
    },
    dependencies: {
      type: "object",
      additionalProperties: {
        anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }],
      },
    },
    propertyNames: { $ref: "#" },
    const: true,
    enum: { type: "array", items: true },
    type: {
      anyOf: [
        { $ref: "#/definitions/simpleTypes" },
        {
          type: "array",
          items: { $ref: "#/definitions/simpleTypes" },
          minItems: 1,
          uniqueItems: true,
        },
      ],
    },
    format: { type: "string" },
    contentMediaType: { type: "string" },
    contentEncoding: { type: "string" },
    if: { $ref: "#" },
    // deno-lint-ignore no-thenable
    then: { $ref: "#" },
    else: { $ref: "#" },
    allOf: { $ref: "#/definitions/schemaArray" },
    anyOf: { $ref: "#/definitions/schemaArray" },
    oneOf: { $ref: "#/definitions/schemaArray" },
    not: { $ref: "#" },
  },
  default: true,
};
