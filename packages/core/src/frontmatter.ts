import { parseJsonObject } from "./json.ts";
import type { InputSchema, Json, JsonObject } from "./types.ts";

export interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  inputs: InputSchema;
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const INPUT_KEYS = ["inputs", "required"];

export function parseFrontmatter(raw: unknown): ParsedFrontmatter {
  const root: JsonObject = raw === null || raw === undefined ? {} : parseJsonObject(raw);
  return { meta: parseMeta(root), inputs: parseInputSchema(root) };
}

function parseInputSchema(root: JsonObject): InputSchema {
  const declared = root["inputs"];
  const required = root["required"];

  if (declared === undefined) {
    if (required !== undefined) {
      throw new Error('frontmatter declares "required" without "inputs"');
    }
    return emptyInputSchema();
  }

  const declaration = parseJsonObject(declared);

  // `type` and `$schema` mark a full schema even when their values are
  // malformed, so a broken full schema is diagnosed as one rather than
  // read as a map of properties named `type` or `$schema`.
  if ("type" in declaration || "$schema" in declaration) {
    if (required !== undefined) {
      throw new Error(
        'frontmatter declares "required" alongside a full "inputs" schema; a full schema declares "required" inside "inputs"',
      );
    }
    const dialect = declaration["$schema"];
    if (dialect !== undefined && dialect !== DRAFT_07) {
      throw new Error(
        `inputs "$schema" must be draft-07 (${DRAFT_07}), got ${JSON.stringify(dialect)}`,
      );
    }
    return declaration;
  }

  return normalizeInputs(declaration, required);
}

function normalizeInputs(declaration: JsonObject, required: Json | undefined): InputSchema {
  const properties: JsonObject = {};
  for (const [name, definition] of Object.entries(declaration)) {
    if (!isPropertySchema(definition)) {
      throw new Error(`input "${name}" must declare a JSON Schema object or boolean`);
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
    throw new Error('frontmatter "required" must be an array of input names');
  }
  const names: string[] = [];
  for (const entry of required) {
    if (typeof entry !== "string") {
      throw new Error('frontmatter "required" must list input names as strings');
    }
    // An inputs map is closed, so a name it does not declare could never be
    // supplied and the schema would be impossible to satisfy.
    if (!(entry in properties)) {
      throw new Error(`frontmatter "required" names "${entry}", which no input declares`);
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
    if (!INPUT_KEYS.includes(key)) {
      meta[key] = value;
    }
  }
  return meta;
}

function emptyInputSchema(): InputSchema {
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
