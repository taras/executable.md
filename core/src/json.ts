/**
 * Shared `unknown → JSON` parsing (spec §5.1.1, §6.5).
 *
 * Frontmatter parsing, function-component loading, and Ajv error normalization
 * all need to narrow an `unknown` value to `Json` before handing it to Ajv or
 * storing it on a segment. Parsing (not casting) satisfies Code Rule 6 and
 * guarantees the value is genuinely serializable — Ajv and durable streams both
 * assume that.
 */

import type { Json, JsonObject } from "./types.ts";

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

/**
 * Narrow an `unknown` value to `Json`, rejecting anything a JSON document
 * cannot hold: `undefined`, functions, symbols, bigints, non-finite numbers,
 * cycles, and non-plain objects (class instances, `Map`, `Date`, arrays with
 * holes carrying `undefined`, etc.).
 */
export function parseJson(value: unknown): Json {
  return parseValue(value, new Set(), "$");
}

/**
 * Narrow an `unknown` value to a plain JSON object. Used for the root `inputs`
 * schema and for a function component's `inputs` export — never for a whole
 * module namespace, which carries the default generator function.
 */
export function parseJsonObject(value: unknown): JsonObject {
  const parsed = parseJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JsonParseError(`expected a JSON object, got ${describe(value)}`);
  }
  return parsed;
}

function parseValue(value: unknown, seen: Set<object>, path: string): Json {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonParseError(`non-finite number at ${path}`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new JsonParseError(`non-JSON ${typeof value} at ${path}`);
  }

  if (seen.has(value)) {
    throw new JsonParseError(`circular reference at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => parseValue(item, seen, `${path}[${index}]`));
    }
    if (!isPlainObject(value)) {
      throw new JsonParseError(`non-plain object at ${path}`);
    }
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new JsonParseError(`undefined value at ${path}.${key}`);
      }
      result[key] = parseValue(item, seen, `${path}.${key}`);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
