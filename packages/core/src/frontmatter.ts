import { parseJsonObject } from "./json.ts";
import type { Json, JsonObject, PropsSchema, ReturnsSchema } from "./types.ts";

export interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  props: PropsSchema;
  returns?: ReturnsSchema;
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const RESERVED_KEYS = ["props", "required", "returns"];

export function parseFrontmatter(raw: unknown): ParsedFrontmatter {
  const root: JsonObject = raw === null || raw === undefined ? {} : parseJsonObject(raw);
  const declaredReturns = root["returns"];
  const parsed: ParsedFrontmatter = { meta: parseMeta(root), props: parsePropsSchema(root) };
  if (declaredReturns !== undefined) {
    parsed.returns = parseReturnsDeclaration(declaredReturns);
  }
  return parsed;
}

/**
 * Parse a `returns` declaration into a return schema. Markdown frontmatter
 * and a function component's `export const returns` share this, so the two
 * declaration sites cannot drift.
 *
 * The declaration is an object: either a draft-07 schema (marked by `type` or
 * `$schema`) or the concise object-return shorthand, a map of property names
 * to subschemas. Every shorthand property is required — a component that
 * returns an optional property declares the full schema instead.
 */
export function parseReturnsDeclaration(value: unknown): ReturnsSchema {
  let declaration: JsonObject;
  try {
    declaration = parseJsonObject(value);
  } catch (error) {
    throw new Error(
      `"returns" must declare a JSON Schema object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if ("type" in declaration || "$schema" in declaration) {
    const dialect = declaration["$schema"];
    if (dialect !== undefined && dialect !== DRAFT_07) {
      throw new Error(
        `returns "$schema" must be draft-07 (${DRAFT_07}), got ${JSON.stringify(dialect)}`,
      );
    }
    return declaration;
  }

  const properties: JsonObject = {};
  for (const [name, definition] of Object.entries(declaration)) {
    if (!isPropertySchema(definition)) {
      throw new Error(`returns property "${name}" must declare a JSON Schema object or boolean`);
    }
    properties[name] = definition;
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function parsePropsSchema(root: JsonObject): PropsSchema {
  const declared = root["props"];
  const required = root["required"];

  if (declared === undefined) {
    if (required !== undefined) {
      throw new Error('frontmatter declares "required" without "props"');
    }
    return emptyPropsSchema();
  }

  const declaration = parseJsonObject(declared);

  // `type` and `$schema` mark a full schema even when their values are
  // malformed, so a broken full schema is diagnosed as one rather than
  // read as a map of properties named `type` or `$schema`.
  if ("type" in declaration || "$schema" in declaration) {
    if (required !== undefined) {
      throw new Error(
        'frontmatter declares "required" alongside a full "props" schema; a full schema declares "required" inside "props"',
      );
    }
    const dialect = declaration["$schema"];
    if (dialect !== undefined && dialect !== DRAFT_07) {
      throw new Error(
        `props "$schema" must be draft-07 (${DRAFT_07}), got ${JSON.stringify(dialect)}`,
      );
    }
    return declaration;
  }

  return normalizeProps(declaration, required);
}

function normalizeProps(declaration: JsonObject, required: Json | undefined): PropsSchema {
  const properties: JsonObject = {};
  for (const [name, definition] of Object.entries(declaration)) {
    if (!isPropertySchema(definition)) {
      throw new Error(`prop "${name}" must declare a JSON Schema object or boolean`);
    }
    properties[name] = definition;
  }

  const names = parseRequiredNames(required, properties);
  if (names === undefined) {
    return { type: "object", properties, additionalProperties: false };
  }
  return { type: "object", properties, required: names, additionalProperties: false };
}

function parseRequiredNames(
  required: Json | undefined,
  properties: JsonObject,
): string[] | undefined {
  if (required === undefined) {
    return undefined;
  }
  if (!Array.isArray(required)) {
    throw new Error('frontmatter "required" must be an array of prop names');
  }
  const names: string[] = [];
  for (const entry of required) {
    if (typeof entry !== "string") {
      throw new Error('frontmatter "required" must list prop names as strings');
    }
    // A props map is closed, so a name it does not declare could never be
    // supplied and the schema would be impossible to satisfy.
    if (!(entry in properties)) {
      throw new Error(`frontmatter "required" names "${entry}", which no prop declares`);
    }
    names.push(entry);
  }
  return names;
}

function parseMeta(root: JsonObject): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const rawMeta = root["meta"];
  if (isPlainObject(rawMeta)) {
    for (const [key, value] of Object.entries(rawMeta)) {
      meta[key] = isTypedDefinition(value) ? value["default"] : value;
    }
    return meta;
  }
  for (const [key, value] of Object.entries(root)) {
    if (!RESERVED_KEYS.includes(key)) {
      meta[key] = value;
    }
  }
  return meta;
}

function emptyPropsSchema(): PropsSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}

function isPropertySchema(value: Json): boolean {
  return typeof value === "boolean" || isPlainObject(value);
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTypedDefinition(value: unknown): value is JsonObject {
  return isPlainObject(value) && "type" in value;
}
