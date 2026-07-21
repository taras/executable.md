import { parseJsonObject } from "./json.ts";
import type { InputSchema, Json, JsonObject } from "./types.ts";

export interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  inputs: InputSchema;
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

export function parseFrontmatter(raw: unknown): ParsedFrontmatter {
  const root: JsonObject = raw === null || raw === undefined ? {} : parseJsonObject(raw);
  return { meta: parseMeta(root), inputs: parseInputSchema(root["inputs"]) };
}

function parseInputSchema(value: Json | undefined): InputSchema {
  if (value === undefined) {
    return emptyInputSchema();
  }
  const schema = parseJsonObject(value);
  const dialect = schema["$schema"];
  if (dialect !== undefined && dialect !== DRAFT_07) {
    throw new Error(
      `inputs "$schema" must be draft-07 (${DRAFT_07}), got ${JSON.stringify(dialect)}`,
    );
  }
  return schema;
}

function parseMeta(root: JsonObject): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const rawMeta = root["meta"];
  if (isPlainObject(rawMeta)) {
    for (const [key, value] of Object.entries(rawMeta)) {
      // A typed meta definition resolves to its `default` value.
      meta[key] = isTypedDefinition(value) ? value["default"] : value;
    }
    return meta;
  }
  for (const [key, value] of Object.entries(root)) {
    if (key !== "inputs") {
      meta[key] = value;
    }
  }
  return meta;
}

function emptyInputSchema(): InputSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTypedDefinition(value: unknown): value is JsonObject {
  return isPlainObject(value) && "type" in value;
}
