/**
 * Frontmatter parsing for component definitions (spec §4.1, §5.1.1).
 *
 * Extracts meta values and the input schema from YAML frontmatter. `inputs`
 * is a canonical JSON Schema (draft-07) object; the root-input contract and
 * reserved-name policy are enforced in the shared schema-compilation path
 * (`validate.ts`), so Markdown and function components share them.
 */

import { parseJsonObject } from "./json.ts";
import type { InputSchema } from "./types.ts";

export interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  inputs: InputSchema;
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

/**
 * Parse raw frontmatter into meta and the input schema.
 *
 * - `inputs` key: the component's JSON Schema input interface
 * - Everything else (or a `meta` key with typed definitions): component metadata
 */
export function parseFrontmatter(raw: unknown): ParsedFrontmatter {
  const root = asRecord(raw);
  const inputs = parseInputSchema(root["inputs"]);
  const meta = parseMeta(root);
  return { meta, inputs };
}

function parseInputSchema(value: unknown): InputSchema {
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

function parseMeta(root: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  const rawMeta = root["meta"];
  if (
    rawMeta !== undefined &&
    typeof rawMeta === "object" &&
    rawMeta !== null &&
    !Array.isArray(rawMeta)
  ) {
    for (const [key, value] of Object.entries(rawMeta)) {
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

/**
 * The closed empty-object schema used when a component declares no inputs. A
 * fresh object per component so the compiled-validator cache never shares
 * state across definitions.
 */
function emptyInputSchema(): InputSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("frontmatter must be a mapping");
  }
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    record[key] = item;
  }
  return record;
}

/**
 * A typed `meta` definition object — has a `type` key. Used only to resolve
 * typed-meta defaults; unrelated to the `inputs` schema.
 */
function isTypedDefinition(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}
