import type { Json, JsonObject } from "./types.ts";

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

export function parseJson(value: unknown): Json {
  return parseValue(value, new Set(), "$");
}

// Never called on a whole module namespace — that carries the default
// generator function, which is not JSON. Only the `inputs` export/value.
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
      // Parse every index rather than `.map`, which skips sparse holes and
      // would admit an unsound `Json[]`. A hole is rejected like `undefined`.
      const result: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) {
          throw new JsonParseError(`missing array element at ${path}[${index}]`);
        }
        result.push(parseValue(value[index], seen, `${path}[${index}]`));
      }
      return result;
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
