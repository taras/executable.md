/**
 * Frontmatter parsing for component definitions (spec §4.1).
 *
 * Extracts meta values and input definitions from YAML frontmatter.
 * Supports shorthand syntax (value-as-default) and full JSON Schema subset.
 */

import type { InputDefinition, Json } from "./types.ts";

export interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  inputs: Record<string, InputDefinition>;
}

/**
 * Parse raw frontmatter object into meta and inputs.
 *
 * - `inputs` key: declared input interface
 * - Everything else (or `meta` key with typed definitions): component metadata
 */
export function parseFrontmatter(
  raw: Record<string, unknown>,
): ParsedFrontmatter {
  const rawInputs = (raw["inputs"] ?? {}) as Record<string, unknown>;
  const inputs: Record<string, InputDefinition> = {};

  // Reserved input names — consumed by the expansion engine, not
  // available as component inputs. See spec §6.3 (named slots).
  const RESERVED_INPUT_NAMES = new Set(["slot", "as"]);

  for (const [key, value] of Object.entries(rawInputs)) {
    if (RESERVED_INPUT_NAMES.has(key)) {
      throw new Error(
        `"${key}" is a reserved prop name and cannot be declared as a component input`,
      );
    }
    inputs[key] = normalizeInputDef(value);
  }

  // Meta: everything except 'inputs'
  // If 'meta' key exists and contains typed definitions, resolve defaults
  const meta: Record<string, unknown> = {};

  if (
    raw["meta"] &&
    typeof raw["meta"] === "object" &&
    !Array.isArray(raw["meta"])
  ) {
    for (const [key, value] of Object.entries(
      raw["meta"] as Record<string, unknown>,
    )) {
      if (isTypedDefinition(value)) {
        meta[key] = (value as { default?: unknown })["default"];
      } else {
        meta[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "inputs") {
        meta[key] = value;
      }
    }
  }

  return { meta, inputs };
}

/**
 * Convert shorthand or full definition to InputDefinition.
 */
export function normalizeInputDef(value: unknown): InputDefinition {
  // Full definition: object with a 'type' key
  if (isTypedDefinition(value)) {
    const def = value as Record<string, unknown>;
    const hasDefault = "default" in def;
    return {
      type: (def["type"] as InputDefinition["type"]) ?? "any",
      ...(hasDefault ? { default: def["default"] as Json } : {}),
      required:
        def["required"] === true || (!hasDefault && def["required"] !== false),
      ...(def["enum"] ? { enum: def["enum"] as Json[] } : {}),
      ...(def["description"]
        ? { description: def["description"] as string }
        : {}),
    };
  }

  // Shorthand: null means required with no default
  if (value === null) {
    return { type: "any", required: true };
  }

  // Shorthand: value is the default, type inferred
  return {
    type: inferType(value),
    default: value as Json,
    required: false,
  };
}

/**
 * Check if a value is a typed definition object (has a `type` key).
 */
export function isTypedDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in (value as Record<string, unknown>)
  );
}

/**
 * Infer the InputDefinition type from a JavaScript value.
 */
export function inferType(value: unknown): InputDefinition["type"] {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) return "object";
  return "any";
}
